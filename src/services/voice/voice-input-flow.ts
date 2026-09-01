import { randomUUID } from 'crypto';
import type { AppContext } from '../../core/bootstrap.js';
import { runWithTimeout } from '../../core/abort-utils.js';
import { CHAT_UNAVAILABLE_MESSAGE } from '../../core/chat-availability.js';
import type { TurnId, VoiceCaptureId } from '../../core/turn-contract.js';
import type { AudioManager } from './audio-manager.js';
import type { SttProvider } from './stt-provider.interface.js';
import type { VoiceCaptureFlush } from './voice-capture-flush.js';
import {
  CONVERSATION_WINDOW_MS,
  SILENCE_TIMEOUT_MS,
  isAbortPhrase,
  type VoiceMode,
  type VoiceState,
} from './voice-types.js';
import type { WakeWordProvider } from './wake-word-provider.interface.js';

const SILENCE_RMS_THRESHOLD = 0.01;
const SAMPLE_RATE = 16_000;
const STT_TIMEOUT_MS = 60_000;

interface VoiceInputFlowHooks {
  getVoiceMode: () => VoiceMode;
  getVoiceState: () => VoiceState;
  isRendererCaptureReady: () => boolean;
  isSttAvailable: () => boolean;
  isSpeechPaused: () => boolean;
  hasUnavailableNotice: () => boolean;
  canAcceptConversation: () => boolean;
  interrupt: () => void;
  rejectUnavailableConversation: () => void;
  rejectUnavailableVoiceInput: () => void;
  setState: (state: VoiceState) => void;
  registerVoiceTurn: (turnId: TurnId) => void;
  markTurnProcessing: (turnId: TurnId) => void;
  releaseTurn: (turnId: TurnId) => void;
  removeProcessingTurn: (turnId: TurnId) => void;
  isTurnOpen: (turnId: TurnId) => boolean;
}

/** Owns microphone capture, recognition and the input-side voice timers. */
export class VoiceInputFlow {
  private generation = 0;
  private transitionGeneration: number | null = null;
  private conversationActive = false;
  private conversationTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private inputTurnId: TurnId | null = null;
  private captureId: VoiceCaptureId | null = null;
  private sttAbort: AbortController | null = null;

  constructor(
    private readonly context: AppContext,
    private readonly stt: SttProvider,
    private readonly wakeWord: WakeWordProvider,
    private readonly audio: AudioManager,
    private readonly captureFlush: VoiceCaptureFlush,
    private readonly hooks: VoiceInputFlowHooks,
  ) {}

  get activeInputTurnId(): TurnId | null {
    return this.inputTurnId;
  }

  get activeCaptureId(): VoiceCaptureId | null {
    return this.captureId;
  }

  get isConversationActive(): boolean {
    return this.conversationActive;
  }

  startWakeWordListening(): void {
    this.wakeWord.start(() => { this.onWakeWordDetected(); });
  }

  onPttDown(): void {
    if (!this.hooks.isRendererCaptureReady() && this.hooks.isSttAvailable()) {
      this.context.bus.emit('voice', 'voice:error', {
        message: 'Das Mikrofon wird noch vorbereitet. Bitte versuche es gleich noch einmal.',
      });
      return;
    }
    if (this.hooks.isSpeechPaused()) {
      if (!this.acceptInput()) return;
      this.startListening();
      return;
    }
    const state = this.hooks.getVoiceState();
    if (state === 'speaking' || state === 'processing') {
      const interruptedUnavailableNotice = this.hooks.hasUnavailableNotice();
      this.hooks.interrupt();
      if (interruptedUnavailableNotice || !this.acceptInput()) return;
      this.startListening();
      return;
    }
    if (this.transitionGeneration === this.generation || !this.acceptInput()) return;
    this.startListening();
  }

  onPttUp(): void {
    if (this.hooks.getVoiceState() !== 'listening') return;
    const generation = this.generation;
    const turnId = this.inputTurnId;
    void this.transition(generation, () => this.stopListeningAndProcess(generation)).catch((error) => {
      this.handleProcessingError(error, turnId, generation);
    });
  }

  feedAudioChunk(captureId: VoiceCaptureId, chunk: Float32Array): boolean {
    const result = this.audio.feedChunk(captureId, chunk);
    if (result.limitReached && this.hooks.getVoiceState() === 'listening') {
      const generation = this.generation;
      const turnId = this.inputTurnId;
      void this.transition(generation, () => this.stopListeningAndProcess(generation)).catch((error) => {
        this.handleProcessingError(error, turnId, generation);
      });
    }
    return result.accepted;
  }

