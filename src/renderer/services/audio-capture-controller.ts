import type { AudioConfig } from '../../core/config-schema.js';
import type { SarahApi } from '../../core/sarah-api.js';
import type { VoiceCaptureId } from '../../core/turn-contract.js';
import type { EffectiveVoiceMode } from '../../services/voice/voice-types.js';
import { computeEffectiveGain, decideCaptureReset, isCaptureConfigEqual } from './audio-bridge-logic.js';
import { isAudioOperationAborted, waitForAudioOperation } from './audio-operation.js';

declare const sarah: SarahApi;

const CAPTURE_SAMPLE_RATE = 16_000;
const GAIN_RAMP_TIME_CONSTANT = 0.015;
const CAPTURE_RESUME_TIMEOUT_MS = 3000;
const CAPTURE_WORKLET_TIMEOUT_MS = 5000;
const CAPTURE_DEVICE_TIMEOUT_MS = 10_000;
const CAPTURE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const WORKLET_MODULE_URL = 'dist/renderer/services/audio-worklet-processor.js';
const CAPTURE_FAILED_MESSAGE =
  'Mikrofon konnte nicht gestartet werden. Bitte Berechtigung und Audiogerät prüfen.';
const CAPTURE_LOST_MESSAGE =
  'Die Mikrofonverbindung wurde unterbrochen. Bitte Audiogerät prüfen und erneut versuchen.';

/**
 * Owns the renderer microphone graph and capture recovery lifecycle.
 *
 * @category Service
 */
export class AudioCaptureController {
  private captureCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private captureGain: GainNode | null = null;
  private capturing = false;
  private workletLoaded = false;
  private recording = false;
  private currentCaptureId: VoiceCaptureId | null = null;
  private activeInputDeviceId: string | undefined = undefined;
  private preferredInputRecoveryPending = false;
  private voiceMode: EffectiveVoiceMode = 'off';
  private sttAvailable = false;
  private reportedCaptureReady: boolean | null = null;
  private currentAudio: AudioConfig | undefined = undefined;
  private currentInputDeviceId: string | undefined = undefined;
  private muted = false;
  private started = false;
  private destroyed = false;
  private captureGeneration = 0;
  private captureStartPromise: Promise<boolean> | null = null;
  private readonly captureStartPromises = new Set<Promise<boolean>>();
  private captureSetupAbort: AbortController | null = null;
  private captureStateResumeAbort: AbortController | null = null;
  private captureStateResumePromise: Promise<void> | null = null;
  private captureContextStateListener: { context: AudioContext; handler: () => void } | null = null;
  private captureRecoveryPromise: Promise<void> | null = null;
  private captureRecoveryPending = false;
  private captureRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private captureRetryAttempt = 0;
  private captureLifecyclePromise: Promise<void> = Promise.resolve();
  private readonly captureIpcTails = new Map<VoiceCaptureId, Promise<void>>();
  private readonly deviceChangeHandler = (): void => { void this.handleMediaDevicesChanged(); };

  constructor(
    private readonly stopOutput: () => void,
    private readonly onDevicesChanged: (devices: MediaDeviceInfo[]) => void,
  ) {}

  get context(): AudioContext | null { return this.captureCtx; }
  get mediaStream(): MediaStream | null { return this.stream; }
  get isCapturing(): boolean { return this.capturing; }
  get isRecording(): boolean { return this.recording; }
  get captureId(): VoiceCaptureId | null { return this.currentCaptureId; }
  get inputDeviceId(): string | undefined { return this.activeInputDeviceId; }
  get lifecyclePromise(): Promise<void> { return this.captureLifecyclePromise; }
  get ipcTails(): Map<VoiceCaptureId, Promise<void>> { return this.captureIpcTails; }

  rememberAudioConfig(audio: AudioConfig): void {
    this.currentAudio = audio;
    this.currentInputDeviceId = audio.inputDeviceId;
    this.muted = audio.inputMuted;
  }

  setVoiceMode(mode: EffectiveVoiceMode): Promise<void> {
    const shouldResetRetry = this.voiceMode === 'off' && mode !== 'off';
    this.voiceMode = mode;
    if (shouldResetRetry) this.resetCaptureRetry();
    return this.started ? this.reconcileVoiceInputLifecycle() : Promise.resolve();
  }

