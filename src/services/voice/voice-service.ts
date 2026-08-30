// src/services/voice/voice-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import { traceBootPerformance } from '../../core/boot-performance-trace.js';
import type { SttAvailability, SttProvider } from './stt-provider.interface.js';
import type { TtsAvailability, TtsProvider } from './tts-provider.interface.js';
import type { WakeWordProvider } from './wake-word-provider.interface.js';
import type { AudioManager } from './audio-manager.js';
import type { HotkeyManager } from './hotkey-manager.js';
import {
  CHAT_UNAVAILABLE_MESSAGE,
  STT_UNAVAILABLE_MESSAGE,
  isChatAvailable,
} from '../../core/chat-availability.js';
import { SentenceBuffer } from './sentence-buffer.js';
import {
  TTS_PRIORITY,
  TtsQueue,
  type TtsPriority,
  type TtsQueueItem,
} from './tts-queue.js';
import { runWithTimeout, throwIfAborted } from '../../core/abort-utils.js';
import { randomUUID } from 'crypto';
import type { OutputId, PlaybackId, TurnId, VoiceCaptureId } from '../../core/turn-contract.js';
import type { BusEvents, PrioritySpeechCategory } from '../../core/bus-events.js';
import {
  type VoiceState,
  type VoiceMode,
  type InteractionMode,
  SILENCE_TIMEOUT_MS,
  CONVERSATION_WINDOW_MS,
  DEFAULT_PTT_KEY,
  isAbortPhrase,
  normalizeVoiceMode,
} from './voice-types.js';

/** RMS threshold below which audio is considered silence */
const SILENCE_RMS_THRESHOLD = 0.01;

/** Default sample rate for STT */
const SAMPLE_RATE = 16_000;
const STT_TIMEOUT_MS = 60_000;
const CAPTURE_FLUSH_TIMEOUT_MS = 2_000;

const PRIORITY_SPEECH_QUEUE_PRIORITY: Record<PrioritySpeechCategory, TtsPriority> = {
  background: TTS_PRIORITY.BACKGROUND,
  normal: TTS_PRIORITY.NORMAL,
  timer: TTS_PRIORITY.TIMER,
  critical: TTS_PRIORITY.CRITICAL,
  user: TTS_PRIORITY.USER,
};

type VoiceTurnMode = 'voice' | 'chatspeak';

interface OutputLifecycle {
  turnId: TurnId;
  outputId: OutputId;
  sequence: number;
  text: string;
  complete: boolean;
  failed: boolean;
  shouldSpeak: boolean;
  startedSpeaking: boolean;
  buffer: SentenceBuffer;
}

export class VoiceService implements SarahService {
  readonly id = 'voice';
  readonly subscriptions = [
    'turn:accepted',
    'chat:message',
    'turn:output-policy',
    'llm:chunk',
    'llm:done',
    'llm:error',
    'llm:filler',
    'voice:priority-speech',
    'voice:resume-speech',
    'voice:discard-paused-speech',
    'turn:terminal',
  ] as const;
  status: ServiceStatus = 'pending';

  private voiceMode: VoiceMode = 'off';
  private interactionMode: InteractionMode = 'voice';
  private _voiceState: VoiceState = 'idle';
  private pushToTalkKey = DEFAULT_PTT_KEY;

  private voiceGeneration = 0;
  private transitionGeneration: number | null = null;
  private conversationActive = false;
  private conversationTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private rendererAvailable = true;
  private rendererCaptureReady = false;
  private rendererCaptureHotkeyReconcilePending = false;
  private rendererCaptureHotkeySuspended = false;

  private ttsQueue: TtsQueue | null = null;
  private playbackUnsub: (() => void) | null = null;
  private sttAvailabilityUnsub: (() => void) | null = null;
  private ttsAvailabilityUnsub: (() => void) | null = null;
  private activeInputTurnId: TurnId | null = null;
  private readonly processingTurnIds = new Set<TurnId>();
  private readonly voiceRelevantTurns = new Map<TurnId, VoiceTurnMode>();
  private readonly turnSpeechDecisions = new Map<TurnId, boolean>();
  private readonly unavailableNoticeTurns = new Set<TurnId>();
  private readonly outputs = new Map<OutputId, OutputLifecycle>();
  private currentOutputId: OutputId | null = null;
  private activePlaybackTurnId: TurnId | null = null;
  private activePlaybackId: PlaybackId | null = null;
  private activeCaptureId: VoiceCaptureId | null = null;
  private readonly captureFlushWaiters = new Map<VoiceCaptureId, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private sttAbort: AbortController | null = null;
  private readonly spokenTurns = new Set<TurnId>();
  private readonly prioritySpeechTurns = new Set<TurnId>();
  private readonly voiceDoneTurns = new Set<TurnId>();
  private readonly routerErrorTurns = new Set<TurnId>();

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

  get voiceStateSnapshot(): BusEvents['voice:state'] {
    return this.createStateSnapshot(this._voiceState);
  }

  /** Whether normal speech is currently held behind a priority barrier. */
  get isSpeechPaused(): boolean {
    return this.ttsQueue?.isPaused ?? false;
  }

  /** Compatibility snapshot for diagnostics/tests; productive ownership lives in the sets/maps. */
  private get processingTurnId(): TurnId | null {
    return this.lastSetValue(this.processingTurnIds);
  }

  private get activeOutput(): OutputLifecycle | null {
    return this.currentOutputId ? this.outputs.get(this.currentOutputId) ?? null : null;
  }

  private get activeOutputTurnId(): TurnId | null {
    return this.activeOutput?.turnId ?? null;
  }

  private get activeOutputText(): string {
    return this.activeOutput?.text ?? '';
  }

  private get llmStreaming(): boolean {
    return [...this.outputs.values()].some((output) => (
      output.startedSpeaking && !output.complete && !output.failed
    ));
  }

