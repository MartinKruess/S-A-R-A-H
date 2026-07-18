// src/services/voice/normalize-audio.ts
//
// Pure per-utterance peak normalization for STT input. The capture path feeds
// Whisper the raw mic signal at unity gain with no AGC, so a quiet or "normal"
// mic level arrives near-silent (→ garbage) and users compensate by shouting
// (→ clipping → garbage). Normalizing each utterance to a fixed peak fixes both
// directions: quiet speech is boosted, loud speech is attenuated toward the
// target instead of clipping.

export interface NormalizeOptions {
  /** Target absolute peak the loudest sample is scaled to (0..1). */
  targetPeak?: number;
  /** Below this peak the buffer is treated as silence and left untouched, so
   *  background hiss is never amplified. */
  noiseFloor?: number;
  /** Upper bound on the applied gain, so a near-silent buffer just above the
   *  noise floor is not blown up by a huge factor. */
  maxGain?: number;
}

/**
 * Returns a peak-normalized copy of `samples`. The input is never mutated.
 * A buffer at or below the noise floor (e.g. pure silence) is returned as-is.
 */
export function normalizeUtterance(
  samples: Float32Array,
  opts: NormalizeOptions = {},
): Float32Array {
  const targetPeak = opts.targetPeak ?? 0.9;
  const noiseFloor = opts.noiseFloor ?? 0.01;
  const maxGain = opts.maxGain ?? 30;

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }

  // Silence / near-silence: leave it alone, don't amplify noise into speech.
  if (peak < noiseFloor) return samples;

  const gain = Math.min(targetPeak / peak, maxGain);
  if (gain === 1) return samples;

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * gain;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}