  handleCaptureFailure(captureId: VoiceCaptureId | undefined, message: string): void {
    if (!captureId) {
      this.context.bus.emit('voice', 'voice:error', { message });
      return;
    }
    if (captureId !== this.captureId || this.hooks.getVoiceState() !== 'listening') return;

    this.captureFlush.reject(captureId, new Error(message));
    const turnId = this.inputTurnId;
    this.abortCurrentOperation();
    if (this.audio.isRecording) this.audio.stopRecording(captureId);
    this.context.bus.emit('voice', 'voice:error', {
      ...(turnId ? { turnId } : {}),
      message,
    });
    if (turnId) {
      this.hooks.releaseTurn(turnId);
      this.context.bus.emit('voice', 'turn:terminal', { turnId, status: 'error', message });
    }
    this.hooks.setState('idle');
  }

  abort(reason: string): void {
    if (this.captureId) this.captureFlush.reject(this.captureId, new Error(reason));
    this.abortCurrentOperation();
  }

  releaseInputTurn(turnId: TurnId, reason: string): void {
    if (this.inputTurnId !== turnId) return;
    if (this.captureId) this.captureFlush.reject(this.captureId, new Error(reason));
    this.abortCurrentOperation();
  }

  resetForConfig(): void {
    this.abort('Voice configuration changed');
    this.clearSilenceTimer();
    this.clearConversationTimer();
    this.conversationActive = false;
  }

  destroy(): void {
    this.abort('Voice service stopped');
    this.clearSilenceTimer();
    this.clearConversationTimer();
    this.conversationActive = false;
  }

  resumeKeywordConversation(): boolean {
    if (this.hooks.getVoiceMode() !== 'keyword' || !this.conversationActive) return false;
    this.startListening();
    return true;
  }

  private acceptInput(): boolean {
    if (!this.hooks.canAcceptConversation()) {
      this.hooks.rejectUnavailableConversation();
      return false;
    }
    if (!this.hooks.isSttAvailable()) {
      this.hooks.rejectUnavailableVoiceInput();
      return false;
    }
    return true;
  }

  private onWakeWordDetected(): void {
    this.context.bus.emit('voice', 'voice:wake', {});
    if (this.hooks.getVoiceState() === 'speaking') this.hooks.interrupt();
    if (!this.acceptInput()) return;
    this.wakeWord.stop();
    this.conversationActive = true;
    this.resetConversationTimer();
    this.startListening();
  }

  private startListening(): void {
    this.generation += 1;
    const turnId = randomUUID();
    const captureId = randomUUID();
    this.inputTurnId = turnId;
    this.captureId = captureId;
    this.hooks.registerVoiceTurn(turnId);
    this.context.bus.emit('voice', 'turn:accepted', { turnId, source: 'voice', mode: 'voice' });
    this.sttAbort?.abort();
    this.sttAbort = new AbortController();
    this.hooks.setState('listening');
    this.context.bus.emit('voice', 'voice:listening', { turnId, captureId });

    if (this.hooks.getVoiceMode() === 'keyword') {
      this.clearSilenceTimer();
      this.audio.startRecording(captureId, (chunk: Float32Array) => { this.checkSilence(chunk); });
    } else {
      this.audio.startRecording(captureId);
    }
  }

  private async stopListeningAndProcess(generation: number): Promise<void> {
    this.clearSilenceTimer();
    const turnId = this.inputTurnId;
    const captureId = this.captureId;
    const sttSignal = this.sttAbort?.signal;
    if (!turnId || !captureId || !sttSignal) {
      this.hooks.setState('idle');
      return;
    }
    this.hooks.markTurnProcessing(turnId);
    try {
      await this.captureFlush.request(captureId);
    } catch (error) {
      if (this.captureId === captureId) {
        this.audio.stopRecording(captureId);
        this.inputTurnId = null;
        this.captureId = null;
      }
      throw error;
    }
    const audioData = this.audio.stopRecording(captureId);
    this.inputTurnId = null;
    this.captureId = null;
    if (audioData.length === 0) {
      this.hooks.releaseTurn(turnId);
      this.hooks.setState('idle');
      this.context.bus.emit('voice', 'turn:terminal', { turnId, status: 'canceled' });
      return;
    }

    this.hooks.setState('processing');
    const language = this.context.parsedConfig.personalization.responseLanguage ?? 'de';
    const startedAt = performance.now();
    const transcript = await runWithTimeout(
      (signal) => this.stt.transcribe(audioData, SAMPLE_RATE, language, signal),
      STT_TIMEOUT_MS,
      'Speech recognition timed out',
      sttSignal,
    );
    if (!this.isCurrentOperation(generation, turnId)) return;
    this.context.bus.emit('voice', 'perf:timing', {
      turnId,
      label: 'whisper',
      ms: Math.round(performance.now() - startedAt),
      meta: { transcriptLength: transcript?.length ?? 0 },
    });

    if (!transcript || transcript.trim().length === 0) {
      this.handleEmptyTranscript(turnId, generation);
      return;
    }
    this.context.bus.emit('voice', 'voice:transcript', { turnId, captureId, text: transcript });
    if (!this.hooks.canAcceptConversation()) {
      const message = CHAT_UNAVAILABLE_MESSAGE;
      this.context.bus.emit('voice', 'llm:error', { turnId, message });
      this.context.bus.emit('voice', 'turn:terminal', { turnId, status: 'error', message });
      this.hooks.removeProcessingTurn(turnId);
      return;
    }
    if (isAbortPhrase(transcript)) {
      this.context.bus.emit('voice', 'turn:terminal', { turnId, status: 'canceled' });
      this.hooks.releaseTurn(turnId);
      this.endConversation();
      return;
    }
    if (this.hooks.getVoiceMode() === 'keyword' && this.conversationActive) {
      this.resetConversationTimer();
    }
    this.context.bus.emit('voice', 'chat:message', {
      turnId,
      captureId,
      source: 'voice',
      mode: 'voice',
      originalText: transcript,
      createdAt: new Date().toISOString(),
    });
  }

