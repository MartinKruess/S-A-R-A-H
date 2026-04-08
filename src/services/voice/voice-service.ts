// src/services/voice/voice-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { BusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { SttProvider } from './stt-provider.interface.js';
import type { TtsProvider } from './tts-provider.interface.js';
import type { WakeWordProvider } from './wake-word-provider.interface.js';
import type { AudioManager } from './audio-manager.js';
import type { HotkeyManager } from './hotkey-manager.js';
import {
  type VoiceState,
  type VoiceMode,
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
  readonly subscriptions = ['llm:done'];
  status: ServiceStatus = 'pending';

  private voiceMode: VoiceMode = 'off';
  private _voiceState: VoiceState = 'idle';
  private pushToTalkKey = DEFAULT_PTT_KEY;

  private conversationActive = false;
  private conversationTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

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

  private setState(state: VoiceState): void {
    this._voiceState = state;
  }

  async init(): Promise<void> {
    try {
      const config = await this.context.config.get<Record<string, Record<string, unknown>>>('root');
      const controls = config?.controls as Record<string, unknown> | undefined;
      this.voiceMode = (controls?.voiceMode as VoiceMode) ?? 'off';
      this.pushToTalkKey = (controls?.pushToTalkKey as string) ?? DEFAULT_PTT_KEY;

      await this.stt.init();
      await this.tts.init();

      // Only init wake-word provider when keyword mode is active
      if (this.voiceMode === 'keyword') {
        await this.wakeWord.init();
      }

      this.setupMode();
      this.status = 'running';
    } catch {
      this.status = 'error';
    }
  }

  async destroy(): Promise<void> {
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

  onMessage(msg: BusMessage): void {
    if (msg.topic === 'llm:done') {
      const fullText = msg.data.fullText as string;
      if (this.voiceMode !== 'off' && fullText) {
        this.speakResponse(fullText).catch(() => {
          this.context.bus.emit(this.id, 'voice:error', { message: 'TTS failed' });
        });
      }
    }
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
    }
    this.startListening();
  }

  onPttUp(): void {
    this.stopListeningAndProcess().catch(() => {
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
    this.context.bus.emit(this.id, 'chat:message', { text: transcript });
  }

  private async speakResponse(text: string): Promise<void> {
    this.setState('speaking');
    this.context.bus.emit(this.id, 'voice:speaking', { text });

    try {
      const audioData = await this.tts.speak(text);
      this.audio.setPlaying(true);

      // Send audio to renderer for playback via IPC
      // The renderer plays it via Web Audio API and sends 'voice:playback-done' when finished
      this.context.bus.emit(this.id, 'voice:play-audio', {
        audio: Array.from(audioData),
        sampleRate: 22_050,
      });

      // Wait for playback to finish (renderer signals via IPC → bus)
      await new Promise<void>((resolve) => {
        const unsub = this.context.bus.on('voice:playback-done', () => {
          unsub();
          resolve();
        });
        // Fallback timeout based on audio duration
        const durationMs = (audioData.length / 22_050) * 1000 + 500;
        setTimeout(() => { unsub(); resolve(); }, durationMs);
      });

      this.audio.setPlaying(false);
      this.context.bus.emit(this.id, 'voice:done', {});

      // After speaking, decide next state
      if (this.voiceMode === 'keyword' && this.conversationActive) {
        this.startListening();
      } else {
        this.setState('idle');
      }
    } catch {
      this.audio.setPlaying(false);
      this.setState('idle');
      this.context.bus.emit(this.id, 'voice:error', { message: 'Speech failed' });
    }
  }

  private interrupt(): void {
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
