// src/renderer/services/audio-output-level.ts
//
// Shared types + pure helpers for the `audio:output-level` CustomEvent the
// AudioBridge dispatches during TTS playback. Kept DOM-free (the event itself
// is created by the bridge) so the decay math can be unit-tested without
// any AudioContext/RAF scaffolding.

/**
 * Payload for the `audio:output-level` CustomEvent. `bars` is a Float32Array
 * of length {@link OUTPUT_BAR_COUNT} with values in 0..1 for the VU meter;
 * `rms` is the 0..1 overall level over the same window.
 */
export interface AudioOutputLevelEventDetail {
  rms: number;
  bars: Float32Array;
}

/** Number of VU meter bars driven by the analyser tap. Matches voice-out.ts. */
export const OUTPUT_BAR_COUNT = 16;

/** Decay multiplier applied per RAF frame after playback ends. 0.85^25 ≈ 0.017,
 *  so at ~60fps the bars reach ~0 in about 400 ms. */
export const OUTPUT_DECAY_FACTOR = 0.85;

/** Once every bar drops below this, the RAF loop stops and a zero frame is
 *  emitted. Chosen so the idle bar (FLOOR=0.05 in voice-out.ts) overrides us. */
export const OUTPUT_DECAY_THRESHOLD = 0.001;

/**
 * Apply a multiplicative decay factor to every bar in-place and return the
 * same Float32Array for chaining. Values below a tiny epsilon are clamped to
 * zero so we don't dispatch forever on denormals.
 */
export function decayBars(bars: Float32Array, factor: number): Float32Array {
  for (let i = 0; i < bars.length; i++) {
    const next = bars[i] * factor;
    bars[i] = next < 1e-6 ? 0 : next;
  }
  return bars;
}

/** True when every entry in `bars` is strictly below `threshold`. */
export function allBelow(bars: Float32Array, threshold: number): boolean {
  for (let i = 0; i < bars.length; i++) {
    if (bars[i] >= threshold) return false;
  }
  return true;
}

/**
 * Compute root-mean-square over a time-domain buffer. Returns 0 for an empty
 * buffer so the caller doesn't have to guard.
 */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Downsample a time-domain buffer into `barCount` bars of per-window RMS,
 * clamped to 0..1. The output buffer is reused when provided, which lets the
 * RAF loop avoid per-frame allocations.
 */
export function barsFromTimeDomain(
  samples: Float32Array,
  barCount: number,
  out?: Float32Array,
): Float32Array {
  const bars = out && out.length === barCount ? out : new Float32Array(barCount);
  if (samples.length === 0) {
    bars.fill(0);
    return bars;
  }
  const windowSize = Math.max(1, Math.floor(samples.length / barCount));
  for (let b = 0; b < barCount; b++) {
    const start = b * windowSize;
    const end = b === barCount - 1 ? samples.length : Math.min(samples.length, start + windowSize);
    let sumSq = 0;
    let n = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      sumSq += s * s;
      n++;
    }
    const rms = n === 0 ? 0 : Math.sqrt(sumSq / n);
    bars[b] = rms > 1 ? 1 : rms;
  }
  return bars;
}

declare global {
  interface WindowEventMap {
    'audio:output-level': CustomEvent<AudioOutputLevelEventDetail>;
  }
}
