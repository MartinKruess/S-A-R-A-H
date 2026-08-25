// src/services/voice/voice-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { SttProvider } from './stt-provider.interface.js';
import type { TtsProvider } from './tts-provider.interface.js';
import type { WakeWordProvider } from './wake-word-provider.interface.js';
import type { AudioManager } from './audio-manager.js';
import type { HotkeyManager } from './hotkey-manager.js';
import { CHAT_UNAVAILABLE_MESSAGE, isChatAvailable } from '../../core/chat-availability.js';
import { SentenceBuffer } from './sentence-buffer.js';
import { TtsQueue } from './tts-queue.js';
import { throwIfAborted } from '../../core/abort-utils.js';
import {
  type VoiceState,
  type VoiceMode,
  type InteractionMode,
  SILENCE_TIMEOUT_MS,
  CONVERSATION_WINDOW_MS,
  DEFAULT_PTT_KEY,
  isAbortPhrase,
} from './voice-types.js';

/** RMS threshold below which audio is considered silence */
const SILENCE_RMS_THRESHOLD = 0.01;

/** Default sample rate for STT */
const SAMPLE_RATE = 16_000;

export class VoiceService implements SarahService {
  readonly id = 'voice';
  readonly subscriptions = ['llm:chunk', 'llm:done', 'llm:error', 'llm:filler'] as const;
  status: ServiceStatus = 'pending';

  private voiceMode: VoiceMode = 'off';
  private interactionMode: InteractionMode = 'voice';
  private _voiceState: VoiceState = 'idle';
  private pushToTalkKey = DEFAULT_PTT_KEY;

  private transitioning = false;
  private conversationActive = false;
  private conversationTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private sentenceBuffer = new SentenceBuffer();
  private ttsQueue: TtsQueue | null = null;
  private llmStreaming = false;
  private playbackUnsub: (() => void) | null = null;

  /** Sentences deferred while the mic is open (F9) — flushed when listening ends. */
  private deferredSentences: string[] = [];

  constructor(
    private context: AppContext,
    private stt: SttProvider,
    private tts: TtsProvider,
    private wakeWord: WakeWordProvider,
    private audio: AudioManager,
    private hotkey: HotkeyManager,
  ) {}

  get voiceState(): VoiceState {
    return this._voiceState;
  }

  setInteractionMode(mode: InteractionMode): void {
    this.interactionMode = mode;
  }

  /** Enable one-shot TTS for a typed message, but only when in voice mode */
  setChatSpeak(): void {
    if (this.interactionMode === 'voice') {
      this.interactionMode = 'chatspeak';
    }
  }

  private setState(state: VoiceState): void {
    const wasListening = this._voiceState === 'listening';
    this._voiceState = state;
    this.context.bus.emit(this.id, 'voice:state', { state });
    if (wasListening && state !== 'listening' && this.deferredSentences.length > 0) {
      for (const sentence of this.deferredSentences) {
        this.ttsQueue?.enqueue(sentence);
      }
      this.deferredSentences = [];
    }
  }

  /** Never play TTS into an open recording — defer until listening ends (F9). */
  private enqueueOrDefer(sentence: string): void {
    if (this._voiceState === 'listening') {
      this.deferredSentences.push(sentence);
      return;
    }
    this.ttsQueue?.enqueue(sentence);
  }