  setSttAvailable(available: boolean): Promise<void> {
    const shouldResetRetry = !this.sttAvailable && available;
    this.sttAvailable = available;
    if (shouldResetRetry) this.resetCaptureRetry();
    return this.started ? this.reconcileVoiceInputLifecycle() : Promise.resolve();
  }

  start(): Promise<void> {
    this.started = true;
    return this.reconcileVoiceInputLifecycle();
  }

  subscribeDeviceChanges(): void {
    navigator.mediaDevices.addEventListener?.('devicechange', this.deviceChangeHandler);
  }

  async applyAudioConfig(audio: AudioConfig): Promise<void> {
    if (this.destroyed || !this.started || isCaptureConfigEqual(this.currentAudio, audio)) return;
    const previousDeviceId = this.currentInputDeviceId;
    const captureWasActive = this.recording || this.currentCaptureId !== null;
    this.currentAudio = audio;
    this.currentInputDeviceId = audio.inputDeviceId;
    this.muted = audio.inputMuted;
    if (previousDeviceId !== audio.inputDeviceId) this.resetCaptureRetry();
    const decision = decideCaptureReset(previousDeviceId, audio.inputDeviceId, this.capturing);
    if (decision !== 'reset') {
      this.rampCaptureGain();
      return;
    }
    await this.reportCaptureReady(false);
    const failedCaptureId = captureWasActive ? this.currentCaptureId ?? undefined : undefined;
    if (failedCaptureId) {
      this.recording = false;
      this.currentCaptureId = null;
      this.cancelRendererCapture(failedCaptureId);
    }
    this.stopCapture();
    this.workletLoaded = false;
    if (this.captureCtx) {
      await this.captureCtx.close().catch(() => undefined);
      this.captureCtx = null;
    }
    if (failedCaptureId) {
      await sarah.voice.captureFailed(failedCaptureId, CAPTURE_LOST_MESSAGE).catch((error) => {
        console.error('[AudioBridge] Device-switch capture loss could not be reported:', error);
      });
    }
    if (this.shouldKeepCaptureWarm() || captureWasActive) {
      const ready = await this.startCapture();
      await this.reportCaptureReady(ready);
    }
  }

  private rampCaptureGain(): void {
    if (!this.captureGain || !this.captureCtx || !this.currentAudio) return;
    const target = computeEffectiveGain(this.currentAudio);
    this.captureGain.gain.setTargetAtTime(
      target,
      this.captureCtx.currentTime,
      GAIN_RAMP_TIME_CONSTANT,
    );
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.resetCaptureRetry();
    const failedCaptureId = this.currentCaptureId;
    const report = failedCaptureId
      ? sarah.voice.captureFailed(failedCaptureId, CAPTURE_LOST_MESSAGE).catch((error) => {
        console.warn('[AudioBridge] Active capture teardown could not be reported:', error);
      })
      : Promise.resolve();
    if (failedCaptureId) this.cancelRendererCapture(failedCaptureId);
    this.captureIpcTails.clear();
    this.recording = false;
    this.currentCaptureId = null;
    this.stopCapture();
    await this.reportCaptureReady(false);
    await report;
    await this.captureLifecyclePromise.catch(() => undefined);
    await Promise.allSettled([...this.captureStartPromises]);
    await this.captureStateResumePromise?.catch(() => undefined);
    await this.captureRecoveryPromise?.catch(() => undefined);
    navigator.mediaDevices.removeEventListener?.('devicechange', this.deviceChangeHandler);
    if (this.captureCtx) {
      await this.captureCtx.close();
      this.captureCtx = null;
      this.workletLoaded = false;
    }
  }

  handleStateChange(state: string, captureId?: VoiceCaptureId): void {
    if (state === 'listening') {
      this.currentCaptureId = captureId ?? null;
      this.stopOutput();
      this.recording = false;
      if (!captureId) {
        void sarah.voice.captureFailed(
          undefined,
          'Sprachaufnahme konnte nicht gestartet werden, weil die Aufnahme-ID fehlt.',
        );
        return;
      }
      if (this.isCaptureReady()) {
        this.recording = true;
        this.workletNode?.port.postMessage({ type: 'begin', captureId });
      } else {
        // Normally unreachable because main keeps PTT disabled until the warm
        // graph is acknowledged. Keep a safe recovery path for a mid-start
        // state snapshot without ever forwarding audio from before key-down.
        void this.startCapture().then((ready) => {
          if (ready && this.currentCaptureId === captureId) {
            this.recording = true;
            this.workletNode?.port.postMessage({ type: 'begin', captureId });
          }
        });
      }
    } else {
      // Any non-listening state: stop streaming this utterance but keep the mic
      // warm. Capture is torn down only by destroy() and the device-change reset
      // path in applyAudioConfig.
      const previousCaptureId = this.currentCaptureId;
      this.recording = false;
      this.currentCaptureId = null;
      if (previousCaptureId) this.cancelRendererCapture(previousCaptureId);
      if (state === 'idle' || state === 'processing') this.stopOutput();
      if (this.preferredInputRecoveryPending) {
        this.preferredInputRecoveryPending = false;
        this.scheduleCaptureRecovery();
      }
    }
  }

