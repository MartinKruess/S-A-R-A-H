// src/renderer/services/audio-bridge.ts

import type { AudioConfig } from '../../core/config-schema.js';
import type { SarahApi } from '../../core/sarah-api.js';
import type { PlaybackId, TurnId, VoiceCaptureId } from '../../core/turn-contract.js';
import {
  computeEffectiveGain,
  decideCaptureReset,
  isCaptureConfigEqual,
  isPlaybackConfigEqual,
} from './audio-bridge-logic.js';
import {
  OUTPUT_BAR_COUNT,
  OUTPUT_DECAY_FACTOR,
  OUTPUT_DECAY_THRESHOLD,
  allBelow,
  barsFromTimeDomain,
  computeRms,
  decayBars,
  type AudioOutputLevelEventDetail,
} from './audio-output-level.js';

declare const sarah: SarahApi;

const CAPTURE_SAMPLE_RATE = 16_000;

/** Time-constant for GainNode ramps. 15ms keeps mute/unmute click-free. */
const GAIN_RAMP_TIME_CONSTANT = 0.015;

/** FFT size for the output analyser — fixed by Phase 6 spec. 256 → 128 bins. */
const OUTPUT_ANALYSER_FFT_SIZE = 256;

/** Timeout guarding `HTMLAudioElement.setSinkId` so an unplugged USB sink
 *  can't freeze the TTS pipeline. On timeout we fall back to the default sink. */
const SET_SINK_ID_TIMEOUT_MS = 2000;
const PLAYBACK_SETUP_TIMEOUT_MS = 4000;
const CAPTURE_RESUME_TIMEOUT_MS = 3000;
const CAPTURE_WORKLET_TIMEOUT_MS = 5000;
const CAPTURE_DEVICE_TIMEOUT_MS = 10_000;
const CAPTURE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/** Path to the capture AudioWorklet module, relative to the renderer root. */
const WORKLET_MODULE_URL = 'dist/renderer/services/audio-worklet-processor.js';

const CAPTURE_FAILED_MESSAGE =
  'Mikrofon konnte nicht gestartet werden. Bitte Berechtigung und Audiogerät prüfen.';
const CAPTURE_LOST_MESSAGE =
  'Die Mikrofonverbindung wurde unterbrochen. Bitte Audiogerät prüfen und erneut versuchen.';
const PLAYBACK_FAILED_MESSAGE =
  'Die Sprachausgabe konnte nicht wiedergegeben werden. Bitte Audiogerät prüfen.';

/**
 * Feature-detect `HTMLAudioElement.setSinkId`. Electron on current Chromium
 * has it, but older Electron builds or unusual sandboxing may not — without
 * this, `outputDeviceId` silently falls back to the system default.
 */
function hasSetSinkIdSupport(): boolean {
  return (
    typeof HTMLAudioElement !== 'undefined' &&
    'setSinkId' in HTMLAudioElement.prototype
  );
}

/**
 * Narrow interface for the non-standard `setSinkId` method. Typed separately
 * so we can stay off `any` while still talking to a method the lib.dom type
 * for `HTMLAudioElement` doesn't yet expose.
 */
interface SinkIdCapable {
  setSinkId(sinkId: string): Promise<void>;
}

class AudioOperationAbortedError extends Error {
  constructor() {
    super('Audio operation aborted');
    this.name = 'AbortError';
  }
}

function isAudioOperationAborted(error: Error): boolean {
  return error.name === 'AbortError';
}

