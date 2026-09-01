import type { AudioConfig } from '../../core/config-schema.js';
import type { SarahApi } from '../../core/sarah-api.js';
import type { PlaybackId, TurnId } from '../../core/turn-contract.js';
import { isPlaybackConfigEqual } from './audio-bridge-logic.js';
import { isAudioOperationAborted, waitForAudioOperation } from './audio-operation.js';
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

const GAIN_RAMP_TIME_CONSTANT = 0.015;
const OUTPUT_ANALYSER_FFT_SIZE = 256;
const SET_SINK_ID_TIMEOUT_MS = 2000;
const PLAYBACK_SETUP_TIMEOUT_MS = 4000;
const PLAYBACK_FAILED_MESSAGE =
  'Die Sprachausgabe konnte nicht wiedergegeben werden. Bitte Audiogerät prüfen.';

function hasSetSinkIdSupport(): boolean {
  return typeof HTMLAudioElement !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype;
}

interface SinkIdCapable { setSinkId(sinkId: string): Promise<void>; }

/**
 * Owns renderer TTS playback, output routing and output-level sampling.
 *
 * @category Service
 */
export class AudioPlaybackController {
  private playbackCtx: AudioContext | null = null;
  private currentPlaybackSource: AudioBufferSourceNode | null = null;
  private currentPlaybackGeneration = 0;
  private currentPlaybackTurnId: TurnId | null = null;
  private currentPlaybackId: PlaybackId | null = null;
  private playbackGeneration = 0;
  private playbackStartTail: Promise<void> = Promise.resolve();
  private readonly playbackStartControllers = new Map<PlaybackId, { turnId: TurnId; controller: AbortController }>();
  private outputAnalyser: AnalyserNode | null = null;
  private outputGain: GainNode | null = null;
  private outputAudioElement: HTMLAudioElement | null = null;
  private outputStreamDest: MediaStreamAudioDestinationNode | null = null;
  private outputUsesDefaultSink = false;
  private outputLevelRAF: number | null = null;
  private outputPlaybackEndedAt: number | null = null;
  private outputTimeBuffer: Float32Array<ArrayBuffer> | null = null;
  private outputBarsBuffer: Float32Array<ArrayBuffer> = new Float32Array(OUTPUT_BAR_COUNT);
  private currentAudio: AudioConfig | undefined = undefined;
  private currentOutputDeviceId: string | undefined = undefined;
  private failedOutputDeviceId: string | undefined = undefined;
  private lastLoggedUnsupportedDevice: string | undefined = undefined;
  private destroyed = false;

  get startControllers() { return this.playbackStartControllers; }
  get playbackEndedAt(): number | null { return this.outputPlaybackEndedAt; }
  get playbackSource(): AudioBufferSourceNode | null { return this.currentPlaybackSource; }

  rememberAudioConfig(audio: AudioConfig): void {
    this.currentAudio = audio;
    this.currentOutputDeviceId = audio.outputDeviceId;
  }

  applyAudioConfig(audio: AudioConfig): void {
    if (this.destroyed || isPlaybackConfigEqual(this.currentAudio, audio)) return;
    const previousDeviceId = this.currentOutputDeviceId;
    const previousVolume = this.currentAudio?.outputVolume;
    this.currentAudio = audio;
    this.currentOutputDeviceId = audio.outputDeviceId;
    if (previousDeviceId !== audio.outputDeviceId) this.failedOutputDeviceId = undefined;
    if (previousVolume !== audio.outputVolume) this.rampOutputVolume();
  }

  handleDevicesChanged(devices: MediaDeviceInfo[]): void {
    if (
      this.failedOutputDeviceId
      && devices.some((device) => (
        device.kind === 'audiooutput' && device.deviceId === this.failedOutputDeviceId
      ))
    ) {
      this.failedOutputDeviceId = undefined;
    }
  }

  enqueue(turnId: TurnId, playbackId: PlaybackId, audio: number[], sampleRate: number): void {
    const generation = ++this.playbackGeneration;
    const controller = new AbortController();
    this.playbackStartControllers.set(playbackId, { turnId, controller });
    const start = (): Promise<void> => this.playAudio(
      generation, turnId, playbackId, audio, sampleRate, controller.signal,
    ).finally(() => {
      const pending = this.playbackStartControllers.get(playbackId);
      if (pending?.controller === controller) this.playbackStartControllers.delete(playbackId);
    });
    this.playbackStartTail = this.playbackStartTail.then(start, start);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const pending of this.playbackStartControllers.values()) pending.controller.abort();
    this.stopPlayback();
    await this.playbackStartTail.catch(() => undefined);
    this.stopOutputLevelLoop();
    this.teardownPlaybackGraph();
    if (this.playbackCtx) {
      await this.playbackCtx.close();
      this.playbackCtx = null;
    }
  }

  private rampOutputVolume(): void {
    if (!this.outputGain || !this.playbackCtx || !this.currentAudio) return;
    const target = this.currentAudio.outputVolume;
    const now = this.playbackCtx.currentTime;
    this.outputGain.gain.setTargetAtTime(target, now, GAIN_RAMP_TIME_CONSTANT);
  }

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

  stopPlayback(turnId?: TurnId, playbackId?: PlaybackId): void {
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