  private shouldKeepCaptureWarm(): boolean {
    return this.sttAvailable && this.voiceMode !== 'off';
  }

  private isCaptureReady(): boolean {
    const tracks = this.stream?.getTracks() ?? [];
    return this.capturing
      && this.captureStartPromise === null
      && this.captureCtx?.state === 'running'
      && this.stream !== null
      && this.workletNode !== null
      && tracks.length > 0
      && tracks.every((track) => track.readyState === 'live');
  }

  private async reportCaptureReady(ready: boolean): Promise<void> {
    if (this.reportedCaptureReady === ready) return;
    this.reportedCaptureReady = ready;
    await sarah.voice.setCaptureReady(ready).catch((error) => {
      if (this.reportedCaptureReady === ready) this.reportedCaptureReady = null;
      console.error('[AudioBridge] Capture readiness could not be reported:', error);
    });
  }

  reconcileVoiceInputLifecycle(): Promise<void> {
    this.captureLifecyclePromise = this.captureLifecyclePromise.then(async () => {
      if (this.destroyed) return;
      if (!this.shouldKeepCaptureWarm()) {
        this.resetCaptureRetry();
        await this.reportCaptureReady(false);
        this.recording = false;
        this.currentCaptureId = null;
        await this.closeCaptureGraph();
        return;
      }
      const ready = await this.startCapture();
      await this.reportCaptureReady(ready);
      if (ready) this.resetCaptureRetry();
      else this.scheduleCaptureRetry();
    }, async () => {
      if (!this.destroyed) {
        await this.reportCaptureReady(false);
        this.scheduleCaptureRetry();
      }
    });
    return this.captureLifecyclePromise;
  }


  private resetCaptureRetry(): void {
    if (this.captureRetryTimer) clearTimeout(this.captureRetryTimer);
    this.captureRetryTimer = null;
    this.captureRetryAttempt = 0;
  }

  private scheduleCaptureRetry(): void {
    if (
      this.destroyed
      || !this.shouldKeepCaptureWarm()
      || this.captureRetryTimer
      || this.captureRetryAttempt >= CAPTURE_RETRY_DELAYS_MS.length
    ) return;

    const delay = CAPTURE_RETRY_DELAYS_MS[this.captureRetryAttempt];
    this.captureRetryAttempt += 1;
    this.captureRetryTimer = setTimeout(() => {
      this.captureRetryTimer = null;
      if (!this.destroyed && this.shouldKeepCaptureWarm()) {
        void this.reconcileVoiceInputLifecycle();
      }
    }, delay);
  }

  private async startCapture(): Promise<boolean> {
    // Teardown races: destroy() latches first, so a startCapture scheduled
    // from an in-flight apply must not allocate a new graph behind it.
    if (this.destroyed) return false;
    if (this.isCaptureReady()) return true;
    if (this.capturing) return this.captureStartPromise ?? Promise.resolve(false);
    this.capturing = true;
    const generation = ++this.captureGeneration;
    const deviceId = this.currentInputDeviceId;
    const controller = new AbortController();
    this.captureSetupAbort = controller;
    const startPromise = this.initializeCapture(generation, deviceId, controller.signal);
    this.captureStartPromise = startPromise;
    this.captureStartPromises.add(startPromise);
    try {
      return await startPromise;
    } finally {
      this.captureStartPromises.delete(startPromise);
      if (this.captureStartPromise === startPromise) this.captureStartPromise = null;
      if (this.captureSetupAbort === controller) this.captureSetupAbort = null;
    }
  }

