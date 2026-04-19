// src/renderer/services/audio-bridge.ts

import type { AudioConfig } from '../../core/config-schema.js';
import type { SarahApi } from '../../core/sarah-api.js';
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

/** Path to the capture AudioWorklet module, relative to the renderer root. */
const WORKLET_MODULE_URL = 'dist/renderer/services/audio-worklet-processor.js';

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

export class AudioBridge {
  private captureCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private captureGain: GainNode | null = null;
  private capturing = false;
  private workletLoaded = false;

  private playbackCtx: AudioContext | null = null;
  private currentPlaybackSource: AudioBufferSourceNode | null = null;
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
  private unsubPlayAudio: (() => void) | null = null;
  private unsubAudioConfig: (() => void) | null = null;

  /** Latest applied audio config — used to short-circuit no-op updates. */
  private currentAudio: AudioConfig | undefined = undefined;
  /** Mirror of `currentAudio.inputDeviceId` for fast device-change checks. */
  private currentInputDeviceId: string | undefined = undefined;
  /** Mirror of `currentAudio.outputDeviceId`. A change during playback is
   *  honoured on the NEXT `playAudio` — in-flight playback finishes on the
   *  device it started on. Abrupt cross-fade is out of scope for Phase 6. */
  private currentOutputDeviceId: string | undefined = undefined;
  /** Mirror of `currentAudio.inputMuted`; short-circuits IPC push (Lücke #13). */
  private muted = false;
  /** `start()` must finish before audio-config events are processed, otherwise
   * the initial capture runs at default gain. */
  private started = false;
  /** Latched once `destroy()` begins, so in-flight operations can bail before
   * they allocate new resources the caller won't reach to tear down. */
  private destroyed = false;

  /** Chain of pending `applyAudioConfig` runs. Each new call appends, so two
   * rapid device changes execute in order — the second reads the committed
   * state of the first instead of racing on `currentInputDeviceId`. */
  private applyPromise: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    // Seed audio config first so the initial handleStateChange picks up
    // stored gain/device values before any capture is started.
    try {
      const initialConfig = await sarah.getConfig();
      this.currentAudio = initialConfig.audio;
      this.currentInputDeviceId = initialConfig.audio.inputDeviceId;
      this.currentOutputDeviceId = initialConfig.audio.outputDeviceId;
      this.muted = initialConfig.audio.inputMuted;
    } catch (err) {
      console.warn('[AudioBridge] initial config fetch failed:', err);
    }

    this.unsubState = sarah.voice.onStateChange(({ state }) => {
      this.handleStateChange(state);
    });

    this.unsubPlayAudio = sarah.voice.onPlayAudio(({ audio, sampleRate }) => {
      this.playAudio(audio, sampleRate);
    });

    this.unsubAudioConfig = sarah.onAudioConfigChanged((audio) => {
      void this.applyAudioConfig(audio);
    });

    // Check initial state (may trigger startCapture with seeded device id)
    const initialState = await sarah.voice.getState();
    this.handleStateChange(initialState);

