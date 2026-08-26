// src/services/voice/voice-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { SttProvider } from './stt-provider.interface.js';
import type { TtsProvider } from './tts-provider.interface.js';
import type { WakeWordProvider } from './wake-word-provider.interface.js';
import type { AudioManager } from './audio-manager.js';
import type { HotkeyManager } from './hotkey-manager.js';
import {
  CHAT_UNAVAILABLE_MESSAGE,
  STT_UNAVAILABLE_MESSAGE,
  isChatAvailable,
} from '../../core/chat-availability.js';
import { SentenceBuffer } from './sentence-buffer.js';
import { TtsQueue, type TtsQueueItem } from './tts-queue.js';
import { runWithTimeout, throwIfAborted } from '../../core/abort-utils.js';
import { randomUUID } from 'crypto';
import type { OutputId, TurnId, VoiceCaptureId } from '../../core/turn-contract.js';
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
const STT_TIMEOUT_MS = 60_000;

export class VoiceService implements SarahService {
  readonly id = 'voice';
  readonly subscriptions = ['llm:chunk', 'llm:done', 'llm:error', 'llm:filler', 'turn:terminal'] as const;
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
  private activeTurnId: TurnId | null = null;
  private activeOutputId: OutputId | null = null;
  private activeOutputSequence = 0;
  private activeCaptureId: VoiceCaptureId | null = null;
  private sttAbort: AbortController | null = null;