  private async transition(generation: number, operation: () => Promise<void>): Promise<void> {
    if (this.transitionGeneration === generation) return;
    this.transitionGeneration = generation;
    try {
      await operation();
    } finally {
      if (this.transitionGeneration === generation) this.transitionGeneration = null;
    }
  }

  private checkSilence(chunk: Float32Array): void {
    if (this.computeRms(chunk) < SILENCE_RMS_THRESHOLD) {
      if (!this.silenceTimer) {
        const generation = this.generation;
        const turnId = this.inputTurnId;
        this.silenceTimer = setTimeout(() => {
          this.silenceTimer = null;
          void this.transition(generation, () => this.stopListeningAndProcess(generation)).catch((error) => {
            this.handleProcessingError(error, turnId, generation);
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
    for (const sample of chunk) sum += sample * sample;
    return Math.sqrt(sum / chunk.length);
  }

  private resetConversationTimer(): void {
    this.clearConversationTimer();
    this.conversationTimer = setTimeout(() => { this.endConversation(); }, CONVERSATION_WINDOW_MS);
  }

  private endConversation(): void {
    this.clearConversationTimer();
    this.clearSilenceTimer();
    this.conversationActive = false;
    if (this.audio.isRecording) this.audio.stopRecording();
    this.hooks.setState('idle');
    if (this.hooks.getVoiceMode() === 'keyword') this.startWakeWordListening();
  }

  private handleEmptyTranscript(turnId: TurnId, generation: number): void {
    if (!this.isCurrentOperation(generation, turnId)) return;
    this.clearSilenceTimer();
    this.clearConversationTimer();
    this.hooks.releaseTurn(turnId);
    this.hooks.setState('idle');
    this.context.bus.emit('voice', 'turn:terminal', { turnId, status: 'canceled' });
  }

  private handleProcessingError(value: unknown, turnId: TurnId | null, generation: number): void {
    const error = value instanceof Error ? value : new Error(String(value));
    if (error.name === 'AbortError' || !turnId || !this.isCurrentOperation(generation, turnId)) return;
    const message = error.name === 'TimeoutError'
      ? 'Die Spracherkennung hat zu lange gebraucht. Bitte versuche es erneut.'
      : 'Die Spracheingabe konnte nicht verarbeitet werden.';
    this.hooks.releaseTurn(turnId);
    this.hooks.setState('idle');
    this.context.bus.emit('voice', 'voice:error', { turnId, message });
    this.context.bus.emit('voice', 'turn:terminal', { turnId, status: 'error', message });
  }

  private isCurrentOperation(generation: number, turnId: TurnId): boolean {
    return generation === this.generation
      && this.hooks.isTurnOpen(turnId)
      && this.inputTurnId === null;
  }

  private abortCurrentOperation(): void {
    this.generation += 1;
    this.transitionGeneration = null;
    this.sttAbort?.abort();
    this.sttAbort = null;
    this.inputTurnId = null;
    this.captureId = null;
  }

  private clearConversationTimer(): void {
    if (!this.conversationTimer) return;
    clearTimeout(this.conversationTimer);
    this.conversationTimer = null;
  }

  private clearSilenceTimer(): void {
    if (!this.silenceTimer) return;
    clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }
}
