// src/services/voice/voice-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
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
import { throwIfAborted } from '../../core/abort-utils.js';
import { randomUUID } from 'crypto';
import type { OutputId, PlaybackId, TurnId, VoiceCaptureId } from '../../core/turn-contract.js';
import type { BusEvents } from '../../core/bus-events.js';
import {
  type VoiceState,
  type VoiceMode,
  type InteractionMode,
  DEFAULT_PTT_KEY,
  normalizeVoiceMode,
} from './voice-types.js';
import { VoiceCaptureFlush } from './voice-capture-flush.js';
import type { VoiceOutputLifecycle } from './voice-output-store.js';
import { initializeVoiceProvider } from './voice-provider-startup.js';
import { VoiceInputFlow } from './voice-input-flow.js';
import { VoiceSpeechFlow } from './voice-speech-flow.js';

type VoiceTurnMode = 'voice' | 'chatspeak';

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

  private rendererAvailable = true;
  private rendererCaptureReady = false;
  private rendererCaptureHotkeyReconcilePending = false;
  private rendererCaptureHotkeySuspended = false;

  private sttAvailabilityUnsub: (() => void) | null = null;
  private ttsAvailabilityUnsub: (() => void) | null = null;
  private readonly processingTurnIds = new Set<TurnId>();
  private readonly voiceRelevantTurns = new Map<TurnId, VoiceTurnMode>();
  private readonly turnSpeechDecisions = new Map<TurnId, boolean>();
  private readonly unavailableNoticeTurns = new Set<TurnId>();
  private readonly captureFlush: VoiceCaptureFlush;
  private readonly inputFlow: VoiceInputFlow;
  private readonly speechFlow: VoiceSpeechFlow;

  constructor(
    private context: AppContext,
    private stt: SttProvider,
    private tts: TtsProvider,
    private wakeWord: WakeWordProvider,
    private audio: AudioManager,
    private hotkey: HotkeyManager,
  ) {
    this.captureFlush = new VoiceCaptureFlush((captureId) => {
      this.context.bus.emit(this.id, 'voice:capture-flush-request', { captureId });
    });
    this.speechFlow = new VoiceSpeechFlow(this.context, this.tts, this.audio, {
      getVoiceMode: () => this.voiceMode,
      getVoiceState: () => this._voiceState,
      isRendererAvailable: () => this.rendererAvailable,
      isTtsAvailable: () => this.capabilities.tts,
      shouldSpeak: (turnId, forceSpeak) => this.shouldSpeak(turnId, forceSpeak),
      shouldSpeakError: (turnId, outputRequestedSpeech) => (
        this.turnSpeechDecisions.get(turnId)
        ?? (
          this.voiceMode !== 'off'
          && (this.voiceRelevantTurns.has(turnId) || outputRequestedSpeech)
        )
      ),
      isTurnOwned: (turnId, hasOutput) => (
        this.processingTurnIds.has(turnId)
        || this.voiceRelevantTurns.has(turnId)
        || this.turnSpeechDecisions.has(turnId)
        || hasOutput
      ),
      removeProcessingTurn: (turnId) => { this.processingTurnIds.delete(turnId); },
      setState: (state) => { this.setState(state); },
      restoreOwnedVoiceState: () => { this.restoreOwnedVoiceState(); },
      resumeKeywordConversation: () => this.inputFlow.resumeKeywordConversation(),
      onSpeechTurnDone: (turnId) => { this.onSpeechTurnDone(turnId); },
    });
    this.inputFlow = new VoiceInputFlow(
      this.context,
      this.stt,
      this.wakeWord,
      this.audio,
      this.captureFlush,
      {
        getVoiceMode: () => this.voiceMode,
        getVoiceState: () => this._voiceState,
        isRendererCaptureReady: () => this.rendererCaptureReady,
        isSttAvailable: () => this.capabilities.stt,
        isSpeechPaused: () => this.speechFlow.isPaused,
        hasUnavailableNotice: () => this.currentUnavailableNoticeTurnId() !== null,
        canAcceptConversation: () => this.canAcceptConversation(),
        interrupt: () => { this.interrupt(); },
        rejectUnavailableConversation: () => { this.rejectUnavailableConversation(); },
        rejectUnavailableVoiceInput: () => { this.rejectUnavailableVoiceInput(); },
        setState: (state) => { this.setState(state); },
        registerVoiceTurn: (turnId) => {
          this.voiceRelevantTurns.set(turnId, 'voice');
          this.turnSpeechDecisions.set(turnId, true);
        },
        markTurnProcessing: (turnId) => { this.processingTurnIds.add(turnId); },
        releaseTurn: (turnId) => {
          this.processingTurnIds.delete(turnId);
          this.voiceRelevantTurns.delete(turnId);
          this.turnSpeechDecisions.delete(turnId);
        },
        removeProcessingTurn: (turnId) => { this.processingTurnIds.delete(turnId); },
        isTurnOpen: (turnId) => this.context.bus.isTurnOpen(turnId),
      },
    );
  }

  private get activeInputTurnId(): TurnId | null {
    return this.inputFlow.activeInputTurnId;
  }

  private get activeCaptureId(): VoiceCaptureId | null {
    return this.inputFlow.activeCaptureId;
  }

  get voiceState(): VoiceState {
    return this._voiceState;
  }

  get voiceStateSnapshot(): BusEvents['voice:state'] {
    return this.createStateSnapshot(this._voiceState);
  }

  /** Whether normal speech is currently held behind a priority barrier. */
  get isSpeechPaused(): boolean {
    return this.speechFlow.isPaused;
  }

  /** Compatibility snapshot for diagnostics/tests; productive ownership lives in the sets/maps. */
  private get processingTurnId(): TurnId | null {
    return this.lastSetValue(this.processingTurnIds);
  }

  private get outputs(): Map<OutputId, VoiceOutputLifecycle> {
    return this.speechFlow.outputs;
  }

  private get activeOutput(): VoiceOutputLifecycle | null {
    return this.speechFlow.activeOutput;
  }

  private get activeOutputTurnId(): TurnId | null {
    return this.activeOutput?.turnId ?? null;
  }

  private get activeOutputText(): string {
    return this.speechFlow.activeOutputText;
  }

  private get llmStreaming(): boolean {
    return this.speechFlow.llmStreaming;
  }

  private get activePlaybackTurnId(): TurnId | null {
    return this.speechFlow.activePlaybackTurnId;
  }

  private get activePlaybackId(): PlaybackId | null {
    return this.speechFlow.activePlaybackId;
  }

  private get ttsQueue() {
    return this.speechFlow.ttsQueue;
  }

  private get deferredSentences() {
    return this.speechFlow.deferredSentences;
  }

  private shouldSpeak(turnId: TurnId, forceSpeak?: boolean): boolean {
    return forceSpeak
      ?? this.turnSpeechDecisions.get(turnId)
      ?? (
        this.voiceMode !== 'off'
        && (this.voiceRelevantTurns.has(turnId) || this.interactionMode !== 'chat')
      );
  }

  /** Ends only the listening turn that owns a failed renderer capture. */
  handleCaptureFailure(captureId: VoiceCaptureId | undefined, message: string): void {
    this.inputFlow.handleCaptureFailure(captureId, message);
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
    } else if (this.speechFlow.isActive) {
      this.speechFlow.stopRendererAudio();
    }
  }

  /** Completes the exact renderer capture whose worklet and IPC tail were flushed. */
  handleCaptureFlushed(captureId: VoiceCaptureId): void {
    this.captureFlush.resolve(captureId);
  }

  setInteractionMode(mode: InteractionMode): void {
    this.interactionMode = mode;
  }

  setRendererCaptureReady(ready: boolean): void {
    this.rendererAvailable = true;
    this.speechFlow.flushDeferredSentences();
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
    if (wasListening && state !== 'listening') this.speechFlow.flushDeferredSentences();
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
    await initializeVoiceProvider({
      provider: this.stt,
      signal,
      providerLabel: 'STT',
      traceLabel: 'whisper',
      cleanupAfterFailure: !this.stt.recoversAfterInitFailure,
      onAvailable: () => this.applySttAvailability({ available: true }),
      onUnavailable: (message) => this.context.lifecycle?.setCapability('stt', 'unavailable', message),
    });
    await initializeVoiceProvider({
      provider: this.tts,
      signal,
      providerLabel: 'TTS',
      traceLabel: 'piper',
      cleanupAfterFailure: true,
      onAvailable: () => this.applyTtsAvailability({ available: true }),
      onUnavailable: (message) => this.context.lifecycle?.setCapability('tts', 'unavailable', message),
    });

    throwIfAborted(signal);
    this.setupMode();

    if (this.capabilities.tts) this.speechFlow.start();

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

    attempt(() => this.sttAvailabilityUnsub?.());
    this.sttAvailabilityUnsub = null;
    attempt(() => this.ttsAvailabilityUnsub?.());
    this.ttsAvailabilityUnsub = null;
    attempt(() => this.speechFlow.destroy());
    this.inputFlow.destroy();
    this.processingTurnIds.clear();
    this.voiceRelevantTurns.clear();
    this.turnSpeechDecisions.clear();
    this.unavailableNoticeTurns.clear();
    this.captureFlush.rejectAll(new Error('Voice service stopped'));

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
    return this.inputFlow.feedAudioChunk(captureId, chunk);
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

    if (msg.topic === 'voice:discard-paused-speech') {
      if (!this.speechFlow.isPaused) return;
      this.discardPausedSpeech(msg.data.preserveTurnId, msg.data.reason);
      return;
    }

    if (msg.topic === 'turn:terminal') {
      const turnId = msg.data.turnId;
      this.processingTurnIds.delete(turnId);
      if (msg.data.status === 'canceled') {
        const ownsInput = this.activeInputTurnId === turnId;
        if (ownsInput) this.inputFlow.releaseInputTurn(turnId, 'Turn canceled');
        this.speechFlow.handleTurnTerminal(turnId, msg.data.status);
        this.voiceRelevantTurns.delete(turnId);
        this.turnSpeechDecisions.delete(turnId);
        this.unavailableNoticeTurns.delete(turnId);
      } else {
        const stillSpeaking = this.speechFlow.handleTurnTerminal(turnId, msg.data.status);
        if (!stillSpeaking) {
          this.voiceRelevantTurns.delete(turnId);
          this.turnSpeechDecisions.delete(turnId);
          this.unavailableNoticeTurns.delete(turnId);
        }
      }
      this.restoreOwnedVoiceState();
      return;
    }

    this.speechFlow.handleMessage(msg);
  }

  /** Rejects only the renderer playback that still owns the correlated audio item. */
  handlePlaybackFailure(
    turnId: TurnId,
    playbackId: PlaybackId,
    message: string,
    stopRemaining = false,
  ): void {
    this.speechFlow.handlePlaybackFailure(turnId, playbackId, message, stopRemaining);
  }

  private lastSetValue<T>(values: Set<T>): T | null {
    let result: T | null = null;
    for (const value of values) result = value;
    return result;
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

  private onSpeechTurnDone(turnId: TurnId): void {
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
    this.inputFlow.resetForConfig();
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
    this.inputFlow.startWakeWordListening();
  }

  // --- PTT handlers ---

  onPttDown(): void {
    this.inputFlow.onPttDown();
  }

  onPttUp(): void {
    this.inputFlow.onPttUp();
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
      this.speechFlow.markRouterError(turnId);
      this.context.bus.emit(this.id, 'llm:error', { turnId, message });
    } else {
      this.context.bus.emit(this.id, 'voice:error', { turnId, message });
    }

    if (this.capabilities.tts && this.ttsQueue) {
      this.speechFlow.speakNotice(turnId, message);
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
    this.inputFlow.abort(reason);
    this.speechFlow.stopAll();
    this.speechFlow.removeTurns(ownedTurnIds);
    for (const turnId of ownedTurnIds) {
      this.processingTurnIds.delete(turnId);
      this.voiceRelevantTurns.delete(turnId);
      this.turnSpeechDecisions.delete(turnId);
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
    for (const turnId of this.speechFlow.spokenTurnIds) ownedTurnIds.add(turnId);
    for (const output of this.outputs.values()) ownedTurnIds.add(output.turnId);
    for (const item of this.deferredSentences) ownedTurnIds.add(item.turnId);
    if (this.activePlaybackTurnId) ownedTurnIds.add(this.activePlaybackTurnId);
    ownedTurnIds.delete(preserveTurnId);
    for (const turnId of this.speechFlow.priorityTurnIds) ownedTurnIds.delete(turnId);

    const interruptedTurnId = this.activeOutputTurnId
      ?? this.activePlaybackTurnId
      ?? ownedTurnIds.values().next().value as TurnId | undefined;

    this.speechFlow.stopAll();
    this.speechFlow.retainDeferredTurn(preserveTurnId);
    this.speechFlow.removeTurns(ownedTurnIds);

    for (const turnId of ownedTurnIds) {
      this.processingTurnIds.delete(turnId);
      this.voiceRelevantTurns.delete(turnId);
      this.turnSpeechDecisions.delete(turnId);
      this.unavailableNoticeTurns.delete(turnId);
      if (this.context.bus.isTurnOpen(turnId)) {
        this.context.bus.emit(this.id, 'turn:cancel', { turnId, reason });
        this.context.bus.emit(this.id, 'turn:terminal', { turnId, status: 'canceled' });
      }
    }
    this.speechFlow.completePriorityTurns();
    if (interruptedTurnId && interruptedTurnId !== preserveTurnId) {
      this.context.bus.emit(this.id, 'voice:interrupted', { turnId: interruptedTurnId });
    }
    this.restoreOwnedVoiceState();
  }

}