  private async transition(fn: () => Promise<void>): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    try {
      await fn();
    } finally {
      this.transitioning = false;
    }
  }

  private capabilities = { stt: false, tts: false };
  private initPromise: Promise<void> | null = null;

  get capabilitySnapshot(): Readonly<{ stt: boolean; tts: boolean }> {
    return { ...this.capabilities };
  }

  init(signal?: AbortSignal): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit(signal);
    return this.initPromise;
  }

  private async doInit(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const { controls } = this.context.parsedConfig;
    const rawMode = controls.voiceMode;
    // keyword mode is non-functional — treat as off
    this.voiceMode = rawMode === 'keyword' ? 'off' : rawMode;
    this.pushToTalkKey = controls.pushToTalkKey;

    // STT and TTS are independent capabilities (A5): one failing must not
    // silently kill the other — degrade instead of dying.
    try {
      await this.stt.init(signal);
      this.capabilities.stt = true;
      this.context.lifecycle?.setCapability('stt', 'ready');
    } catch (err) {
      await this.cleanupFailedProvider('STT', () => this.stt.destroy());
      throwIfAborted(signal);
      console.error('[VoiceService] STT init failed:', err);
      this.context.lifecycle?.setCapability(
        'stt',
        'unavailable',
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      await this.tts.init(signal);
      this.capabilities.tts = true;
      this.context.lifecycle?.setCapability('tts', 'ready');
    } catch (err) {
      await this.cleanupFailedProvider('TTS', () => this.tts.destroy());
      throwIfAborted(signal);
      console.error('[VoiceService] TTS init failed:', err);
      this.context.lifecycle?.setCapability(
        'tts',
        'unavailable',
        err instanceof Error ? err.message : String(err),
      );
    }

    throwIfAborted(signal);
    this.setupMode();

    if (this.capabilities.tts) {
      this.ttsQueue = new TtsQueue(
        this.tts,
        (audio, sampleRate) => {
          this.audio.setPlaying(true);
          this.context.bus.emit(this.id, 'voice:play-audio', {
            audio: Array.from(audio),
            sampleRate,
          });
        },
        () => { this.onTtsQueueEmpty(); },
        (err) => {
          console.error('[VoiceService] TTS error:', err);
          this.context.bus.emit(this.id, 'voice:error', { message: err.message });
        },
        (ms) => {
          this.context.bus.emit(this.id, 'perf:timing', { label: 'tts', ms });
        },
      );

      this.playbackUnsub = this.context.bus.on('voice:playback-done', () => {
        this.audio.setPlaying(false);
        this.ttsQueue?.playbackDone();
      });
    }

    this.context.bus.emit(this.id, 'voice:capability', { ...this.capabilities });
    this.status = this.capabilities.stt || this.capabilities.tts ? 'running' : 'error';
  }

  async destroy(signal?: AbortSignal): Promise<void> {
    const syncFailures: unknown[] = [];
    const attempt = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (value) {
        syncFailures.push(value);
      }
    };

    attempt(() => this.playbackUnsub?.());
    this.playbackUnsub = null;
    attempt(() => this.ttsQueue?.stop());
    this.ttsQueue = null;
    this.sentenceBuffer.reset();
    this.llmStreaming = false;
    this.deferredSentences = [];

    this.transitioning = false;
    this.clearConversationTimer();
    this.clearSilenceTimer();
    attempt(() => this.hotkey.destroy());
    attempt(() => this.wakeWord.stop());

    if (this.audio.isRecording) {
      attempt(() => { this.audio.stopRecording(); });
    }

    const cleanupResults = await Promise.allSettled([
      Promise.resolve().then(() => this.stt.destroy(signal)),
      Promise.resolve().then(() => this.tts.destroy(signal)),
      Promise.resolve().then(() => this.wakeWord.destroy(signal)),
      Promise.resolve().then(() => this.audio.destroy()),
    ]);

    this.setState('idle');
    this.conversationActive = false;
    this.status = 'stopped';
    const failures = cleanupResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (syncFailures.length > 0 || failures.length > 0) {
      throw new AggregateError(
        [...syncFailures, ...failures.map((failure) => failure.reason)],
        'Voice provider cleanup failed',
      );
    }
  }

  private async cleanupFailedProvider(label: string, cleanup: () => Promise<void>): Promise<void> {
    try {
      await cleanup();
    } catch (error) {
      console.warn(`[VoiceService] ${label} partial-init cleanup failed:`, error);
    }
  }

  /** Feed an audio chunk from the renderer. Called by IPC handler. */
  feedAudioChunk(chunk: Float32Array): void {
    this.audio.feedChunk(chunk);
  }

  onMessage(msg: TypedBusMessage): void {
    if (msg.topic === 'llm:filler') {
      // A bridging phrase spoken over a model-swap pause. It is not turn content,
      // so it bypasses the sentence buffer and the turn-state machine entirely and
      // never touches _voiceState. No-op when TTS is unavailable.
      this.ttsQueue?.enqueue(msg.data.text);
      return;
    }

    const shouldSpeak = this.voiceMode !== 'off' && this.interactionMode !== 'chat';

    if (msg.topic === 'llm:chunk') {
      if (!shouldSpeak) return;
      const { text } = msg.data;
      if (!text) return;

      const sentences = this.sentenceBuffer.push(text);
      for (const sentence of sentences) {
        if (this._voiceState === 'processing') {
          this.setState('speaking');
          this.context.bus.emit(this.id, 'voice:speaking', { text: sentence });
          this.llmStreaming = true;
        }
        this.enqueueOrDefer(sentence);
      }
    } else if (msg.topic === 'llm:done') {
      if (!shouldSpeak) return;
      const remainder = this.sentenceBuffer.flush();
      if (remainder) {
        if (this._voiceState === 'processing') {
          this.setState('speaking');
          this.context.bus.emit(this.id, 'voice:speaking', { text: remainder });
        }
        this.enqueueOrDefer(remainder);
      }
      this.llmStreaming = false;
      // If queue is already empty (e.g., very short response already played), trigger completion
      if (!this.ttsQueue?.isActive && this._voiceState === 'speaking') {
        this.onTtsQueueEmpty();
      }
    } else if (msg.topic === 'llm:error') {
      if (this.llmStreaming) {
        // Already speaking — flush what we have and let queue finish
        const remainder = this.sentenceBuffer.flush();
        if (remainder) {
          this.enqueueOrDefer(remainder);
        }
        this.llmStreaming = false;
      } else if (this._voiceState === 'processing') {
        this.setState('idle');
        this.context.bus.emit(this.id, 'voice:error', {
          message: msg.data.message ?? 'LLM request failed',
        });
      }
    }
  }

  private onTtsQueueEmpty(): void {
    if (this.llmStreaming) {
      // LLM still producing — stay in speaking state, queue will resume
      return;
    }
    if (this._voiceState !== 'speaking') {
      // The queue can also drain because deferred sentences from a finished
      // turn were flushed (F9) while a NEW turn is already in flight
      // (state 'listening'/'processing') or has already reset (state
      // 'idle'). That is not "the current turn is done" — only a turn that
      // actually reached 'speaking' may be completed here. The new turn's
      // own llm:chunk will move state to 'speaking' and re-arm this check.
      return;
    }
    // All done
    this.context.bus.emit(this.id, 'voice:done', {});

    if (this.interactionMode === 'chatspeak') {
      this.interactionMode = 'voice';
    }

    if (this.voiceMode === 'keyword' && this.conversationActive) {
      this.startListening();
    } else {
      this.setState('idle');
    }
  }

  async applyConfig(): Promise<void> {
    this.transitioning = false;
    // Tear down current mode
    this.hotkey.unregister();
    this.wakeWord.stop();
    if (this.audio.isRecording) {
      this.audio.stopRecording();
    }
    this.clearSilenceTimer();
    this.clearConversationTimer();
    this.conversationActive = false;
    this.setState('idle');

    // Re-read config from storage and re-parse
    const raw = (await this.context.config.get<Record<string, unknown>>('root')) ?? {};
    const { SarahConfigSchema } = await import('../../core/config-schema.js');
    const parsed = SarahConfigSchema.parse(raw);
    this.context.parsedConfig = parsed;
    const { controls } = parsed;
    const rawMode = controls.voiceMode;
    this.voiceMode = rawMode === 'keyword' ? 'off' : rawMode;
    this.pushToTalkKey = controls.pushToTalkKey;

    // Set up new mode
    this.setupMode();
  }

  private setupMode(): void {
    if (this.voiceMode === 'push-to-talk') {
      this.hotkey.register(
        this.pushToTalkKey,
        () => { this.onPttDown(); },
        () => { this.onPttUp(); },
      );
    } else if (this.voiceMode === 'keyword') {
      this.startWakeWordListening();
    }
  }

  private startWakeWordListening(): void {
    this.wakeWord.start(() => { this.onWakeWordDetected(); });
  }

  // --- PTT handlers ---

  onPttDown(): void {
    if (this._voiceState === 'speaking') {
      this.interrupt();
      this.transitioning = false;
      if (!this.canAcceptConversation()) {
        this.rejectUnavailableConversation();
        return;
      }
      this.startListening();
      return;
    }
    if (this.transitioning) return;
    if (!this.canAcceptConversation()) {
      this.rejectUnavailableConversation();
      return;
    }
    this.startListening();
  }

  onPttUp(): void {
    if (this._voiceState !== 'listening') return;
    this.transition(() => this.stopListeningAndProcess()).catch(() => {
      this.context.bus.emit(this.id, 'voice:error', { message: 'Processing failed' });
    });
  }

  // --- Wake-word handler ---

  private onWakeWordDetected(): void {
    this.context.bus.emit(this.id, 'voice:wake', {});

    if (this._voiceState === 'speaking') {
      this.interrupt();
    }

    if (!this.canAcceptConversation()) {
      this.rejectUnavailableConversation();
      return;
    }

    this.wakeWord.stop();
    this.conversationActive = true;
    this.resetConversationTimer();
    this.startListening();
  }

  // --- Core state transitions ---

  private startListening(): void {
    this.setState('listening');
    this.context.bus.emit(this.id, 'voice:listening', {});

    if (this.voiceMode === 'keyword') {
      this.clearSilenceTimer();
      this.audio.startRecording((chunk: Float32Array) => {
        this.checkSilence(chunk);
      });
    } else {
      this.audio.startRecording();
    }
  }

  private async stopListeningAndProcess(): Promise<void> {
    this.clearSilenceTimer();

    const audioData = this.audio.stopRecording();
    if (audioData.length === 0) {
      this.setState('idle');
      return;
    }

    this.setState('processing');

    const sttLanguage = this.context.parsedConfig.personalization.responseLanguage ?? 'de';
    const sttStart = performance.now();
    const transcript = await this.stt.transcribe(audioData, SAMPLE_RATE, sttLanguage);
    this.context.bus.emit(this.id, 'perf:timing', {
      label: 'whisper',
      ms: Math.round(performance.now() - sttStart),
      meta: { transcriptLength: transcript?.length ?? 0 },
    });

    if (!transcript || transcript.trim().length === 0) {
      this.handleEmptyTranscript();
      return;
    }

    this.context.bus.emit(this.id, 'voice:transcript', { text: transcript });

    if (!this.canAcceptConversation()) {
      this.context.bus.emit(this.id, 'llm:error', { message: CHAT_UNAVAILABLE_MESSAGE });
      return;
    }

    if (isAbortPhrase(transcript)) {
      this.endConversation();
      return;
    }

    // Reset conversation timer on successful interaction (keyword mode)
    if (this.voiceMode === 'keyword' && this.conversationActive) {
      this.resetConversationTimer();
    }

    // Emit chat message for LLM processing
    this.context.bus.emit(this.id, 'chat:message', { text: transcript, mode: 'voice' });
  }

  private canAcceptConversation(): boolean {
    return this.context.lifecycle ? isChatAvailable(this.context.lifecycle.snapshot) : true;
  }

  private rejectUnavailableConversation(): void {
    this.setState('idle');
    this.context.bus.emit(this.id, 'llm:error', { message: CHAT_UNAVAILABLE_MESSAGE });
  }

  private interrupt(): void {
    this.ttsQueue?.stop();
    this.sentenceBuffer.reset();
    this.llmStreaming = false;
    this.tts.stop();
    this.audio.setPlaying(false);
    this.context.bus.emit(this.id, 'voice:interrupted', {});
  }

  // --- VAD (Voice Activity Detection) ---

  private checkSilence(chunk: Float32Array): void {
    const rms = this.computeRms(chunk);

    if (rms < SILENCE_RMS_THRESHOLD) {
      if (!this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.silenceTimer = null;
          this.stopListeningAndProcess().catch(() => {
            this.context.bus.emit(this.id, 'voice:error', { message: 'Processing failed' });
          });
        }, SILENCE_TIMEOUT_MS);
      }
    } else {
      this.clearSilenceTimer();
    }
  }

  private computeRms(chunk: Float32Array): number {
    if (chunk.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) {
      sum += chunk[i] * chunk[i];
    }
    return Math.sqrt(sum / chunk.length);
  }

  // --- Conversation window ---

  private resetConversationTimer(): void {
    this.clearConversationTimer();
    this.conversationTimer = setTimeout(() => {
      this.endConversation();
    }, CONVERSATION_WINDOW_MS);
  }

  private endConversation(): void {
    this.clearConversationTimer();
    this.clearSilenceTimer();
    this.conversationActive = false;

    if (this.audio.isRecording) {
      this.audio.stopRecording();
    }

    this.setState('idle');

    // Restart wake-word listening
    if (this.voiceMode === 'keyword') {
      this.startWakeWordListening();
    }
  }

  private handleEmptyTranscript(): void {
    this.clearSilenceTimer();
    this.clearConversationTimer();
    this.setState('idle');
  }

  // --- Timer helpers ---

  private clearConversationTimer(): void {
    if (this.conversationTimer) {
      clearTimeout(this.conversationTimer);
      this.conversationTimer = null;
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