/** Race a browser audio operation against lifecycle cancellation and a hard timeout. */
function waitForAudioOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
  onLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new AudioOperationAbortedError()));

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      finish(() => reject(new Error(timeoutMessage)));
    }, timeoutMs);

    void operation.then(
      (value) => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        finish(() => resolve(value));
      },
      (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

export class AudioBridge {
  private captureCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private captureGain: GainNode | null = null;
  private capturing = false;
  private workletLoaded = false;
  /** True only while an utterance is actively streamed to main. Decoupled from
   *  `capturing` (mic graph warm) so the mic can stay hot between utterances. */
  private recording = false;
  private currentCaptureId: VoiceCaptureId | null = null;
  private activeInputDeviceId: string | undefined = undefined;
  private preferredInputRecoveryPending = false;
  private voiceMode: 'off' | 'push-to-talk' | 'keyword' = 'off';
  private sttAvailable = false;
  private reportedCaptureReady: boolean | null = null;

  private playbackCtx: AudioContext | null = null;
  private currentPlaybackSource: AudioBufferSourceNode | null = null;
  private currentPlaybackGeneration = 0;
  private currentPlaybackTurnId: TurnId | null = null;
  private currentPlaybackId: PlaybackId | null = null;
  private playbackGeneration = 0;
  private playbackStartTail: Promise<void> = Promise.resolve();
  private readonly playbackStartControllers = new Map<PlaybackId, {
    turnId: TurnId;
    controller: AbortController;
  }>();
  /** Analyser node tapping the output graph pre-gain. Lives for the lifetime
   *  of `playbackCtx` so RAF sampling doesn't re-allocate per utterance. */
  private outputAnalyser: AnalyserNode | null = null;
  /** Post-analyser GainNode carrying `outputVolume`. Post-analyser so a user
   *  muting via volume still sees VU activity (Lücke #8). */
  private outputGain: GainNode | null = null;
  /** Optional element the Path-B route plays through at a specific sinkId. */
  private outputAudioElement: HTMLAudioElement | null = null;
  /** MediaStreamDestination that feeds `outputAudioElement` when Path B is
   *  active. Kept null on Path A. */
  private outputStreamDest: MediaStreamAudioDestinationNode | null = null;
  private outputUsesDefaultSink = false;
  /** Active RAF handle for the VU meter loop. */
  private outputLevelRAF: number | null = null;
  /** `performance.now()` captured when the current playback source ended.
   *  Null while playback is in flight; drives the decay window. */
  private outputPlaybackEndedAt: number | null = null;
  /** Reused scratch buffers so the RAF loop doesn't allocate per frame.
   *  Typed with the explicit `ArrayBuffer` generic so TS 6 doesn't widen to
   *  `ArrayBufferLike` on later assignment, which `AnalyserNode.getFloat*`
   *  refuses. */
  private outputTimeBuffer: Float32Array<ArrayBuffer> | null = null;
  private outputBarsBuffer: Float32Array<ArrayBuffer> = new Float32Array(OUTPUT_BAR_COUNT);

  private unsubState: (() => void) | null = null;
  private unsubCaptureFlush: (() => void) | null = null;
  private unsubPlayAudio: (() => void) | null = null;
  private unsubStopPlayback: (() => void) | null = null;
  private unsubAudioConfig: (() => void) | null = null;
  private unsubVoiceInputConfig: (() => void) | null = null;
  private unsubCapability: (() => void) | null = null;

  /** Latest applied audio config — used to short-circuit no-op updates. */
  private currentAudio: AudioConfig | undefined = undefined;
  /** Mirror of `currentAudio.inputDeviceId` for fast device-change checks. */
  private currentInputDeviceId: string | undefined = undefined;
  /** Mirror of `currentAudio.outputDeviceId`. A change during playback is
   *  honoured on the NEXT `playAudio` — in-flight playback finishes on the
   *  device it started on. Abrupt cross-fade is out of scope for Phase 6. */
  private currentOutputDeviceId: string | undefined = undefined;
  private failedOutputDeviceId: string | undefined = undefined;
  /** Last device id for which we logged the "setSinkId unsupported" warning.
   *  Keeps the log out of the per-utterance hot path while still surfacing
   *  the misconfiguration once per device change. */
  private lastLoggedUnsupportedDevice: string | undefined = undefined;
  /** Mirror of `currentAudio.inputMuted`; short-circuits IPC push (Lücke #13). */
  private muted = false;
  /** `start()` must finish before audio-config events are processed, otherwise
   * the initial capture runs at default gain. */
  private started = false;
  /** Latched once `destroy()` begins, so in-flight operations can bail before
   * they allocate new resources the caller won't reach to tear down. */
  private destroyed = false;
  /** Invalidates asynchronous capture setup when teardown or a device switch wins. */
  private captureGeneration = 0;
  /** Current setup operation, awaited by destroy so late media resources cannot survive it. */
  private captureStartPromise: Promise<boolean> | null = null;
  private readonly captureStartPromises = new Set<Promise<boolean>>();
  private captureSetupAbort: AbortController | null = null;
  private captureRecoveryPromise: Promise<void> | null = null;
  private captureRecoveryPending = false;
  private captureRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private captureRetryAttempt = 0;
  private captureLifecyclePromise: Promise<void> = Promise.resolve();
  private audioConfigRevision = 0;
  private voiceInputConfigRevision = 0;
  private capabilityRevision = 0;
  private voiceStateRevision = 0;
  private pendingVoiceState: { state: string; captureId?: VoiceCaptureId } | null = null;
  private readonly captureIpcTails = new Map<VoiceCaptureId, Promise<void>>();
  private readonly deviceChangeHandler = (): void => {
    void this.handleMediaDevicesChanged();
  };

  /** Chain of pending `applyAudioConfig` runs. Each new call appends, so two
   * rapid device changes execute in order — the second reads the committed
   * state of the first instead of racing on `currentInputDeviceId`. */
  private applyPromise: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    this.unsubState = sarah.voice.onStateChange(({ state, captureId }) => {
      this.voiceStateRevision += 1;
      if (!this.started) {
        this.pendingVoiceState = { state, ...(captureId ? { captureId } : {}) };
        return;
      }
      this.handleStateChange(state, captureId);
    });
    this.unsubCaptureFlush = sarah.voice.onCaptureFlushRequest(({ captureId }) => {
      this.handleCaptureFlushRequest(captureId);
    });

    this.unsubPlayAudio = sarah.voice.onPlayAudio(({ turnId, playbackId, audio, sampleRate }) => {
      const generation = ++this.playbackGeneration;
      const controller = new AbortController();
      this.playbackStartControllers.set(playbackId, { turnId, controller });
      const start = (): Promise<void> => this.playAudio(
        generation,
        turnId,
        playbackId,
        audio,
        sampleRate,
        controller.signal,
      ).finally(() => {
        const pending = this.playbackStartControllers.get(playbackId);
        if (pending?.controller === controller) this.playbackStartControllers.delete(playbackId);
      });
      this.playbackStartTail = this.playbackStartTail.then(start, start);
    });

    this.unsubStopPlayback = sarah.voice.onStopPlayback(({ turnId, playbackId }) => {
      this.stopPlayback(turnId, playbackId);
    });

    navigator.mediaDevices.addEventListener?.('devicechange', this.deviceChangeHandler);

    this.unsubAudioConfig = sarah.onAudioConfigChanged((audio) => {
      this.audioConfigRevision += 1;
      if (!this.started) {
        this.rememberAudioConfig(audio);
        return;
      }
      void this.applyAudioConfig(audio);
    });
    this.unsubVoiceInputConfig = sarah.onVoiceInputConfigChanged(({ voiceMode }) => {
      this.voiceInputConfigRevision += 1;
      const shouldResetRetry = this.voiceMode === 'off' && voiceMode !== 'off';
      this.voiceMode = voiceMode;
      if (shouldResetRetry) this.resetCaptureRetry();
      if (!this.started) return;
      void this.reconcileVoiceInputLifecycle();
    });
    this.unsubCapability = sarah.voice.onCapability(({ stt }) => {
      this.capabilityRevision += 1;
      const shouldResetRetry = !this.sttAvailable && stt;
      this.sttAvailable = stt;
      if (shouldResetRetry) this.resetCaptureRetry();
      if (!this.started) return;
      void this.reconcileVoiceInputLifecycle();
    });

    const audioRevision = this.audioConfigRevision;
    const voiceInputRevision = this.voiceInputConfigRevision;
    const capabilityRevision = this.capabilityRevision;
    const voiceStateRevision = this.voiceStateRevision;
    const [configResult, runtimeResult, stateResult] = await Promise.allSettled([
      sarah.getConfig(),
      sarah.getRuntimeStatus(),
      sarah.voice.getState(),
    ]);

    if (configResult.status === 'fulfilled') {
      if (this.audioConfigRevision === audioRevision) {
        this.rememberAudioConfig(configResult.value.audio);
      }
      if (this.voiceInputConfigRevision === voiceInputRevision) {
        this.voiceMode = configResult.value.controls?.voiceMode ?? 'off';
      }
    } else {
      console.warn('[AudioBridge] initial config fetch failed:', configResult.reason);
    }
    if (runtimeResult.status === 'fulfilled') {
      if (this.capabilityRevision === capabilityRevision) {
        this.sttAvailable = runtimeResult.value.capabilities.stt?.state === 'ready';
      }
    } else {
      console.warn('[AudioBridge] initial STT capability fetch failed:', runtimeResult.reason);
    }

    const initialVoiceState = this.voiceStateRevision === voiceStateRevision
      && stateResult.status === 'fulfilled'
      ? stateResult.value
      : this.pendingVoiceState;
    if (stateResult.status === 'rejected') {
      console.warn('[AudioBridge] initial voice state fetch failed:', stateResult.reason);
    }

    this.started = true;
    await this.reconcileVoiceInputLifecycle();
    if (initialVoiceState) {
      this.handleStateChange(initialVoiceState.state, initialVoiceState.captureId);
    }
  }

  async destroy(): Promise<void> {
    // Latch FIRST so any in-flight apply/startCapture bails before allocating
    // a new stream or worklet that we'd leak past teardown.
    this.destroyed = true;
    this.resetCaptureRetry();
    if (this.currentCaptureId) this.cancelRendererCapture(this.currentCaptureId);
    this.captureIpcTails.clear();
    this.recording = false;
    this.currentCaptureId = null;
    this.stopCapture();
    await this.reportCaptureReady(false);
    for (const pending of this.playbackStartControllers.values()) pending.controller.abort();

    // Let any queued applyAudioConfig run to completion — it'll see `destroyed`
    // and early-return without grabbing new resources. Swallow its rejection;
    // we're tearing down anyway.
    await this.applyPromise.catch(() => {
      /* ignore */
    });
    await this.captureLifecyclePromise.catch(() => {
      /* teardown continues after a failed lifecycle reconciliation */
    });

    await Promise.allSettled([...this.captureStartPromises]);
    await this.captureRecoveryPromise?.catch(() => {
      /* teardown continues after a failed recovery */
    });
    this.stopPlayback();
    await this.playbackStartTail.catch(() => {
      /* teardown continues after a failed playback setup */
    });
    this.stopOutputLevelLoop();
    this.teardownPlaybackGraph();
    this.unsubState?.();
    this.unsubCaptureFlush?.();
    this.unsubPlayAudio?.();
    this.unsubStopPlayback?.();
    this.unsubAudioConfig?.();
    this.unsubVoiceInputConfig?.();
    this.unsubCapability?.();
    this.unsubState = null;
    this.unsubCaptureFlush = null;
    this.unsubPlayAudio = null;
    this.unsubStopPlayback = null;
    this.unsubAudioConfig = null;
    this.unsubVoiceInputConfig = null;
    this.unsubCapability = null;
    navigator.mediaDevices.removeEventListener?.('devicechange', this.deviceChangeHandler);

    if (this.captureCtx) {
      await this.captureCtx.close();
      this.captureCtx = null;
      this.workletLoaded = false;
    }
    if (this.playbackCtx) {
      await this.playbackCtx.close();
      this.playbackCtx = null;
    }
  }

  private handleStateChange(state: string, captureId?: VoiceCaptureId): void {
    if (state === 'listening') {
      this.currentCaptureId = captureId ?? null;
      this.stopPlayback();
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
      if (state === 'idle' || state === 'processing') this.stopPlayback();
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

  private reconcileVoiceInputLifecycle(): Promise<void> {
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

  private rememberAudioConfig(audio: AudioConfig): void {
    this.currentAudio = audio;
    this.currentInputDeviceId = audio.inputDeviceId;
    this.currentOutputDeviceId = audio.outputDeviceId;
    this.muted = audio.inputMuted;
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

  // ── Audio-Config reactions ──

  /**
   * React to a new persisted audio config. Idempotent — no-op if neither the
   * capture slice nor the playback slice changed. Capture device changes
   * re-init the AudioContext (and reset `workletLoaded`), gain/mute changes
   * ramp the GainNode without tearing anything down. Playback-side changes
   * (volume/device) update the live gain and stored sink id.
   *
   * Calls are serialized via `applyPromise`: two rapid device switches run
   * in order, so the second reads the first's committed state instead of
   * both seeing the same stale `currentInputDeviceId`.
   */
  applyAudioConfig(audio: AudioConfig): Promise<void> {
    this.applyPromise = this.applyPromise.then(
      () => this._applyAudioConfigSerial(audio),
      () => this._applyAudioConfigSerial(audio),
    );
    return this.applyPromise;
  }

  private async _applyAudioConfigSerial(audio: AudioConfig): Promise<void> {
    // Guard against teardown landing between queued calls — we don't want to
    // grab a new mic stream just to have the caller tear down around us.
    if (this.destroyed) return;

    if (!this.started) {
      // Avoid racing with start(): the initial getConfig() seed will supply the
      // right values when capture kicks off. Log so we can spot unexpected
      // early events.
      console.debug('[AudioBridge] audio-config arrived before start(), ignoring');
      return;
    }

    const captureEqual = isCaptureConfigEqual(this.currentAudio, audio);
    const playbackEqual = isPlaybackConfigEqual(this.currentAudio, audio);
    if (captureEqual && playbackEqual) return;

    // Read prevDeviceId INSIDE the serialized section so a queued call B sees
    // call A's committed state, not the state that was live when B was queued.
    const prevDeviceId = this.currentInputDeviceId;
    const prevOutputDeviceId = this.currentOutputDeviceId;
    const prevOutputVolume = this.currentAudio?.outputVolume;
    const captureWasActive = this.recording || this.currentCaptureId !== null;
    this.currentAudio = audio;
    this.currentInputDeviceId = audio.inputDeviceId;
    this.currentOutputDeviceId = audio.outputDeviceId;
    this.muted = audio.inputMuted;
    if (prevDeviceId !== audio.inputDeviceId) this.resetCaptureRetry();
    if (prevOutputDeviceId !== audio.outputDeviceId) {
      this.failedOutputDeviceId = undefined;
    }

    // ── Playback-side reactions (no graph rebuild, just live updates) ──
    if (!playbackEqual) {
      // outputDeviceId change: stored id is already updated above. If a
      // playback is in flight we intentionally let it finish on the old
      // device — switching sinkId mid-stream risks an abrupt silence drop,
      // and cross-fade is out of scope for Phase 6. The NEXT playAudio will
      // pick up the new id.
      if (prevOutputVolume !== audio.outputVolume) {
        this.rampOutputVolume();
      }
    }

    if (captureEqual) {
      // Only playback-side changed — capture graph stays untouched.
      return;
    }

    const decision = decideCaptureReset(prevDeviceId, audio.inputDeviceId, this.capturing);

    if (decision === 'reset') {
      // Device swapped while we were capturing — rebuild the graph.
      await this.reportCaptureReady(false);
      const failedCaptureId = captureWasActive ? this.currentCaptureId ?? undefined : undefined;
      if (failedCaptureId) {
        this.recording = false;
        this.currentCaptureId = null;
        this.cancelRendererCapture(failedCaptureId);
      }
      this.stopCapture();
      this.workletLoaded = false; // critical: next AudioContext needs a fresh addModule
      if (this.captureCtx) {
        await this.captureCtx.close().catch(() => {
          /* ignore */
        });
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
      // startCapture applies gain via rampCaptureGain after wiring.
      return;
    }

    // decision === 'noop' or 'updateStored': no graph rebuild needed,
    // just ramp the live GainNode if one exists.
    this.rampCaptureGain();
  }

  /** Push the computed gain onto the live GainNode via setTargetAtTime. */
  private rampCaptureGain(): void {
    if (!this.captureGain || !this.captureCtx || !this.currentAudio) return;
    const target = computeEffectiveGain(this.currentAudio);
    const now = this.captureCtx.currentTime;
    this.captureGain.gain.setTargetAtTime(target, now, GAIN_RAMP_TIME_CONSTANT);
  }

  /** Ramp the output GainNode to the stored `outputVolume`. Only takes effect
   *  once a playback graph exists. */
  private rampOutputVolume(): void {
    if (!this.outputGain || !this.playbackCtx || !this.currentAudio) return;
    const target = this.currentAudio.outputVolume;
    const now = this.playbackCtx.currentTime;
    this.outputGain.gain.setTargetAtTime(target, now, GAIN_RAMP_TIME_CONSTANT);
  }

  // ── Capture ──

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
      this.activeInputDeviceId = stream.getTracks()
        .map((track) => track.getSettings().deviceId)
        .find(Boolean);
      this.resetCaptureRetry();
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

      if (
        this.failedOutputDeviceId
        && devices.some((device) => (
          device.kind === 'audiooutput' && device.deviceId === this.failedOutputDeviceId
        ))
      ) {
        this.failedOutputDeviceId = undefined;
      }

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

  private handleCaptureFlushRequest(captureId: VoiceCaptureId): void {
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

  private stopCapture(): void {
    this.captureGeneration += 1;
    this.captureSetupAbort?.abort();
    this.captureSetupAbort = null;
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

  // ── Playback ──

  /**
   * Build (or rebuild on demand) the stable nodes of the playback graph
   * attached to `this.playbackCtx`: analyser tap → gain → (destination | path-B
   * stream dest). Called lazily from `playAudio` because we don't know the
   * TTS `sampleRate` until the first utterance, and re-created with a new
   * context if the sample rate changes.
   *
   * Path choice (Phase 6 — Lücke #1):
   *   Path A — no specific outputDeviceId OR `HTMLAudioElement.setSinkId`
   *            unsupported: gain → playbackCtx.destination. Default sink.
   *   Path B — outputDeviceId set AND setSinkId supported: gain →
   *            MediaStreamDestination → <audio>.srcObject, <audio>.setSinkId.
   *            The <audio> plays through the chosen sink; analyser still sees
   *            the pre-gain signal via the shared graph so VU meters work.
   */
  private async ensurePlaybackGraph(sampleRate: number, signal: AbortSignal): Promise<void> {
    // Rebuild if sample rate changed (mismatched context would up-sample and
    // distort the analyser tap) or if the context was closed/lost.
    const needsNewCtx =
      !this.playbackCtx ||
      this.playbackCtx.sampleRate !== sampleRate ||
      this.playbackCtx.state === 'closed';

    if (needsNewCtx) {
      this.teardownPlaybackGraph();
      if (this.playbackCtx) {
        await this.playbackCtx.close().catch(() => {
          /* ignore */
        });
        this.playbackCtx = null;
      }
      this.playbackCtx = new AudioContext({ sampleRate });
    }
    const ctx = this.playbackCtx;
    if (!ctx) return; // satisfy narrowing; can't happen after the new above

    if (ctx.state === 'suspended') {
      await waitForAudioOperation(
        ctx.resume(),
        signal,
        PLAYBACK_SETUP_TIMEOUT_MS,
        'Audio playback setup timed out',
      );
    }

    // Build the analyser + gain once per context. Subsequent playAudio() calls
    // reuse them — only the BufferSource is transient.
    if (!this.outputAnalyser) {
      this.outputAnalyser = ctx.createAnalyser();
      this.outputAnalyser.fftSize = OUTPUT_ANALYSER_FFT_SIZE;
      this.outputTimeBuffer = new Float32Array(this.outputAnalyser.fftSize);
    }
    if (!this.outputGain) {
      this.outputGain = ctx.createGain();
      this.outputGain.gain.value = this.currentAudio?.outputVolume ?? 1;
      // analyser feeds gain; both endpoints are wired below depending on path.
      this.outputAnalyser.connect(this.outputGain);
    }

    // Choose routing path. We rebuild the tail whenever the desired path
    // differs from the live one, e.g. after an outputDeviceId config change
    // between utterances.
    const desiredDeviceId = this.currentOutputDeviceId;
    const setSinkIdSupported = hasSetSinkIdSupport();
    const wantPathB = !!desiredDeviceId
      && desiredDeviceId !== this.failedOutputDeviceId
      && setSinkIdSupported;
    const havePathB = !!this.outputAudioElement;

    // Log once per unique device-id when the caller asked for a specific
    // sink but the platform lacks setSinkId (old Electron, sandboxed contexts).
    // Guarded by `lastLoggedUnsupportedDevice` so the hot path stays quiet.
    if (desiredDeviceId && !setSinkIdSupported) {
      if (this.lastLoggedUnsupportedDevice !== desiredDeviceId) {
        console.warn(
          `[AudioBridge] outputDeviceId="${desiredDeviceId}" set but setSinkId unsupported; using default sink`,
        );
        this.lastLoggedUnsupportedDevice = desiredDeviceId;
      }
    } else if (!desiredDeviceId) {
      // Device cleared — allow a future re-set to log again.
      this.lastLoggedUnsupportedDevice = undefined;
    }

    if (wantPathB !== havePathB) {
      this.outputGain.disconnect();
      this.outputUsesDefaultSink = false;
      if (this.outputStreamDest) {
        try {
          this.outputStreamDest.disconnect();
        } catch {
          /* already disconnected */
        }
        this.outputStreamDest = null;
      }
      if (this.outputAudioElement) {
        // Explicit srcObject=null + load() forces the media pipeline to drop
        // the MediaStream so the GC doesn't keep the old graph pinned via
        // the element's internal reference.
        this.outputAudioElement.pause();
        this.outputAudioElement.srcObject = null;
        this.outputAudioElement.load();
        this.outputAudioElement = null;
      }
    }

    if (wantPathB) {
      if (!this.outputStreamDest) {
        // MediaStreamDestination feeds an <audio> element we route via
        // setSinkId. We picked this over a WAV-blob roundtrip because the
        // Float32 buffer chain stays intact and we avoid per-utterance
        // encoding + ObjectURL lifecycle.
        this.outputStreamDest = ctx.createMediaStreamDestination();
        this.outputGain.connect(this.outputStreamDest);
        this.outputUsesDefaultSink = false;
      }
      if (!this.outputAudioElement) {
        const audioEl = new Audio();
        audioEl.autoplay = true;
        audioEl.srcObject = this.outputStreamDest.stream;
        // Surface pipeline errors (codec, decode, network) to the console
        // instead of silently hanging. Listener lives for the element's
        // lifetime — simpler than one-shot cleanup.
        audioEl.addEventListener('error', () => {
          console.warn('[AudioBridge] <audio> element error:', audioEl.error?.message);
          if (
            this.outputAudioElement === audioEl
            && this.currentPlaybackTurnId
            && this.currentPlaybackId
          ) {
            void this.failPlayback(
              this.currentPlaybackTurnId,
              this.currentPlaybackId,
              new Error(audioEl.error?.message ?? PLAYBACK_FAILED_MESSAGE),
            );
          }
        });
        this.outputAudioElement = audioEl;
      }
      // setSinkId may reject on invalid ids OR hang on an unplugged sink —
      // wrap in a timeout race and fall back to default sink in either case.
      if (desiredDeviceId) {
        const sinkEl = this.outputAudioElement as HTMLAudioElement & SinkIdCapable;
        try {
          await waitForAudioOperation(
            sinkEl.setSinkId(desiredDeviceId),
            signal,
            SET_SINK_ID_TIMEOUT_MS,
            'setSinkId timeout',
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (isAudioOperationAborted(error)) throw error;
          console.warn(
            `[AudioBridge] setSinkId("${desiredDeviceId}") failed/timed out, falling back:`,
            err,
          );
          this.failedOutputDeviceId = desiredDeviceId;
          this.switchPlaybackToDefaultSink(ctx);
        }
      }
    } else if (!wantPathB) {
      // Path A: gain → destination. Idempotent connect (disconnect above
      // when switching paths means we only ever connect once per path).
      if (!this.outputUsesDefaultSink) {
        this.outputGain.connect(ctx.destination);
        this.outputUsesDefaultSink = true;
      }
    }
  }

  /** Detach a failed specific-sink route and reconnect the live graph to the OS default. */
  private switchPlaybackToDefaultSink(ctx: AudioContext): void {
    this.outputGain?.disconnect();
    if (this.outputAudioElement) {
      this.outputAudioElement.pause();
      this.outputAudioElement.srcObject = null;
      this.outputAudioElement.load();
      this.outputAudioElement = null;
    }
    if (this.outputStreamDest) {
      try {
        this.outputStreamDest.disconnect();
      } catch {
        /* already disconnected */
      }
      this.outputStreamDest = null;
    }
    this.outputGain?.connect(ctx.destination);
    this.outputUsesDefaultSink = true;
  }

  /** Tear down just the playback nodes — leaves `playbackCtx` itself alone
   *  so the caller can close it in the right order. */
  private teardownPlaybackGraph(): void {
    if (this.outputAudioElement) {
      this.outputAudioElement.pause();
      this.outputAudioElement.srcObject = null;
      // Force the pipeline to drop the MediaStream so GC can collect the
      // upstream graph nodes (mirrors the path-flip cleanup above).
      this.outputAudioElement.load();
      this.outputAudioElement = null;
    }
    if (this.outputStreamDest) {
      try {
        this.outputStreamDest.disconnect();
      } catch {
        /* already disconnected */
      }
      this.outputStreamDest = null;
    }
    if (this.outputGain) {
      try {
        this.outputGain.disconnect();
      } catch {
        /* already disconnected */
      }
      this.outputGain = null;
      this.outputUsesDefaultSink = false;
    }
    if (this.outputAnalyser) {
      try {
        this.outputAnalyser.disconnect();
      } catch {
        /* already disconnected */
      }
      this.outputAnalyser = null;
    }
    this.outputTimeBuffer = null;
  }

  private async playAudio(
    generation: number,
    turnId: TurnId,
    playbackId: PlaybackId,
    audio: number[],
    sampleRate: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    this.currentPlaybackTurnId = turnId;
    this.currentPlaybackId = playbackId;
    try {
      await this.ensurePlaybackGraph(sampleRate, signal);
      if (signal.aborted) {
        this.clearPlaybackCorrelation(turnId, playbackId);
        return;
      }
      if (this.destroyed || generation !== this.playbackGeneration) {
        this.clearPlaybackCorrelation(turnId, playbackId);
        await sarah.voice.playbackDone(turnId, playbackId);
        return;
      }
      const ctx = this.playbackCtx;
      const analyser = this.outputAnalyser;
      if (!ctx || !analyser) {
        throw new Error('Playback graph is unavailable');
      }

      const buffer = ctx.createBuffer(1, audio.length, sampleRate);
      buffer.getChannelData(0).set(audio);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);

      this.currentPlaybackSource = source;
      this.currentPlaybackGeneration = generation;
      this.outputPlaybackEndedAt = null;

      source.onended = () => {
        if (
          this.currentPlaybackSource === source
          && this.currentPlaybackGeneration === generation
        ) {
          this.currentPlaybackSource = null;
          this.currentPlaybackGeneration = 0;
          this.clearPlaybackCorrelation(turnId, playbackId);
        }
        // Idempotent: stopPlayback() may have primed decay synchronously before
        // `onended` fired (mid-sentence interrupt). In that case, keep the
        // earlier timestamp so the decay window started exactly at the cut.
        if (this.outputPlaybackEndedAt === null) {
          this.outputPlaybackEndedAt = performance.now();
        }
        void sarah.voice.playbackDone(turnId, playbackId);
      };

      source.start();
      this.startOutputLevelLoop();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (isAudioOperationAborted(error)) {
        this.clearPlaybackCorrelation(turnId, playbackId);
        return;
      }
      console.error('[AudioBridge] Playback failed:', error);
      await this.failPlayback(
        turnId,
        playbackId,
        error,
      );
    }
  }

  private async failPlayback(
    turnId: TurnId,
    playbackId: PlaybackId,
    error: Error,
  ): Promise<void> {
    if (
      this.currentPlaybackTurnId !== turnId
      || this.currentPlaybackId !== playbackId
    ) return;
    // A renderer failure is terminal and must never race its source.onended
    // into a success ACK before the correlated failure reaches main.
    if (this.currentPlaybackSource) this.currentPlaybackSource.onended = null;
    this.stopPlayback(turnId, playbackId);
    await sarah.voice.playbackFailed(
      turnId,
      playbackId,
      error.message || PLAYBACK_FAILED_MESSAGE,
    ).catch((reportError) => {
      console.error('[AudioBridge] Playback failure could not be reported:', reportError);
    });
  }

  private clearPlaybackCorrelation(turnId: TurnId, playbackId: PlaybackId): void {
    if (
      this.currentPlaybackTurnId === turnId
      && this.currentPlaybackId === playbackId
    ) {
      this.currentPlaybackTurnId = null;
      this.currentPlaybackId = null;
    }
  }

  private stopPlayback(turnId?: TurnId, playbackId?: PlaybackId): void {
    if (turnId !== undefined && playbackId !== undefined) {
      const pending = this.playbackStartControllers.get(playbackId);
      if (pending?.turnId === turnId) pending.controller.abort();
    } else {
      for (const pending of this.playbackStartControllers.values()) pending.controller.abort();
    }
    if (
      turnId !== undefined
      && playbackId !== undefined
      && (
        this.currentPlaybackTurnId !== turnId
        || this.currentPlaybackId !== playbackId
      )
    ) return;
    this.playbackGeneration += 1;
    if (turnId !== undefined && playbackId !== undefined) {
      this.clearPlaybackCorrelation(turnId, playbackId);
    } else {
      this.currentPlaybackTurnId = null;
      this.currentPlaybackId = null;
    }
    if (this.currentPlaybackSource) {
      // Prime decay SYNCHRONOUSLY so the next RAF tick sees the decay branch
      // even if `source.onended` hasn't fired yet (it may be queued on a
      // macrotask). Without this, a mid-sentence interrupt would keep sampling
      // a disconnected analyser and dispatch genuine zeros abruptly. The
      // onended handler is now idempotent and preserves this earlier timestamp.
      this.outputPlaybackEndedAt = performance.now();
      try {
        this.currentPlaybackSource.stop();
      } catch {
        // Already stopped
      }
      this.currentPlaybackSource = null;
      this.currentPlaybackGeneration = 0;
      // Leave the RAF loop running — it self-terminates via the decay branch
      // (allBelow → stopOutputLevelLoop) for a smooth fade-out.
    }
  }

  // ── Output VU meter ──

  private startOutputLevelLoop(): void {
    if (this.outputLevelRAF !== null) return; // already running
    if (typeof requestAnimationFrame !== 'function') return; // test env without RAF
    const tick = () => {
      this.outputLevelRAF = null;
      if (this.destroyed) return;
      this.sampleOutputLevel();
      if (this.outputAnalyser) {
        this.outputLevelRAF = requestAnimationFrame(tick);
      }
    };
    this.outputLevelRAF = requestAnimationFrame(tick);
  }

  private stopOutputLevelLoop(): void {
    if (this.outputLevelRAF !== null) {
      cancelAnimationFrame(this.outputLevelRAF);
      this.outputLevelRAF = null;
    }
  }

  /**
   * One RAF tick: read the analyser, compute bars, apply decay if we're in
   * the post-playback fade window, dispatch the `audio:output-level` event,
   * and stop the loop once fully decayed.
   *
   * Decay is frame-based (multiply by 0.85 per tick). We considered time-
   * based decay using `performance.now()` deltas, but frame-based is simpler
   * and the RAF cadence is stable enough on modern Chromium that the visible
   * difference is negligible.
   */
  private sampleOutputLevel(): void {
    const analyser = this.outputAnalyser;
    const timeBuf = this.outputTimeBuffer;
    if (!analyser || !timeBuf) return;

    const decaying = this.outputPlaybackEndedAt !== null;

    if (decaying) {
      // During decay we don't sample fresh audio — the source is gone, so the
      // analyser would just read zeros and we'd lose the smooth fade. Apply
      // the decay factor to the bars we already have.
      decayBars(this.outputBarsBuffer, OUTPUT_DECAY_FACTOR);
      // RMS is a scalar mirror of the bars so external observers can still use
      // it for e.g. panel-accent glows without recomputing.
      const rms = computeRms(this.outputBarsBuffer);
      this.dispatchOutputLevel(rms, this.outputBarsBuffer);
      if (allBelow(this.outputBarsBuffer, OUTPUT_DECAY_THRESHOLD)) {
        // Final zero frame so subscribers snap back to idle cleanly.
        this.outputBarsBuffer.fill(0);
        this.dispatchOutputLevel(0, this.outputBarsBuffer);
        this.outputPlaybackEndedAt = null;
        this.stopOutputLevelLoop();
      }
      return;
    }

    analyser.getFloatTimeDomainData(timeBuf);
    const rms = computeRms(timeBuf);
    barsFromTimeDomain(timeBuf, OUTPUT_BAR_COUNT, this.outputBarsBuffer);
    this.dispatchOutputLevel(rms, this.outputBarsBuffer);
  }

  private dispatchOutputLevel(rms: number, bars: Float32Array): void {
    if (typeof window === 'undefined') return;
    const detail: AudioOutputLevelEventDetail = { rms, bars };
    window.dispatchEvent(new CustomEvent('audio:output-level', { detail }));
  }
}

function isDeviceUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}