  /** Sentences deferred while the mic is open (F9) — flushed when listening ends. */
  private deferredSentences: TtsQueueItem[] = [];

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
    this.context.bus.emit(this.id, 'voice:state', {
      state,
      ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
      ...(this.activeCaptureId ? { captureId: this.activeCaptureId } : {}),
    });
    if (wasListening && state !== 'listening' && this.deferredSentences.length > 0) {
      for (const item of this.deferredSentences) {
        this.ttsQueue?.enqueue(item);
      }
      this.deferredSentences = [];
    }
  }

  /** Never play TTS into an open recording — defer until listening ends (F9). */
  private enqueueOrDefer(item: TtsQueueItem): void {
    if (this._voiceState === 'listening') {
      this.deferredSentences.push(item);
      return;
    }
    this.ttsQueue?.enqueue(item);
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
        (item, playbackId, audio, sampleRate) => {
          this.audio.setPlaying(true);
          this.context.bus.emit(this.id, 'voice:play-audio', {
            turnId: item.turnId,
            outputId: item.outputId,
            playbackId,
            audio: Array.from(audio),
            sampleRate,
          });
        },
        () => { this.onTtsQueueEmpty(); },
        (err) => {
          console.error('[VoiceService] TTS error:', err);
          this.context.bus.emit(this.id, 'voice:error', { message: err.message });
        },
        (ms, turnId) => {
          this.context.bus.emit(this.id, 'perf:timing', { turnId, label: 'tts', ms });
        },
      );

      this.playbackUnsub = this.context.bus.on('voice:playback-done', (msg) => {
        this.audio.setPlaying(false);
        this.ttsQueue?.playbackDone(msg.data.turnId, msg.data.playbackId);
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
    this.sttAbort?.abort();
    this.sttAbort = null;
    this.activeTurnId = null;
    this.activeOutputId = null;
    this.activeOutputSequence = 0;
    this.activeCaptureId = null;

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
  feedAudioChunk(captureId: VoiceCaptureId, chunk: Float32Array): void {
    const result = this.audio.feedChunk(captureId, chunk);
    if (result === 'limit' && this._voiceState === 'listening') {
      void this.transition(() => this.stopListeningAndProcess()).catch(() => {
        this.context.bus.emit(this.id, 'voice:error', {
          ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
          message: 'Die Aufnahme war zu lang und konnte nicht verarbeitet werden.',
        });
      });
    }
  }

  onMessage(msg: TypedBusMessage): void {
    if (msg.topic === 'llm:filler') {
      // A bridging phrase spoken over a model-swap pause. It is not turn content,
      // so it bypasses the sentence buffer and the turn-state machine entirely and
      // never touches _voiceState. No-op when TTS is unavailable.
      this.ttsQueue?.enqueue({
        turnId: msg.data.turnId || this.activeTurnId || randomUUID(),
        outputId: randomUUID(),
        text: msg.data.text,
      });
      return;
    }

    if (msg.topic === 'turn:terminal') {
      if (msg.data.status === 'canceled' && msg.data.turnId === this.activeTurnId) {
        this.ttsQueue?.stop();
        this.sentenceBuffer.reset();
        this.llmStreaming = false;
        this.setState('idle');
      }
      return;
    }

    const shouldSpeak = this.voiceMode !== 'off' && this.interactionMode !== 'chat';

    if (msg.topic === 'llm:chunk') {
      if (!shouldSpeak) return;
      const turnId = msg.data.turnId || this.activeTurnId || randomUUID();
      const outputId = msg.data.outputId || this.activeOutputId || randomUUID();
      const { text } = msg.data;
      if (!text) return;
      if (this.activeOutputId && this.activeOutputId !== outputId) {
        this.sentenceBuffer.reset();
        this.activeOutputSequence = 0;
      }
      if (typeof msg.data.sequence === 'number' && msg.data.sequence !== this.activeOutputSequence) return;
      this.activeTurnId = turnId;
      this.activeOutputId = outputId;
      this.activeOutputSequence += 1;

      const sentences = this.sentenceBuffer.push(text);
      for (const sentence of sentences) {
        if (this._voiceState === 'processing') {
          this.setState('speaking');
          this.context.bus.emit(this.id, 'voice:speaking', { turnId, outputId, text: sentence });
          this.llmStreaming = true;
        }
        this.enqueueOrDefer({ turnId, outputId, text: sentence });
      }
    } else if (msg.topic === 'llm:done') {
      if (!shouldSpeak) return;
      const turnId = msg.data.turnId || this.activeTurnId || randomUUID();
      const outputId = msg.data.outputId || this.activeOutputId || randomUUID();
      if (this.activeOutputId && this.activeOutputId !== outputId) return;
      if (typeof msg.data.sequence === 'number' && msg.data.sequence !== this.activeOutputSequence) return;
      this.activeTurnId = turnId;
      this.activeOutputId = outputId;
      const remainder = this.sentenceBuffer.flush();
      if (remainder) {
        if (this._voiceState === 'processing') {
          this.setState('speaking');
          this.context.bus.emit(this.id, 'voice:speaking', { turnId, outputId, text: remainder });
        }
        this.enqueueOrDefer({ turnId, outputId, text: remainder });
      }
      this.llmStreaming = false;
      // If queue is already empty (e.g., very short response already played), trigger completion
      if (!this.ttsQueue?.isActive && this._voiceState === 'speaking') {
        this.onTtsQueueEmpty();
      }
    } else if (msg.topic === 'llm:error') {
      if (this.activeTurnId && msg.data.turnId && msg.data.turnId !== this.activeTurnId) return;
      if (this.llmStreaming) {
        // Already speaking — flush what we have and let queue finish
        const remainder = this.sentenceBuffer.flush();
        if (remainder && this.activeTurnId && this.activeOutputId) {
          this.enqueueOrDefer({
            turnId: this.activeTurnId,
            outputId: this.activeOutputId,
            text: remainder,
          });
        }
        this.llmStreaming = false;
      } else if (this._voiceState === 'processing') {
        this.setState('idle');
        this.context.bus.emit(this.id, 'voice:error', {
          turnId: msg.data.turnId,
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
    if (!this.activeTurnId) return;
    this.context.bus.emit(this.id, 'voice:done', { turnId: this.activeTurnId });

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
    if (this._voiceState === 'speaking' || this._voiceState === 'processing') {
      this.interrupt();
      this.transitioning = false;
      if (!this.canAcceptConversation()) {
        this.rejectUnavailableConversation();
        return;
      }
      if (!this.capabilities.stt) {
        this.rejectUnavailableVoiceInput();
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
    if (!this.capabilities.stt) {
      this.rejectUnavailableVoiceInput();
      return;
    }
    this.startListening();
  }

  onPttUp(): void {
    if (this._voiceState !== 'listening') return;
    this.transition(() => this.stopListeningAndProcess()).catch((error) => {
      this.handleProcessingError(error);
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

    if (!this.capabilities.stt) {
      this.rejectUnavailableVoiceInput();
      return;
    }

    this.wakeWord.stop();
    this.conversationActive = true;
    this.resetConversationTimer();
    this.startListening();
  }

  // --- Core state transitions ---

  private startListening(): void {
    this.activeTurnId = randomUUID();
    this.activeCaptureId = randomUUID();
    this.activeOutputId = null;
    this.activeOutputSequence = 0;
    this.sttAbort?.abort();
    this.sttAbort = new AbortController();
    this.setState('listening');
    this.context.bus.emit(this.id, 'voice:listening', {
      turnId: this.activeTurnId,
      captureId: this.activeCaptureId,
    });

    if (this.voiceMode === 'keyword') {
      this.clearSilenceTimer();
      this.audio.startRecording(this.activeCaptureId, (chunk: Float32Array) => {
        this.checkSilence(chunk);
      });
    } else {
      this.audio.startRecording(this.activeCaptureId);
    }
  }

  private async stopListeningAndProcess(): Promise<void> {
    this.clearSilenceTimer();

    const audioData = this.audio.stopRecording(this.activeCaptureId ?? undefined);
    const turnId = this.activeTurnId;
    const captureId = this.activeCaptureId;
    const sttSignal = this.sttAbort?.signal;
    if (!turnId || !captureId || !sttSignal) {
      this.setState('idle');
      return;
    }
    if (audioData.length === 0) {
      this.setState('idle');
      if (turnId) this.context.bus.emit(this.id, 'turn:terminal', { turnId, status: 'canceled' });
      return;
    }

    this.setState('processing');

    const sttLanguage = this.context.parsedConfig.personalization.responseLanguage ?? 'de';
    const sttStart = performance.now();
    const transcript = await runWithTimeout(
      (signal) => this.stt.transcribe(audioData, SAMPLE_RATE, sttLanguage, signal),
      STT_TIMEOUT_MS,
      'Speech recognition timed out',
      sttSignal,
    );
    this.context.bus.emit(this.id, 'perf:timing', {
      turnId,
      label: 'whisper',
      ms: Math.round(performance.now() - sttStart),
      meta: { transcriptLength: transcript?.length ?? 0 },
    });

    if (!transcript || transcript.trim().length === 0) {
      this.handleEmptyTranscript();
      return;
    }

    this.context.bus.emit(this.id, 'voice:transcript', { turnId, captureId, text: transcript });

    if (!this.canAcceptConversation()) {
      this.context.bus.emit(this.id, 'llm:error', { turnId, message: CHAT_UNAVAILABLE_MESSAGE });
      this.context.bus.emit(this.id, 'turn:terminal', {
        turnId,
        status: 'error',
        message: CHAT_UNAVAILABLE_MESSAGE,
      });
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
    this.context.bus.emit(this.id, 'chat:message', {
      turnId,
      captureId,
      source: 'voice',
      mode: 'voice',
      originalText: transcript,
      createdAt: new Date().toISOString(),
    });
  }

  private canAcceptConversation(): boolean {
    return this.context.lifecycle ? isChatAvailable(this.context.lifecycle.snapshot) : true;
  }

  private rejectUnavailableConversation(): void {
    this.setState('idle');
    const turnId = this.activeTurnId ?? randomUUID();
    this.context.bus.emit(this.id, 'llm:error', { turnId, message: CHAT_UNAVAILABLE_MESSAGE });
    this.context.bus.emit(this.id, 'turn:terminal', {
      turnId,
      status: 'error',
      message: CHAT_UNAVAILABLE_MESSAGE,
    });
  }

  private rejectUnavailableVoiceInput(): void {
    const turnId = this.activeTurnId ?? randomUUID();
    this.setState('idle');
    this.context.bus.emit(this.id, 'voice:error', { turnId, message: STT_UNAVAILABLE_MESSAGE });
    if (this.capabilities.tts && this.interactionMode !== 'chat') {
      this.ttsQueue?.enqueue({
        turnId,
        outputId: randomUUID(),
        text: STT_UNAVAILABLE_MESSAGE,
      });
    }
  }

  private interrupt(): void {
    const turnId = this.activeTurnId;
    this.sttAbort?.abort();
    this.ttsQueue?.stop();
    this.sentenceBuffer.reset();
    this.llmStreaming = false;
    this.activeOutputId = null;
    this.activeOutputSequence = 0;
    this.tts.stop();
    this.audio.setPlaying(false);
    if (turnId) {
      this.context.bus.emit(this.id, 'turn:cancel', { turnId, reason: 'Voice interruption' });
      this.context.bus.emit(this.id, 'voice:interrupted', { turnId });
    }
  }

  // --- VAD (Voice Activity Detection) ---

  private checkSilence(chunk: Float32Array): void {
    const rms = this.computeRms(chunk);

    if (rms < SILENCE_RMS_THRESHOLD) {
      if (!this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.silenceTimer = null;
          this.stopListeningAndProcess().catch((error) => {
            this.handleProcessingError(error);
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
    if (this.activeTurnId) {
      this.context.bus.emit(this.id, 'turn:terminal', {
        turnId: this.activeTurnId,
        status: 'canceled',
      });
    }
  }

  private handleProcessingError(value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value));
    if (error.name === 'AbortError') return;
    const turnId = this.activeTurnId;
    const message = error.name === 'TimeoutError'
      ? 'Die Spracherkennung hat zu lange gebraucht. Bitte versuche es erneut.'
      : 'Die Spracheingabe konnte nicht verarbeitet werden.';
    this.setState('idle');
    this.context.bus.emit(this.id, 'voice:error', {
      ...(turnId ? { turnId } : {}),
      message,
    });
    if (turnId) {
      this.context.bus.emit(this.id, 'turn:terminal', { turnId, status: 'error', message });
    }
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
