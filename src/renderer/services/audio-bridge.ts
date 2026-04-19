// src/renderer/services/audio-bridge.ts

import type { AudioConfig } from '../../core/config-schema.js';
import type { SarahApi } from '../../core/sarah-api.js';
import {
  computeEffectiveGain,
  decideCaptureReset,
  isCaptureConfigEqual,
} from './audio-bridge-logic.js';

declare const sarah: SarahApi;

const CAPTURE_SAMPLE_RATE = 16_000;

/** Time-constant for GainNode ramps. 15ms keeps mute/unmute click-free. */
const GAIN_RAMP_TIME_CONSTANT = 0.015;

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

  private unsubState: (() => void) | null = null;
  private unsubPlayAudio: (() => void) | null = null;
  private unsubAudioConfig: (() => void) | null = null;

  /** Latest applied audio config — used to short-circuit no-op updates. */
  private currentAudio: AudioConfig | undefined = undefined;
  /** Mirror of `currentAudio.inputDeviceId` for fast device-change checks. */
  private currentInputDeviceId: string | undefined = undefined;
  /** Mirror of `currentAudio.inputMuted`; short-circuits IPC push (Lücke #13). */
  private muted = false;
  /** `start()` must finish before audio-config events are processed, otherwise
   * the initial capture runs at default gain. */
  private started = false;

  async start(): Promise<void> {
    // Seed audio config first so the initial handleStateChange picks up
    // stored gain/device values before any capture is started.
    try {
      const initialConfig = await sarah.getConfig();
      this.currentAudio = initialConfig.audio;
      this.currentInputDeviceId = initialConfig.audio.inputDeviceId;
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
    this.stopCapture();
    this.stopPlayback();
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
   * React to a new persisted audio config. Idempotent — no-op if the capture
   * slice is unchanged. Device changes re-init the AudioContext (and reset
   * `workletLoaded`), gain/mute changes ramp the GainNode without tearing
   * anything down.
   */
  async applyAudioConfig(audio: AudioConfig): Promise<void> {
    if (!this.started) {
      // Avoid racing with start(): the initial getConfig() seed will supply the
      // right values when capture kicks off. Log so we can spot unexpected
      // early events.
      console.debug('[AudioBridge] audio-config arrived before start(), ignoring');
      return;
    }

    if (isCaptureConfigEqual(this.currentAudio, audio)) return;

    const prevDeviceId = this.currentInputDeviceId;
    this.currentAudio = audio;
    this.currentInputDeviceId = audio.inputDeviceId;
    this.muted = audio.inputMuted;

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

  // ── Capture ──

  private async startCapture(): Promise<void> {
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
        await this.captureCtx.audioWorklet.addModule(
          'dist/renderer/services/audio-worklet-processor.js'
        );
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
        if (isOverconstrained(err)) {
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

  private async playAudio(audio: number[], sampleRate: number): Promise<void> {
    try {
      if (!this.playbackCtx) {
        this.playbackCtx = new AudioContext({ sampleRate });
      }
      if (this.playbackCtx.state === 'suspended') {
        await this.playbackCtx.resume();
      }

      const buffer = this.playbackCtx.createBuffer(1, audio.length, sampleRate);
      buffer.getChannelData(0).set(audio);

      const source = this.playbackCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.playbackCtx.destination);

      this.currentPlaybackSource = source;

      source.onended = () => {
        this.currentPlaybackSource = null;
        sarah.voice.playbackDone();
      };

      source.start();
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
}

function isOverconstrained(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}