  private async initializeCapture(
    generation: number,
    deviceId: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    let context: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let captureGain: GainNode | null = null;
    let workletNode: AudioWorkletNode | null = null;

    const disposeLocal = async (): Promise<void> => {
      workletNode?.disconnect();
      captureGain?.disconnect();
      sourceNode?.disconnect();
      for (const track of stream?.getTracks() ?? []) track.stop();
      await context?.close().catch(() => {
        /* ignore cleanup failures */
      });
    };
    const isStale = (): boolean => this.destroyed || generation !== this.captureGeneration;

    try {
      context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
      const captureContext = context;
      if (captureContext.state === 'suspended') {
        await waitForAudioOperation(
          captureContext.resume(),
          signal,
          CAPTURE_RESUME_TIMEOUT_MS,
          'Microphone AudioContext resume timed out',
        );
      }
      if (isStale()) {
        await disposeLocal();
        return false;
      }

      await waitForAudioOperation(
        captureContext.audioWorklet.addModule(WORKLET_MODULE_URL),
        signal,
        CAPTURE_WORKLET_TIMEOUT_MS,
        'Microphone AudioWorklet setup timed out',
      );
      if (isStale()) {
        await disposeLocal();
        return false;
      }

      stream = await waitForAudioOperation(
        this.acquireMicStream(deviceId),
        signal,
        CAPTURE_DEVICE_TIMEOUT_MS,
        'Microphone acquisition timed out',
        (lateStream) => {
          for (const track of lateStream.getTracks()) track.stop();
        },
      );
      if (isStale()) {
        await disposeLocal();
        return false;
      }
      for (const track of stream.getTracks()) {
        track.addEventListener?.('ended', () => {
          if (!isStale()) this.scheduleCaptureRecovery();
        }, { once: true });
      }

      sourceNode = captureContext.createMediaStreamSource(stream);
      captureGain = captureContext.createGain();
      captureGain.gain.value = this.currentAudio ? computeEffectiveGain(this.currentAudio) : 1;
      workletNode = new AudioWorkletNode(captureContext, 'capture-processor');
      workletNode.port.onmessage = (event: MessageEvent<
        | { type: 'chunk'; captureId: VoiceCaptureId; samples: Float32Array }
        | { type: 'flushed'; captureId: VoiceCaptureId }
      >) => {
        if (isStale()) return;
        const message = event.data;
        if (message.type === 'chunk') {
          if (message.captureId !== this.currentCaptureId || this.muted) return;
          this.enqueueCaptureChunk(message.captureId, message.samples);
          return;
        }
        void this.finishCaptureFlush(message.captureId);
      };

      sourceNode.connect(captureGain);
      captureGain.connect(workletNode);
      workletNode.connect(captureContext.destination);
      if (isStale()) {
        await disposeLocal();
        return false;
      }

      this.captureCtx = captureContext;
      this.stream = stream;
      this.sourceNode = sourceNode;
      this.captureGain = captureGain;
      this.workletNode = workletNode;
      this.workletLoaded = true;
      this.attachCaptureContextStateListener(captureContext, generation);
      this.activeInputDeviceId = stream.getTracks()
        .map((track) => track.getSettings().deviceId)
        .find(Boolean);
      this.resetCaptureRetry();
      if (captureContext.state !== 'running') {
        this.handleCaptureContextStateChange(captureContext, generation);
        return false;
      }
      return true;
    } catch (err) {
      await disposeLocal();
      const error = err instanceof Error ? err : new Error(String(err));
      if (isStale() || isAudioOperationAborted(error)) return false;
      console.error('[AudioBridge] Capture failed:', err);
      this.capturing = false;
      this.recording = false;
      const failedCaptureId = this.currentCaptureId ?? undefined;
      this.currentCaptureId = null;
      await sarah.voice.captureFailed(failedCaptureId, CAPTURE_FAILED_MESSAGE).catch((reportError) => {
        console.error('[AudioBridge] Capture failure could not be reported:', reportError);
      });
      await this.reportCaptureReady(false);
      return false;
    }
  }

  /**
   * Resolve a MediaStream for the currently-configured input device. If the
   * stored device id is no longer valid (unplugged mic), `getUserMedia` throws
   * an OverconstrainedError. Retry once without the deviceId constraint so the
   * user isn't locked out — the stored id stays intact so a re-plug auto-heals
   * on the next capture cycle.
   */
  private async acquireMicStream(deviceId: string | undefined): Promise<MediaStream> {
    const baseConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: CAPTURE_SAMPLE_RATE,
    };