  /** Ends only the listening turn that owns a failed renderer capture. */
  handleCaptureFailure(captureId: VoiceCaptureId | undefined, message: string): void {
    if (!captureId) {
      this.context.bus.emit(this.id, 'voice:error', { message });
      return;
    }
    if (captureId !== this.activeCaptureId || this._voiceState !== 'listening') return;

    this.rejectCaptureFlush(captureId, new Error(message));

    const turnId = this.activeInputTurnId;
    this.voiceGeneration += 1;
    this.transitionGeneration = null;
    this.sttAbort?.abort();
    this.sttAbort = null;
    if (this.audio.isRecording) this.audio.stopRecording(captureId);
    this.activeInputTurnId = null;
    this.activeCaptureId = null;
    this.context.bus.emit(this.id, 'voice:error', {
      ...(turnId ? { turnId } : {}),
      message,
    });
    if (turnId) {
      this.processingTurnIds.delete(turnId);
      this.voiceRelevantTurns.delete(turnId);
      this.turnSpeechDecisions.delete(turnId);
      this.context.bus.emit(this.id, 'turn:terminal', {
        turnId,
        status: 'error',
        message,
      });
    }
    this.setState('idle');
  }

  /** Withdraws renderer audio ownership and ends its correlated capture/playback work. */
  handleRendererCaptureUnavailable(message: string): void {
    const captureId = this.activeCaptureId ?? undefined;
    const playbackTurnId = this.activePlaybackTurnId;
    const playbackId = this.activePlaybackId;
    if (
      captureId
      && this.voiceMode === 'push-to-talk'
      && this._voiceState === 'listening'
    ) {
      this.rendererCaptureHotkeySuspended = true;
    }
    this.rendererAvailable = false;
    this.applyRendererCaptureReady(false);
    if (captureId) this.handleCaptureFailure(captureId, message);
    if (playbackTurnId && playbackId) {
      this.handlePlaybackFailure(playbackTurnId, playbackId, message, true);
    } else if (this.ttsQueue?.isActive) {
      this.ttsQueue.stop();
      this.audio.setPlaying(false);
      this.reconcileStoppedRendererAudio();
    }
  }

