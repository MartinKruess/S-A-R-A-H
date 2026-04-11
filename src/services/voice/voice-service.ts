// src/services/voice/voice-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { SttProvider } from './stt-provider.interface.js';
import type { TtsProvider } from './tts-provider.interface.js';
import type { WakeWordProvider } from './wake-word-provider.interface.js';
import type { AudioManager } from './audio-manager.js';
import type { HotkeyManager } from './hotkey-manager.js';
import { SentenceBuffer } from './sentence-buffer.js';
import { TtsQueue } from './tts-queue.js';
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
  readonly subscriptions = ['llm:chunk', 'llm:done', 'llm:error'] as const;
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

  private setState(state: VoiceState): void {
    this._voiceState = state;
    this.context.bus.emit(this.id, 'voice:state', { state });
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

  async init(): Promise<void> {
    try {
      const { controls } = this.context.parsedConfig;
      const rawMode = controls.voiceMode;
      // keyword mode is non-functional — treat as off
      this.voiceMode = rawMode === 'keyword' ? 'off' : rawMode;
      this.pushToTalkKey = controls.pushToTalkKey;

      await this.stt.init();
      await this.tts.init();

      this.setupMode();

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
      );

      this.playbackUnsub = this.context.bus.on('voice:playback-done', () => {
        this.audio.setPlaying(false);
        this.ttsQueue?.playbackDone();
      });

      this.status = 'running';
    } catch (err) {
      console.error('[VoiceService] init failed:', err);
      this.status = 'error';
    }
  }

  async destroy(): Promise<void> {
    this.playbackUnsub?.();
    this.playbackUnsub = null;
    this.ttsQueue?.stop();
    this.ttsQueue = null;
    this.sentenceBuffer.reset();
    this.llmStreaming = false;

    this.transitioning = false;
    this.clearConversationTimer();
    this.clearSilenceTimer();
    this.hotkey.unregister();
    this.wakeWord.stop();

    if (this.audio.isRecording) {
      this.audio.stopRecording();
    }

    await this.stt.destroy();
    await this.tts.destroy();
    await this.wakeWord.destroy();
    await this.audio.destroy();

    this.setState('idle');
    this.conversationActive = false;
    this.status = 'stopped';
  }

  /** Feed an audio chunk from the renderer. Called by IPC handler. */
  feedAudioChunk(chunk: Float32Array): void {
    this.audio.feedChunk(chunk);
  }

  onMessage(msg: TypedBusMessage): void {
    const shouldSpeak = this.voiceMode !== 'off' && this.interactionMode !== 'chat';

    if (msg.topic === 'llm:chunk') {
      if (!shouldSpeak) return;
      const { text } = msg.data as { text: string };
      if (!text) return;

      const sentences = this.sentenceBuffer.push(text);
      for (const sentence of sentences) {
        if (this._voiceState === 'processing') {
          this.setState('speaking');
          this.context.bus.emit(this.id, 'voice:speaking', { text: sentence });
          this.llmStreaming = true;
        }
        this.ttsQueue?.enqueue(sentence);
      }
    } else if (msg.topic === 'llm:done') {
      if (!shouldSpeak) return;
      const remainder = this.sentenceBuffer.flush();
      if (remainder) {
        if (this._voiceState === 'processing') {
          this.setState('speaking');
          this.context.bus.emit(this.id, 'voice:speaking', { text: remainder });
        }
        this.ttsQueue?.enqueue(remainder);
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
          this.ttsQueue?.enqueue(remainder);
        }
        this.llmStreaming = false;
      } else if (this._voiceState === 'processing') {
        this.setState('idle');
        this.context.bus.emit(this.id, 'voice:error', {
          message: (msg.data as { message: string }).message ?? 'LLM request failed',
        });
      }
    }
  }

  private onTtsQueueEmpty(): void {
    if (this.llmStreaming) {
      // LLM still producing — stay in speaking state, queue will resume
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
      this.startListening();
      return;
    }
    if (this.transitioning) return;
    this.startListening();
  }

  onPttUp(): void {
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

    const transcript = await this.stt.transcribe(audioData, SAMPLE_RATE);

    if (!transcript || transcript.trim().length === 0) {
      this.handleEmptyTranscript();
      return;
    }

    this.context.bus.emit(this.id, 'voice:transcript', { text: transcript });

    if (isAbortPhrase(transcript)) {
      this.endConversation();
      return;
    }

    // Reset conversation timer on successful interaction (keyword mode)
    if (this.voiceMode === 'keyword' && this.conversationActive) {
      this.resetConversationTimer();
    }

    // Emit chat message for LLM processing
    console.log('[Voice] transcript to LLM:', JSON.stringify(transcript));
    console.log('[Voice] hex:', Buffer.from(transcript).toString('hex'));
    this.context.bus.emit(this.id, 'chat:message', { text: transcript });
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