    if (deviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { ...baseConstraints, deviceId: { exact: deviceId } },
        });
      } catch (err) {
        if (isDeviceUnavailableError(err)) {
          console.warn(
            `[AudioBridge] inputDeviceId="${deviceId}" unavailable, falling back to default mic`,
          );
          return await navigator.mediaDevices.getUserMedia({ audio: baseConstraints });
        }
        throw err;
      }
    }
    return await navigator.mediaDevices.getUserMedia({ audio: baseConstraints });
  }

  private async handleMediaDevicesChanged(): Promise<void> {
    if (this.destroyed) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.onDevicesChanged(devices);

      if (!this.capturing || !this.stream) return;
      const tracks = this.stream.getTracks();
      if (tracks.some((track) => track.readyState === 'ended')) {
        this.scheduleCaptureRecovery();
        return;
      }

      const activeDeviceId = this.activeInputDeviceId
        ?? tracks.map((track) => track.getSettings().deviceId).find(Boolean);
      const desiredDeviceId = this.currentInputDeviceId;
      const activeStillPresent = !activeDeviceId || devices.some((device) => (
        device.kind === 'audioinput' && device.deviceId === activeDeviceId
      ));

      if (!activeStillPresent) {
        this.scheduleCaptureRecovery();
        return;
      }

      const preferredReturned = Boolean(
        desiredDeviceId
        && desiredDeviceId !== activeDeviceId
        && devices.some((device) => (
          device.kind === 'audioinput' && device.deviceId === desiredDeviceId
        )),
      );
      if (preferredReturned) {
        if (this.recording) this.preferredInputRecoveryPending = true;
        else this.scheduleCaptureRecovery();
      }
    } catch (error) {
      console.warn('[AudioBridge] Audio device change could not be inspected:', error);
    }
  }

  private scheduleCaptureRecovery(): void {
    if (this.destroyed) return;
    if (this.captureRecoveryPromise) {
      this.captureRecoveryPending = true;
      return;
    }
    this.captureRecoveryPending = false;
    void this.reportCaptureReady(false);
    const failedCaptureId = this.recording ? this.currentCaptureId ?? undefined : undefined;
    this.captureRecoveryPromise = this.recoverCapture(failedCaptureId).finally(() => {
      this.captureRecoveryPromise = null;
      if (this.captureRecoveryPending && !this.destroyed) {
        this.captureRecoveryPending = false;
        if (this.captureRetryTimer) {
          clearTimeout(this.captureRetryTimer);
          this.captureRetryTimer = null;
        }
        this.scheduleCaptureRecovery();
      }
    });
  }

  /** Reconcile a live capture graph when Chromium suspends or loses its AudioContext. */
  private handleCaptureContextStateChange(context: AudioContext, generation: number): void {
    if (
      this.destroyed
      || this.captureCtx !== context
      || generation !== this.captureGeneration
    ) return;

    const state = String(context.state);
    if (state === 'running') {
      if (this.isCaptureReady()) void this.reportCaptureReady(true);
      return;
    }
    if (state !== 'suspended') {
      this.scheduleCaptureRecovery();
      return;
    }
    if (this.captureStateResumePromise) return;

    const controller = new AbortController();
    this.captureStateResumeAbort = controller;
    let resumePromise!: Promise<void>;
    resumePromise = (async () => {
      await this.reportCaptureReady(false);
      try {
        await waitForAudioOperation(
          context.resume(),
          controller.signal,
          CAPTURE_RESUME_TIMEOUT_MS,
          'Microphone AudioContext recovery timed out',
        );
        if (
          this.destroyed
          || this.captureCtx !== context
          || generation !== this.captureGeneration
        ) return;
        if (String(context.state) !== 'running') {
          throw new Error(`Microphone AudioContext remained ${String(context.state)}`);
        }
        await this.reportCaptureReady(this.isCaptureReady());
      } catch (value) {
        const error = value instanceof Error ? value : new Error(String(value));
        if (!isAudioOperationAborted(error)) {
          console.warn('[AudioBridge] Capture AudioContext could not be resumed:', error);
          this.scheduleCaptureRecovery();
        }
      } finally {
        if (this.captureStateResumeAbort === controller) this.captureStateResumeAbort = null;
        if (this.captureStateResumePromise === resumePromise) {
          this.captureStateResumePromise = null;
        }
      }
    })();
    this.captureStateResumePromise = resumePromise;
  }

  private attachCaptureContextStateListener(context: AudioContext, generation: number): void {
    this.detachCaptureContextStateListener();
    const handler = (): void => this.handleCaptureContextStateChange(context, generation);
    context.addEventListener('statechange', handler);
    this.captureContextStateListener = { context, handler };
  }

  private detachCaptureContextStateListener(): void {
    const listener = this.captureContextStateListener;
    if (!listener) return;
    listener.context.removeEventListener('statechange', listener.handler);
    this.captureContextStateListener = null;
  }

  private async recoverCapture(failedCaptureId: VoiceCaptureId | undefined): Promise<void> {
    this.recording = false;
    this.currentCaptureId = null;
    await this.closeCaptureGraph();
    if (failedCaptureId) {
      await sarah.voice.captureFailed(failedCaptureId, CAPTURE_LOST_MESSAGE).catch((error) => {
        console.error('[AudioBridge] Capture loss could not be reported:', error);
      });
    }
    if (!this.destroyed && this.shouldKeepCaptureWarm()) {
      const started = await this.startCapture();
      const ready = started && this.isCaptureReady();
      await this.reportCaptureReady(ready);
      if (ready) this.resetCaptureRetry();
      else this.scheduleCaptureRetry();
    }
  }

  private enqueueCaptureChunk(captureId: VoiceCaptureId, samples: Float32Array): void {
    const previous = this.captureIpcTails.get(captureId) ?? Promise.resolve();
    const next = previous.then(() => (
      sarah.voice.sendAudioChunk(captureId, Array.from(samples))
    ));
    this.captureIpcTails.set(captureId, next);
    void next.catch(() => {
      // The correlated flush path reports this failure to main after observing
      // the same rejected tail. Attach a handler now to avoid an unhandled
      // rejection while the user is still holding PTT.
    });
  }

  private cancelRendererCapture(captureId: VoiceCaptureId): void {
    try {
      this.workletNode?.port.postMessage({ type: 'cancel', captureId });
    } catch (error) {
      console.warn('[AudioBridge] Worklet capture could not be canceled:', error);
    }
    // Every queued tail has its own rejection handler. Removing ownership here
    // cannot turn an in-flight invoke into an unhandled rejection.
    this.captureIpcTails.delete(captureId);
  }

  handleCaptureFlushRequest(captureId: VoiceCaptureId): void {
    if (
      this.destroyed
      || !this.recording
      || this.currentCaptureId !== captureId
      || !this.workletNode
    ) {
      void this.reportCaptureFlushFailure(captureId);
      return;
    }
    this.workletNode.port.postMessage({ type: 'flush', captureId });
  }

  private async finishCaptureFlush(captureId: VoiceCaptureId): Promise<void> {
    try {
      await (this.captureIpcTails.get(captureId) ?? Promise.resolve());
      if (
        this.destroyed
        || !this.recording
        || this.currentCaptureId !== captureId
        || !this.workletNode
      ) {
        throw new Error('Capture changed before its flush completed');
      }
      await sarah.voice.captureFlushed(captureId);
    } catch (error) {
      console.error('[AudioBridge] Capture flush could not be completed:', error);
      await this.reportCaptureFlushFailure(captureId);
    } finally {
      this.captureIpcTails.delete(captureId);
      if (this.currentCaptureId === captureId) {
        this.recording = false;
      }
    }
  }

  private async reportCaptureFlushFailure(captureId: VoiceCaptureId): Promise<void> {
    await sarah.voice.captureFailed(captureId, CAPTURE_LOST_MESSAGE).catch((reportError) => {
      console.error('[AudioBridge] Capture flush failure could not be reported:', reportError);
    });
  }

  stopCapture(): void {
    this.captureGeneration += 1;
    this.captureSetupAbort?.abort();
    this.captureSetupAbort = null;
    this.captureStateResumeAbort?.abort();
    this.captureStateResumeAbort = null;
    this.detachCaptureContextStateListener();
    this.capturing = false;
    this.activeInputDeviceId = undefined;

    this.workletNode?.disconnect();
    this.captureGain?.disconnect();
    this.sourceNode?.disconnect();
    this.workletNode = null;
    this.captureGain = null;
    this.sourceNode = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }

  private async closeCaptureGraph(): Promise<void> {
    this.stopCapture();
    this.workletLoaded = false;
    if (this.captureCtx) {
      await this.captureCtx.close().catch(() => {
        /* teardown continues even if Chromium already closed the context */
      });
      this.captureCtx = null;
    }
  }

}

function isDeviceUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'NotFoundError' || error.name === 'OverconstrainedError';
}