  /** Completes the exact renderer capture whose worklet and IPC tail were flushed. */
  handleCaptureFlushed(captureId: VoiceCaptureId): void {
    const waiter = this.captureFlushWaiters.get(captureId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.captureFlushWaiters.delete(captureId);
    waiter.resolve();
  }

  private rejectCaptureFlush(captureId: VoiceCaptureId, error: Error): void {
    const waiter = this.captureFlushWaiters.get(captureId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.captureFlushWaiters.delete(captureId);
    waiter.reject(error);
  }

  private requestCaptureFlush(captureId: VoiceCaptureId): Promise<void> {
    const existing = this.captureFlushWaiters.get(captureId);
    if (existing) {
      return Promise.reject(new Error(`Capture ${captureId} is already being flushed`));
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.captureFlushWaiters.delete(captureId);
        reject(new Error('Renderer capture flush timed out'));
      }, CAPTURE_FLUSH_TIMEOUT_MS);
      this.captureFlushWaiters.set(captureId, { resolve, reject, timeout });
      this.context.bus.emit(this.id, 'voice:capture-flush-request', { captureId });
    });
  }

  setInteractionMode(mode: InteractionMode): void {
    this.interactionMode = mode;
  }

  setRendererCaptureReady(ready: boolean): void {
    this.rendererAvailable = true;
    this.flushDeferredSentences();
    this.applyRendererCaptureReady(ready);
  }

  private applyRendererCaptureReady(ready: boolean): void {
    if (this.rendererCaptureReady === ready) return;
    this.rendererCaptureReady = ready;
    if (this.status !== 'running' || this.voiceMode !== 'push-to-talk') return;
    if (this._voiceState === 'listening') {
      this.rendererCaptureHotkeyReconcilePending = true;
      return;
    }
    if (this.rendererCaptureHotkeySuspended) {
      if (ready) {
        this.rendererCaptureHotkeySuspended = false;
        this.hotkey.resume();
      }
      return;
    }
    if (ready || !this.capabilities.stt) {
      this.setupMode();
    } else {
      this.hotkey.unregister();
    }
  }

  private setState(state: VoiceState): void {
    const wasListening = this._voiceState === 'listening';
    this._voiceState = state;
    this.context.bus.emit(this.id, 'voice:state', this.createStateSnapshot(state));
    if (
      wasListening
      && state !== 'listening'
      && this.rendererCaptureHotkeyReconcilePending
    ) {
      this.rendererCaptureHotkeyReconcilePending = false;
      if (this.rendererCaptureHotkeySuspended) {
        this.hotkey.suspend();
      } else if (
        this.status === 'running'
        && this.voiceMode === 'push-to-talk'
        && (this.rendererCaptureReady || !this.capabilities.stt)
      ) {
        this.setupMode();
      } else {
        this.hotkey.unregister();
      }
    }
    if (wasListening && state !== 'listening') this.flushDeferredSentences();
  }

  private createStateSnapshot(state: VoiceState): BusEvents['voice:state'] {
    const turnId = state === 'listening'
      ? this.activeInputTurnId
      : state === 'processing'
        ? this.processingTurnId ?? this.activeInputTurnId
        : state === 'speaking'
          ? this.activePlaybackTurnId ?? this.activeOutputTurnId ?? this.processingTurnId
          : this.activeOutputTurnId ?? this.processingTurnId ?? this.activeInputTurnId;
    return {
      state,
      ...(turnId ? { turnId } : {}),
      ...(this.activeCaptureId ? { captureId: this.activeCaptureId } : {}),
    };
  }

  /** Never play TTS into an open recording — defer until listening ends (F9). */
  private enqueueOrDefer(item: TtsQueueItem): void {
    if (this._voiceState === 'listening' || !this.rendererAvailable) {
      this.deferredSentences.push(item);
      return;
    }
    this.ttsQueue?.enqueue(item);
  }

  private flushDeferredSentences(): void {
    if (
      this._voiceState === 'listening'
      || !this.rendererAvailable
      || !this.ttsQueue
      || this.deferredSentences.length === 0
    ) return;
    if (
      !this.ttsQueue.isPaused
      && (this._voiceState === 'processing' || this._voiceState === 'idle')
    ) {
      this.setState('speaking');
    }
    for (const item of this.deferredSentences) this.ttsQueue.enqueue(item);
    this.deferredSentences = [];
  }

  private async transition(generation: number, fn: () => Promise<void>): Promise<void> {
    if (this.transitionGeneration === generation) return;
    this.transitionGeneration = generation;
    try {
      await fn();
    } finally {
      if (this.transitionGeneration === generation) this.transitionGeneration = null;
    }
  }

  private capabilities = { stt: false, tts: false };
  private initPromise: Promise<void> | null = null;
  private initializing = false;

  get capabilitySnapshot(): Readonly<{ stt: boolean; tts: boolean }> {
    return { ...this.capabilities };
  }

  async retryRuntimeRecovery(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    try {
      if (this.stt.retry) await this.stt.retry(signal);
      else await this.stt.init(signal);
      this.applySttAvailability({ available: true });
      this.status = 'running';
      this.context.bus.emit(this.id, 'voice:capability', { ...this.capabilities });
    } catch (error) {
      throwIfAborted(signal);
      const message = error instanceof Error ? error.message : String(error);
      this.applySttAvailability({ available: false, message });
      throw error;
    }
  }

  init(signal?: AbortSignal): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit(signal);
    return this.initPromise;
  }

  private async doInit(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.initializing = true;
    const { controls } = this.context.parsedConfig;
    this.voiceMode = normalizeVoiceMode(controls.voiceMode);
    this.pushToTalkKey = controls.pushToTalkKey;
    this.sttAvailabilityUnsub = this.stt.onAvailabilityChange?.((state) => {
      this.applySttAvailability(state);
    }) ?? null;
    this.ttsAvailabilityUnsub = this.tts.onAvailabilityChange?.((state) => {
      this.applyTtsAvailability(state);
    }) ?? null;

    // STT and TTS are independent capabilities (A5): one failing must not
    // silently kill the other — degrade instead of dying.
    const whisperStartedAt = performance.now();
    traceBootPerformance('whisper', 'start');
    try {
      await this.stt.init(signal);
      this.applySttAvailability({ available: true });
      traceBootPerformance('whisper', 'ready', {
        durationMs: performance.now() - whisperStartedAt,
      });
    } catch (err) {
      traceBootPerformance('whisper', 'failed', {
        durationMs: performance.now() - whisperStartedAt,
      });
      if (!this.stt.recoversAfterInitFailure) {
        await this.cleanupFailedProvider('STT', () => this.stt.destroy());
      }
      throwIfAborted(signal);
      console.error('[VoiceService] STT init failed:', err);
      this.context.lifecycle?.setCapability(
        'stt',
        'unavailable',
        err instanceof Error ? err.message : String(err),
      );
    }

    const piperStartedAt = performance.now();
    traceBootPerformance('piper', 'start');
    try {
      await this.tts.init(signal);
      this.applyTtsAvailability({ available: true });
      traceBootPerformance('piper', 'ready', {
        durationMs: performance.now() - piperStartedAt,
      });
    } catch (err) {
      traceBootPerformance('piper', 'failed', {
        durationMs: performance.now() - piperStartedAt,
      });
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
          this.activePlaybackTurnId = item.turnId;
          this.activePlaybackId = playbackId;
          this.audio.setPlaying(true);
          if (
            this._voiceState !== 'speaking'
            && (item.priority ?? TTS_PRIORITY.NORMAL) !== TTS_PRIORITY.BACKGROUND
          ) {
            this.setState('speaking');
          }
          this.context.bus.emit(this.id, 'voice:play-audio', {
            turnId: item.turnId,
            outputId: item.outputId,
            playbackId,
            audio: Array.from(audio),
            sampleRate,
          });
        },
        () => { this.onTtsQueueEmpty(); },
        (err, item) => {
          console.error('[VoiceService] TTS error:', err);
          this.context.bus.emit(this.id, 'voice:error', {
            turnId: item.turnId,
            outputId: item.outputId,
            message: err.message,
          });
        },
        (ms, turnId) => {
          this.context.bus.emit(this.id, 'perf:timing', { turnId, label: 'tts', ms });
        },
        (turnId) => {
          if (this.activePlaybackTurnId === turnId) {
            this.activePlaybackTurnId = null;
            this.activePlaybackId = null;
            this.audio.setPlaying(false);
          }
          this.tryCompleteSpokenTurn(turnId);
        },
        (turnId, playbackId) => {
          this.context.bus.emit(this.id, 'voice:stop-playback', { turnId, playbackId });
        },
      );

      this.playbackUnsub = this.context.bus.on('voice:playback-done', (msg) => {
        if (
          this.activePlaybackTurnId !== msg.data.turnId
          || this.activePlaybackId !== msg.data.playbackId
        ) return;
        this.activePlaybackTurnId = null;
        this.activePlaybackId = null;
        this.audio.setPlaying(false);
        this.ttsQueue?.playbackDone(msg.data.turnId, msg.data.playbackId);
        if (this.ttsQueue?.isPaused) this.restoreOwnedVoiceState();
      });
    }

    this.initializing = false;
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
    attempt(() => this.sttAvailabilityUnsub?.());
    this.sttAvailabilityUnsub = null;
    attempt(() => this.ttsAvailabilityUnsub?.());
    this.ttsAvailabilityUnsub = null;
    attempt(() => this.ttsQueue?.stop());
    this.ttsQueue = null;
    this.deferredSentences = [];
    this.sttAbort?.abort();
    this.sttAbort = null;
    this.activeInputTurnId = null;
    this.processingTurnIds.clear();
    this.voiceRelevantTurns.clear();
    this.turnSpeechDecisions.clear();
    this.unavailableNoticeTurns.clear();
    this.outputs.clear();
    this.currentOutputId = null;
    this.activePlaybackTurnId = null;
    this.activePlaybackId = null;
    this.activeCaptureId = null;
    for (const [captureId] of this.captureFlushWaiters) {
      this.rejectCaptureFlush(captureId, new Error('Voice service stopped'));
    }
    this.spokenTurns.clear();
    this.prioritySpeechTurns.clear();
    this.voiceDoneTurns.clear();
    this.routerErrorTurns.clear();

    this.voiceGeneration += 1;
    this.transitionGeneration = null;
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

  private applySttAvailability(state: SttAvailability): void {
    const changed = this.capabilities.stt !== state.available;
    this.capabilities.stt = state.available;
    if (!state.available && this._voiceState === 'listening' && this.activeCaptureId) {
      this.handleCaptureFailure(this.activeCaptureId, STT_UNAVAILABLE_MESSAGE);
    }
    this.context.lifecycle?.setCapability(
      'stt',
      state.available ? 'ready' : 'unavailable',
      state.available ? undefined : state.message ?? 'Spracherkennung ist nicht verfügbar.',
    );
    this.status = this.capabilities.stt || this.capabilities.tts ? 'running' : 'error';
    if (changed && !this.initializing) {
      this.context.bus.emit(this.id, 'voice:capability', { ...this.capabilities });
    }
  }

  private applyTtsAvailability(state: TtsAvailability): void {
    const changed = this.capabilities.tts !== state.available;
    this.capabilities.tts = state.available;
    this.context.lifecycle?.setCapability(
      'tts',
      state.available ? 'ready' : 'unavailable',
      state.available ? undefined : state.message ?? 'Sprachausgabe ist nicht verfügbar.',
    );
    this.status = this.capabilities.stt || this.capabilities.tts ? 'running' : 'error';
    if (changed && !this.initializing) {
      this.context.bus.emit(this.id, 'voice:capability', { ...this.capabilities });
    }
  }

  /** Feed an audio chunk from the renderer. Called by IPC handler. */
  feedAudioChunk(captureId: VoiceCaptureId, chunk: Float32Array): boolean {
    const result = this.audio.feedChunk(captureId, chunk);
    if (result.limitReached && this._voiceState === 'listening') {
      const generation = this.voiceGeneration;
      const turnId = this.activeInputTurnId;
      void this.transition(generation, () => this.stopListeningAndProcess(generation)).catch((error) => {
        this.handleProcessingError(error, turnId, generation);
      });
    }
    return result.accepted;
  }

  onMessage(msg: TypedBusMessage): void {
    if (msg.topic === 'turn:accepted') {
      if (!this.turnSpeechDecisions.has(msg.data.turnId)) {
        const shouldSpeak = this.voiceMode !== 'off' && msg.data.mode === 'voice';
        this.turnSpeechDecisions.set(msg.data.turnId, shouldSpeak);
        if (shouldSpeak && msg.data.source === 'system') {
          this.voiceRelevantTurns.set(msg.data.turnId, 'voice');
        }
      }
      return;
    }

    if (msg.topic === 'chat:message') {
      if (msg.data.source === 'chat') {
        if (!this.turnSpeechDecisions.has(msg.data.turnId)) {
          this.turnSpeechDecisions.set(
            msg.data.turnId,
            this.voiceMode !== 'off' && msg.data.mode === 'voice',
          );
        }
        const shouldSpeak = this.turnSpeechDecisions.get(msg.data.turnId) ?? false;
        const ownsPttBargeIn = this.voiceMode === 'push-to-talk';
        if (!shouldSpeak && !ownsPttBargeIn) return;
        this.processingTurnIds.add(msg.data.turnId);
        if (!this.activePlaybackTurnId) this.setState('processing');
        if (!shouldSpeak) return;
        this.interactionMode = 'chatspeak';
        this.voiceRelevantTurns.set(msg.data.turnId, 'chatspeak');
      }
      return;
    }

    if (msg.topic === 'turn:output-policy') {
      if (msg.data.speech === 'suppress') {
        this.turnSpeechDecisions.set(msg.data.turnId, false);
      }
      return;
    }

    if (msg.topic === 'llm:filler') {
      // A bridging phrase spoken over a model-swap pause. It is not turn content,
      // but it still follows the recording/renderer safety gate before reaching TTS.
      if (!this.context.bus.isTurnOpen(msg.data.turnId)) return;
      this.enqueueOrDefer({
        turnId: msg.data.turnId,
        outputId: randomUUID(),
        text: msg.data.text,
        priority: TTS_PRIORITY.BACKGROUND,
      });
      return;
    }

    if (msg.topic === 'voice:priority-speech') {
      if (
        this.voiceMode === 'off'
        || !this.context.bus.isTurnOpen(msg.data.turnId)
        || !msg.data.text
        || !this.ttsQueue
      ) return;
      const item: TtsQueueItem = {
        turnId: msg.data.turnId,
        outputId: msg.data.outputId,
        text: msg.data.text,
        priority: PRIORITY_SPEECH_QUEUE_PRIORITY[msg.data.priority],
        pauseAfterPlayback: msg.data.pauseAfter === true && this.hasNormalSpeechWork(),
      };
      this.spokenTurns.add(item.turnId);
      this.prioritySpeechTurns.add(item.turnId);
      if (
        this._voiceState !== 'listening'
        && this.rendererAvailable
        && (this._voiceState === 'processing' || this._voiceState === 'idle')
      ) {
        this.setState('speaking');
      }
      this.context.bus.emit(this.id, 'voice:speaking', {
        turnId: item.turnId,
        outputId: item.outputId,
        text: item.text,
      });
      this.enqueueOrDefer(item);
      return;
    }

    if (msg.topic === 'voice:resume-speech') {
      if (!this.ttsQueue?.isPaused) return;
      this.ttsQueue.resume();
      for (const turnId of [...this.spokenTurns]) this.tryCompleteSpokenTurn(turnId);
      this.restoreOwnedVoiceState();
      return;
    }

    if (msg.topic === 'voice:discard-paused-speech') {
      if (!this.ttsQueue?.isPaused) return;
      this.discardPausedSpeech(msg.data.preserveTurnId, msg.data.reason);
      return;
    }

    if (msg.topic === 'turn:terminal') {
      const turnId = msg.data.turnId;
      this.processingTurnIds.delete(turnId);
      this.routerErrorTurns.delete(turnId);
      if (msg.data.status === 'canceled') {
        const ownsInput = this.activeInputTurnId === turnId;
        this.spokenTurns.delete(turnId);
        this.prioritySpeechTurns.delete(turnId);
        this.deferredSentences = this.deferredSentences.filter((item) => item.turnId !== turnId);
        this.ttsQueue?.cancelTurn(turnId);
        if (ownsInput) this.activeInputTurnId = null;
        this.removeTurnOutputs(turnId);
        this.voiceRelevantTurns.delete(turnId);
        this.turnSpeechDecisions.delete(turnId);
        this.unavailableNoticeTurns.delete(turnId);
      } else {
        for (const output of this.outputs.values()) {
          if (output.turnId !== turnId || output.complete || output.failed) continue;
          output.buffer.reset();
          output.complete = true;
          output.failed = msg.data.status === 'error';
        }
        this.tryCompleteSpokenTurn(turnId);
        if (!this.spokenTurns.has(turnId)) {
          this.voiceRelevantTurns.delete(turnId);
          this.turnSpeechDecisions.delete(turnId);
          this.unavailableNoticeTurns.delete(turnId);
        }
      }
      this.restoreOwnedVoiceState();
      return;
    }

    if (msg.topic === 'llm:chunk') {
      if (!this.context.bus.isTurnOpen(msg.data.turnId)) return;
      const turnId = msg.data.turnId;
      const outputId = msg.data.outputId;
      const { text } = msg.data;
      if (!text) return;
      const output = this.getOrCreateOutput(turnId, outputId);
      if (msg.data.sequence !== output.sequence || output.complete || output.failed) return;
      output.sequence += 1;
      output.text += text;
      if (!output.shouldSpeak) return;
      this.enqueueSentences(output, output.buffer.push(text));
    } else if (msg.topic === 'llm:done') {
      if (!this.context.bus.isTurnOpen(msg.data.turnId)) return;
      const turnId = msg.data.turnId;
      const outputId = msg.data.outputId;
      const output = this.getOrCreateOutput(turnId, outputId);
      if (output.complete || output.failed) return;
      if (!output.shouldSpeak) {
        output.sequence = msg.data.sequence;
        output.text = msg.data.fullText;
        output.complete = true;
        this.cleanupFinishedOutputs();
        return;
      }
      if (msg.data.fullText.startsWith(output.text)) {
        const recovered = msg.data.fullText.slice(output.text.length);
        if (recovered) {
          this.enqueueSentences(output, output.buffer.push(recovered));
          output.text = msg.data.fullText;
        }
      } else if (msg.data.sequence !== output.sequence) {
        this.ttsQueue?.cancelTurn(turnId);
        output.buffer.reset();
        output.text = msg.data.fullText;
        this.enqueueSentences(output, output.buffer.push(msg.data.fullText));
      }
      output.sequence = msg.data.sequence;
      output.complete = true;
      const remainder = output.buffer.flush();
      if (remainder) this.enqueueSentences(output, [remainder]);
      // llm:done can be an action acknowledgement. Processing ownership is
      // released only by the terminal event after the action itself completes.
      if (!this.ttsQueue?.isActive) this.onTtsQueueEmpty();
    } else if (msg.topic === 'llm:error') {
      if (this.context.bus.isTurnTerminal(msg.data.turnId)) return;
      const turnId = msg.data.turnId;
      const turnOutputs = [...this.outputs.values()].filter((output) => output.turnId === turnId);
      const isOwned = this.processingTurnIds.has(turnId)
        || this.voiceRelevantTurns.has(turnId)
        || this.turnSpeechDecisions.has(turnId)
        || turnOutputs.length > 0;
      if (!isOwned || this.routerErrorTurns.has(turnId)) return;
      this.routerErrorTurns.add(turnId);
      this.processingTurnIds.delete(turnId);
      this.deferredSentences = this.deferredSentences.filter((item) => item.turnId !== turnId);
      for (const output of turnOutputs) {
        output.buffer.reset();
        output.complete = true;
        output.failed = true;
      }
      this.ttsQueue?.cancelTurn(turnId);
      const shouldSpeakError = this.turnSpeechDecisions.get(turnId)
        ?? (
          this.voiceMode !== 'off'
          && (this.voiceRelevantTurns.has(turnId) || turnOutputs.some((output) => output.shouldSpeak))
        );
      if (shouldSpeakError && this.capabilities.tts) {
        const output = this.getOrCreateOutput(turnId, randomUUID(), true);
        output.complete = true;
        output.failed = true;
        this.enqueueSentences(output, [msg.data.message || 'Die Anfrage ist fehlgeschlagen.']);
      }
      if (!this.ttsQueue?.isActive) {
        this.cleanupFinishedOutputs();
        this.restoreOwnedVoiceState();
      }
    }
  }

  /** Rejects only the renderer playback that still owns the correlated audio item. */
  handlePlaybackFailure(
    turnId: TurnId,
    playbackId: PlaybackId,
    message: string,
    stopRemaining = false,
  ): void {
    if (this.activePlaybackTurnId !== turnId || this.activePlaybackId !== playbackId) return;
    this.activePlaybackTurnId = null;
    this.activePlaybackId = null;
    this.audio.setPlaying(false);
    this.ttsQueue?.playbackFailed(turnId, playbackId, new Error(message), stopRemaining);
    if (stopRemaining) {
      this.reconcileStoppedRendererAudio();
    }
  }

  private reconcileStoppedRendererAudio(): void {
    for (const spokenTurnId of [...this.spokenTurns]) {
      this.tryCompleteSpokenTurn(spokenTurnId);
    }
    this.cleanupFinishedOutputs();
    this.restoreOwnedVoiceState();
  }

  private getOrCreateOutput(
    turnId: TurnId,
    outputId: OutputId,
    forceSpeak?: boolean,
  ): OutputLifecycle {
    const existing = this.outputs.get(outputId);
    if (existing) {
      if (existing.turnId !== turnId) {
        throw new Error(`Output ${outputId} cannot change its owning turn`);
      }
      this.currentOutputId = outputId;
      return existing;
    }
    const output: OutputLifecycle = {
      turnId,
      outputId,
      sequence: 0,
      text: '',
      complete: false,
      failed: false,
      shouldSpeak: forceSpeak
        ?? this.turnSpeechDecisions.get(turnId)
        ?? (
          this.voiceMode !== 'off'
          && (this.voiceRelevantTurns.has(turnId) || this.interactionMode !== 'chat')
        ),
      startedSpeaking: false,
      buffer: new SentenceBuffer(),
    };
    this.outputs.set(outputId, output);
    this.currentOutputId = outputId;
    return output;
  }

  private enqueueSentences(output: OutputLifecycle, sentences: string[]): void {
    for (const sentence of sentences) {
      if (!sentence) continue;
      output.startedSpeaking = true;
      this.spokenTurns.add(output.turnId);
      if (this._voiceState === 'processing' || this._voiceState === 'idle') {
        this.setState('speaking');
      }
      this.context.bus.emit(this.id, 'voice:speaking', {
        turnId: output.turnId,
        outputId: output.outputId,
        text: sentence,
      });
      this.enqueueOrDefer({
        turnId: output.turnId,
        outputId: output.outputId,
        text: sentence,
        priority: TTS_PRIORITY.NORMAL,
      });
    }
  }

  /** Checks only normal requested speech; fillers and priority messages do not create a timer pause. */
  private hasNormalSpeechWork(): boolean {
    if (this.deferredSentences.some(
      (item) => (item.priority ?? TTS_PRIORITY.NORMAL) === TTS_PRIORITY.NORMAL,
    )) return true;

    return [...this.outputs.values()].some((output) => (
      output.shouldSpeak
      && (
        (!output.complete && !output.failed)
        || this.ttsQueue?.hasTurn(output.turnId) === true
      )
    ));
  }

  private cleanupFinishedOutputs(): void {
    for (const [outputId, output] of this.outputs) {
      const isDeferred = this.deferredSentences.some((item) => item.turnId === output.turnId);
      if ((!output.complete && !output.failed) || this.ttsQueue?.hasTurn(output.turnId) || isDeferred) continue;
      this.outputs.delete(outputId);
    }
    if (this.currentOutputId && !this.outputs.has(this.currentOutputId)) {
      this.currentOutputId = this.lastSetValue(new Set(this.outputs.keys()));
    }
  }

  private removeTurnOutputs(turnId: TurnId): void {
    for (const [outputId, output] of this.outputs) {
      if (output.turnId === turnId) this.outputs.delete(outputId);
    }
    if (this.currentOutputId && !this.outputs.has(this.currentOutputId)) {
      this.currentOutputId = this.lastSetValue(new Set(this.outputs.keys()));
    }
  }

  private lastSetValue<T>(values: Set<T>): T | null {
    let result: T | null = null;
    for (const value of values) result = value;
    return result;
  }

  private onTtsQueueEmpty(): void {
    this.cleanupFinishedOutputs();
    if (this._voiceState === 'listening') return;
    if (this.llmStreaming) {
      // LLM still producing — stay in speaking state, queue will resume
      return;
    }
    for (const turnId of [...this.spokenTurns]) this.tryCompleteSpokenTurn(turnId);

    if (this.voiceMode === 'keyword' && this.conversationActive) {
      this.startListening();
    } else {
      this.restoreOwnedVoiceState();
    }
  }

  /** Restore the UI state from the turn that still owns active voice work. */
  private restoreOwnedVoiceState(): void {
    if (this.activeInputTurnId) {
      this.setState('listening');
    } else if (this.activePlaybackTurnId) {
      this.setState('speaking');
    } else if (this.ttsQueue?.isPaused) {
      this.setState(this.processingTurnIds.size > 0 ? 'processing' : 'idle');
    } else if (this.ttsQueue?.isActive) {
      this.setState('speaking');
    } else if (this.processingTurnIds.size > 0) {
      this.setState('processing');
    } else if (this.llmStreaming) {
      this.setState('speaking');
    } else {
      this.setState('idle');
    }
  }

  private tryCompleteSpokenTurn(turnId: TurnId): void {
    if (!this.spokenTurns.has(turnId) || this.voiceDoneTurns.has(turnId)) return;
    if (
      !this.context.bus.isTurnTerminal(turnId)
      || this.ttsQueue?.hasTurn(turnId)
      || this.deferredSentences.some((item) => item.turnId === turnId)
    ) return;
    this.spokenTurns.delete(turnId);
    this.prioritySpeechTurns.delete(turnId);
    this.voiceDoneTurns.add(turnId);
    if (this.voiceDoneTurns.size > 2_000) {
      const oldest = this.voiceDoneTurns.values().next().value as TurnId | undefined;
      if (oldest) this.voiceDoneTurns.delete(oldest);
    }
    this.context.bus.emit(this.id, 'voice:done', { turnId });
    const turnMode = this.voiceRelevantTurns.get(turnId);
    this.voiceRelevantTurns.delete(turnId);
    this.turnSpeechDecisions.delete(turnId);
    this.unavailableNoticeTurns.delete(turnId);
    if (turnMode === 'chatspeak' && this.interactionMode === 'chatspeak') {
      const hasOtherChatSpeakTurn = [...this.voiceRelevantTurns.values()].includes('chatspeak');
      if (!hasOtherChatSpeakTurn) this.interactionMode = 'voice';
    }
  }

  async applyConfig(): Promise<void> {
    this.cancelActiveWork('Voice configuration changed');
    // Tear down current mode
    this.rendererCaptureHotkeyReconcilePending = false;
    this.rendererCaptureHotkeySuspended = false;
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
    this.voiceMode = normalizeVoiceMode(controls.voiceMode);
    this.pushToTalkKey = controls.pushToTalkKey;

    // Set up new mode
    this.setupMode();
  }

  private setupMode(): void {
    if (
      this.voiceMode === 'push-to-talk'
      && (this.rendererCaptureReady || !this.capabilities.stt)
    ) {
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
    if (!this.rendererCaptureReady && this.capabilities.stt) {
      this.context.bus.emit(this.id, 'voice:error', {
        message: 'Das Mikrofon wird noch vorbereitet. Bitte versuche es gleich noch einmal.',
      });
      return;
    }
    if (this.ttsQueue?.isPaused) {
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
    if (this._voiceState === 'speaking' || this._voiceState === 'processing') {
      const interruptedUnavailableNotice = this.currentUnavailableNoticeTurnId();
      this.interrupt();
      if (interruptedUnavailableNotice) return;
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
    if (this.transitionGeneration === this.voiceGeneration) return;
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
    const generation = this.voiceGeneration;
    const turnId = this.activeInputTurnId;
    this.transition(generation, () => this.stopListeningAndProcess(generation)).catch((error) => {
      this.handleProcessingError(error, turnId, generation);
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
    this.voiceGeneration += 1;
    const turnId = randomUUID();
    this.activeInputTurnId = turnId;
    this.voiceRelevantTurns.set(turnId, 'voice');
    this.turnSpeechDecisions.set(turnId, true);
    this.activeCaptureId = randomUUID();
    this.context.bus.emit(this.id, 'turn:accepted', { turnId, source: 'voice', mode: 'voice' });
    this.sttAbort?.abort();
    this.sttAbort = new AbortController();
    this.setState('listening');
    this.context.bus.emit(this.id, 'voice:listening', {
      turnId,
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

  private async stopListeningAndProcess(generation: number): Promise<void> {
    this.clearSilenceTimer();

    const turnId = this.activeInputTurnId;
    const captureId = this.activeCaptureId;
    const sttSignal = this.sttAbort?.signal;
    if (!turnId || !captureId || !sttSignal) {
      this.setState('idle');
      return;
    }
    this.processingTurnIds.add(turnId);
    try {
      await this.requestCaptureFlush(captureId);
    } catch (error) {
      if (this.activeCaptureId === captureId) {
        this.audio.stopRecording(captureId);
        this.activeInputTurnId = null;
        this.activeCaptureId = null;
      }
      throw error;
    }
    const audioData = this.audio.stopRecording(captureId);
    this.activeInputTurnId = null;
    this.activeCaptureId = null;
    if (audioData.length === 0) {
      this.processingTurnIds.delete(turnId);
      this.voiceRelevantTurns.delete(turnId);
      this.setState('idle');
      this.context.bus.emit(this.id, 'turn:terminal', { turnId, status: 'canceled' });
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
    if (!this.isCurrentVoiceOperation(generation, turnId)) return;
    this.context.bus.emit(this.id, 'perf:timing', {
      turnId,
      label: 'whisper',
      ms: Math.round(performance.now() - sttStart),
      meta: { transcriptLength: transcript?.length ?? 0 },
    });

    if (!transcript || transcript.trim().length === 0) {
      this.handleEmptyTranscript(turnId, generation);
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
      this.processingTurnIds.delete(turnId);
      return;
    }

    if (isAbortPhrase(transcript)) {
      this.context.bus.emit(this.id, 'turn:terminal', { turnId, status: 'canceled' });
      this.processingTurnIds.delete(turnId);
      this.voiceRelevantTurns.delete(turnId);
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
    this.emitUnavailableNotice(CHAT_UNAVAILABLE_MESSAGE, 'llm');
  }

  private rejectUnavailableVoiceInput(): void {
    this.emitUnavailableNotice(STT_UNAVAILABLE_MESSAGE, 'voice');
  }

  private emitUnavailableNotice(message: string, visibleAs: 'llm' | 'voice'): void {
    const turnId = randomUUID();
    this.context.bus.emit(this.id, 'turn:accepted', { turnId, source: 'voice', mode: 'voice' });
    this.processingTurnIds.add(turnId);
    this.voiceRelevantTurns.set(turnId, 'voice');
    this.turnSpeechDecisions.set(turnId, true);
    this.unavailableNoticeTurns.add(turnId);
    this.setState('processing');

    if (visibleAs === 'llm') {
      this.routerErrorTurns.add(turnId);
      this.context.bus.emit(this.id, 'llm:error', { turnId, message });
    } else {
      this.context.bus.emit(this.id, 'voice:error', { turnId, message });
    }

    if (this.capabilities.tts && this.ttsQueue) {
      const output = this.getOrCreateOutput(turnId, randomUUID(), true);
      output.text = message;
      output.complete = true;
      output.failed = true;
      this.enqueueSentences(output, [message]);
    }
    this.context.bus.emit(this.id, 'turn:terminal', {
      turnId,
      status: 'error',
      message,
    });
  }

  private currentUnavailableNoticeTurnId(): TurnId | null {
    const candidates = [
      this.activePlaybackTurnId,
      this.activeOutputTurnId,
      this.processingTurnId,
    ];
    return candidates.find((turnId): turnId is TurnId => (
      turnId !== null && this.unavailableNoticeTurns.has(turnId)
    )) ?? null;
  }

  private interrupt(): void {
    this.cancelActiveWork('Voice interruption');
  }

  private cancelActiveWork(reason: string): void {
    const ownedTurnIds = new Set<TurnId>([
      this.activeInputTurnId,
      this.activePlaybackTurnId,
    ].filter((turnId): turnId is TurnId => Boolean(turnId)));
    for (const turnId of this.processingTurnIds) ownedTurnIds.add(turnId);
    for (const turnId of this.voiceRelevantTurns.keys()) ownedTurnIds.add(turnId);
    for (const output of this.outputs.values()) {
      if (output.shouldSpeak || this.voiceRelevantTurns.has(output.turnId)) {
        ownedTurnIds.add(output.turnId);
      }
    }
    const openTurnIds = [...ownedTurnIds].filter((turnId) => this.context.bus.isTurnOpen(turnId));
    const candidateInterruptedTurnId = this.activeInputTurnId
      ?? this.processingTurnId
      ?? this.activeOutputTurnId
      ?? this.activePlaybackTurnId;
    const interruptedTurnId = candidateInterruptedTurnId
      && ownedTurnIds.has(candidateInterruptedTurnId)
      ? candidateInterruptedTurnId
      : null;
    this.voiceGeneration += 1;
    this.transitionGeneration = null;
    this.sttAbort?.abort();
    this.sttAbort = null;
    this.ttsQueue?.stop();
    this.activePlaybackTurnId = null;
    this.activePlaybackId = null;
    this.activeInputTurnId = null;
    if (this.activeCaptureId) {
      this.rejectCaptureFlush(this.activeCaptureId, new Error(reason));
    }
    this.activeCaptureId = null;
    this.deferredSentences = this.deferredSentences.filter(
      (item) => !ownedTurnIds.has(item.turnId),
    );
    for (const turnId of ownedTurnIds) {
      this.processingTurnIds.delete(turnId);
      this.voiceRelevantTurns.delete(turnId);
      this.turnSpeechDecisions.delete(turnId);
      this.removeTurnOutputs(turnId);
      this.spokenTurns.delete(turnId);
      this.prioritySpeechTurns.delete(turnId);
      this.routerErrorTurns.delete(turnId);
      this.unavailableNoticeTurns.delete(turnId);
    }
    this.tts.stop();
    this.audio.setPlaying(false);
    if (this.audio.isRecording) this.audio.stopRecording();
    for (const turnId of openTurnIds) {
      this.context.bus.emit(this.id, 'turn:cancel', { turnId, reason });
      this.context.bus.emit(this.id, 'turn:terminal', { turnId, status: 'canceled' });
    }
    if (interruptedTurnId) {
      this.context.bus.emit(this.id, 'voice:interrupted', { turnId: interruptedTurnId });
    }
    this.setState('idle');
  }

  /** Drops superseded paused speech while preserving the newly routed input turn. */
  private discardPausedSpeech(preserveTurnId: TurnId, reason: string): void {
    const ownedTurnIds = new Set<TurnId>();
    for (const turnId of this.processingTurnIds) ownedTurnIds.add(turnId);
    for (const turnId of this.voiceRelevantTurns.keys()) ownedTurnIds.add(turnId);
    for (const turnId of this.spokenTurns) ownedTurnIds.add(turnId);
    for (const output of this.outputs.values()) ownedTurnIds.add(output.turnId);
    for (const item of this.deferredSentences) ownedTurnIds.add(item.turnId);
    if (this.activePlaybackTurnId) ownedTurnIds.add(this.activePlaybackTurnId);
    ownedTurnIds.delete(preserveTurnId);
    for (const turnId of this.prioritySpeechTurns) ownedTurnIds.delete(turnId);

    const interruptedTurnId = this.activeOutputTurnId
      ?? this.activePlaybackTurnId
      ?? ownedTurnIds.values().next().value as TurnId | undefined;

    this.ttsQueue?.stop();
    this.audio.setPlaying(false);
    this.activePlaybackTurnId = null;
    this.activePlaybackId = null;
    this.deferredSentences = this.deferredSentences.filter(
      (item) => item.turnId === preserveTurnId,
    );

    for (const turnId of ownedTurnIds) {
      this.processingTurnIds.delete(turnId);
      this.voiceRelevantTurns.delete(turnId);
      this.turnSpeechDecisions.delete(turnId);
      this.removeTurnOutputs(turnId);
      this.spokenTurns.delete(turnId);
      this.prioritySpeechTurns.delete(turnId);
      this.routerErrorTurns.delete(turnId);
      this.unavailableNoticeTurns.delete(turnId);
      if (this.context.bus.isTurnOpen(turnId)) {
        this.context.bus.emit(this.id, 'turn:cancel', { turnId, reason });
        this.context.bus.emit(this.id, 'turn:terminal', { turnId, status: 'canceled' });
      }
    }
    for (const turnId of this.prioritySpeechTurns) this.tryCompleteSpokenTurn(turnId);
    if (interruptedTurnId && interruptedTurnId !== preserveTurnId) {
      this.context.bus.emit(this.id, 'voice:interrupted', { turnId: interruptedTurnId });
    }
    this.restoreOwnedVoiceState();
  }

  // --- VAD (Voice Activity Detection) ---

  private checkSilence(chunk: Float32Array): void {
    const rms = this.computeRms(chunk);

    if (rms < SILENCE_RMS_THRESHOLD) {
      if (!this.silenceTimer) {
        const generation = this.voiceGeneration;
        const turnId = this.activeInputTurnId;
        this.silenceTimer = setTimeout(() => {
          this.silenceTimer = null;
          this.transition(generation, () => this.stopListeningAndProcess(generation)).catch((error) => {
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

  private handleEmptyTranscript(turnId: TurnId, generation: number): void {
    if (!this.isCurrentVoiceOperation(generation, turnId)) return;
    this.clearSilenceTimer();
    this.clearConversationTimer();
    this.processingTurnIds.delete(turnId);
    this.voiceRelevantTurns.delete(turnId);
    this.turnSpeechDecisions.delete(turnId);
    this.setState('idle');
    this.context.bus.emit(this.id, 'turn:terminal', { turnId, status: 'canceled' });
  }

  private handleProcessingError(
    value: unknown,
    turnId: TurnId | null,
    generation: number,
  ): void {
    const error = value instanceof Error ? value : new Error(String(value));
    if (error.name === 'AbortError') return;
    if (!turnId || !this.isCurrentVoiceOperation(generation, turnId)) return;
    const message = error.name === 'TimeoutError'
      ? 'Die Spracherkennung hat zu lange gebraucht. Bitte versuche es erneut.'
      : 'Die Spracheingabe konnte nicht verarbeitet werden.';
    this.processingTurnIds.delete(turnId);
    this.voiceRelevantTurns.delete(turnId);
    this.turnSpeechDecisions.delete(turnId);
    this.setState('idle');
    this.context.bus.emit(this.id, 'voice:error', {
      turnId,
      message,
    });
    this.context.bus.emit(this.id, 'turn:terminal', { turnId, status: 'error', message });
  }

  private isCurrentVoiceOperation(generation: number, turnId: TurnId): boolean {
    return generation === this.voiceGeneration
      && this.processingTurnIds.has(turnId)
      && this.context.bus.isTurnOpen(turnId);
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