    this.started = true;
  }

  async destroy(): Promise<void> {
    // Latch FIRST so any in-flight apply/startCapture bails before allocating
    // a new stream or worklet that we'd leak past teardown.
    this.destroyed = true;

    // Let any queued applyAudioConfig run to completion — it'll see `destroyed`
    // and early-return without grabbing new resources. Swallow its rejection;
    // we're tearing down anyway.
    await this.applyPromise.catch(() => {
      /* ignore */
    });

    this.stopCapture();
    this.stopPlayback();
    this.stopOutputLevelLoop();
    this.teardownPlaybackGraph();
    this.unsubState?.();
    this.unsubPlayAudio?.();
    this.unsubAudioConfig?.();
    this.unsubState = null;
    this.unsubPlayAudio = null;
    this.unsubAudioConfig = null;

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

  private handleStateChange(state: string): void {
    if (state === 'listening') {
      this.stopPlayback();
      void this.startCapture();
    } else if (this.capturing) {
      this.stopCapture();
    }
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
    const prevOutputVolume = this.currentAudio?.outputVolume;
    this.currentAudio = audio;
    this.currentInputDeviceId = audio.inputDeviceId;
    this.currentOutputDeviceId = audio.outputDeviceId;
    this.muted = audio.inputMuted;

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
      this.stopCapture();
      this.workletLoaded = false; // critical: next AudioContext needs a fresh addModule
      if (this.captureCtx) {
        await this.captureCtx.close().catch(() => {
          /* ignore */
        });
        this.captureCtx = null;
      }
      await this.startCapture();
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

  private async startCapture(): Promise<void> {
    // Teardown races: destroy() latches first, so a startCapture scheduled
    // from an in-flight apply must not allocate a new graph behind it.
    if (this.destroyed) return;
    if (this.capturing) return;
    this.capturing = true;

    try {
      // Create AudioContext at 16kHz (STT sample rate)
      if (!this.captureCtx) {
        this.captureCtx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
      }
      if (this.captureCtx.state === 'suspended') {
        await this.captureCtx.resume();
      }

      // Load worklet processor (only once per AudioContext instance)
      if (!this.workletLoaded) {
        await this.captureCtx.audioWorklet.addModule(WORKLET_MODULE_URL);
        this.workletLoaded = true;
      }

      // Get mic stream — honor configured device, fall back if it vanished.
      this.stream = await this.acquireMicStream();

      // Wire up: mic → gain → worklet → IPC
      this.sourceNode = this.captureCtx.createMediaStreamSource(this.stream);
      this.captureGain = this.captureCtx.createGain();
      // Seed the GainNode value directly (no ramp) so the first samples
      // already respect stored settings. Subsequent changes ramp.
      const initialGain = this.currentAudio ? computeEffectiveGain(this.currentAudio) : 1;
      this.captureGain.gain.value = initialGain;

      this.workletNode = new AudioWorkletNode(this.captureCtx, 'capture-processor');

      this.workletNode.port.onmessage = (event: MessageEvent<{ samples: Float32Array }>) => {
        // Mute short-circuits IPC (Lücke #13): the GainNode still produces
        // zeros, but we skip the send to avoid flooding STT with silence.
        if (this.muted) return;
        const samples = event.data.samples;
        sarah.voice.sendAudioChunk(Array.from(samples));
      };

      this.sourceNode.connect(this.captureGain);
      this.captureGain.connect(this.workletNode);
      this.workletNode.connect(this.captureCtx.destination);
    } catch (err) {
      console.error('[AudioBridge] Capture failed:', err);
      this.capturing = false;
    }
  }

  /**
   * Resolve a MediaStream for the currently-configured input device. If the
   * stored device id is no longer valid (unplugged mic), `getUserMedia` throws
   * an OverconstrainedError. Retry once without the deviceId constraint so the
   * user isn't locked out — the stored id stays intact so a re-plug auto-heals
   * on the next capture cycle.
   */
  private async acquireMicStream(): Promise<MediaStream> {
    const baseConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: CAPTURE_SAMPLE_RATE,
    };

    const deviceId = this.currentInputDeviceId;
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

  private stopCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;

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
  private async ensurePlaybackGraph(sampleRate: number): Promise<void> {
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
      await ctx.resume();
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
    const wantPathB = !!desiredDeviceId && hasSetSinkIdSupport();
    const havePathB = !!this.outputAudioElement;

    if (wantPathB !== havePathB) {
      this.outputGain.disconnect();
      if (this.outputStreamDest) {
        try {
          this.outputStreamDest.disconnect();
        } catch {
          /* already disconnected */
        }
        this.outputStreamDest = null;
      }
      if (this.outputAudioElement) {
        this.outputAudioElement.pause();
        this.outputAudioElement.srcObject = null;
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
      }
      if (!this.outputAudioElement) {
        const audioEl = new Audio();
        audioEl.autoplay = true;
        audioEl.srcObject = this.outputStreamDest.stream;
        this.outputAudioElement = audioEl;
      }
      // setSinkId may reject on invalid ids — fall back to default sink.
      if (desiredDeviceId) {
        const sinkEl = this.outputAudioElement as HTMLAudioElement & SinkIdCapable;
        try {
          await sinkEl.setSinkId(desiredDeviceId);
        } catch (err) {
          console.warn(
            `[AudioBridge] setSinkId("${desiredDeviceId}") failed, using default sink:`,
            err,
          );
        }
      }
    } else if (!wantPathB) {
      // Path A: gain → destination. Idempotent connect (disconnect above
      // when switching paths means we only ever connect once per path).
      this.outputGain.connect(ctx.destination);
    }
  }

  /** Tear down just the playback nodes — leaves `playbackCtx` itself alone
   *  so the caller can close it in the right order. */
  private teardownPlaybackGraph(): void {
    if (this.outputAudioElement) {
      this.outputAudioElement.pause();
      this.outputAudioElement.srcObject = null;
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

  private async playAudio(audio: number[], sampleRate: number): Promise<void> {
    try {
      await this.ensurePlaybackGraph(sampleRate);
      const ctx = this.playbackCtx;
      const analyser = this.outputAnalyser;
      if (!ctx || !analyser) {
        // ensurePlaybackGraph should always set these up; if it didn't,
        // the error branch below already called playbackDone().
        sarah.voice.playbackDone();
        return;
      }

      const buffer = ctx.createBuffer(1, audio.length, sampleRate);
      buffer.getChannelData(0).set(audio);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);

      this.currentPlaybackSource = source;
      this.outputPlaybackEndedAt = null;

      source.onended = () => {
        this.currentPlaybackSource = null;
        // Mark decay start. The RAF loop keeps running until bars fade out,
        // then emits a zero frame and stops. Prevents frozen mid-sentence bars.
        this.outputPlaybackEndedAt = performance.now();
        sarah.voice.playbackDone();
      };

      source.start();
      this.startOutputLevelLoop();
    } catch (err) {
      console.error('[AudioBridge] Playback failed:', err);
      sarah.voice.playbackDone();
    }
  }

  private stopPlayback(): void {
    if (this.currentPlaybackSource) {
      try {
        this.currentPlaybackSource.stop();
      } catch {
        // Already stopped
      }
      this.currentPlaybackSource = null;
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
