import { describe, it, expect } from 'vitest';
import { normalizeUtterance } from '../../../src/services/voice/normalize-audio.js';

function peak(a: Float32Array): number {
  let p = 0;
  for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
}

describe('normalizeUtterance', () => {
  it('boosts a quiet utterance up to the target peak', () => {
    const quiet = new Float32Array([0.05, -0.03, 0.04, -0.05]);
    const out = normalizeUtterance(quiet);
    expect(peak(out)).toBeCloseTo(0.9, 5);
  });

  it('attenuates a loud/near-clipping utterance down to the target peak', () => {
    const loud = new Float32Array([1, -1, 0.8, -0.95]);
    const out = normalizeUtterance(loud);
    expect(peak(out)).toBeCloseTo(0.9, 5);
  });

  it('leaves silence untouched instead of amplifying noise', () => {
    const silence = new Float32Array([0, 0, 0, 0]);
    expect(normalizeUtterance(silence)).toBe(silence);
  });

  it('leaves near-silence below the noise floor untouched', () => {
    const hiss = new Float32Array([0.005, -0.004, 0.003]);
    expect(normalizeUtterance(hiss)).toBe(hiss);
  });

  it('caps the applied gain so a barely-audible buffer is not blown up', () => {
    // peak 0.02 → uncapped gain would be 45×; maxGain 30 caps it → peak 0.6.
    const faint = new Float32Array([0.02, -0.02, 0.01]);
    const out = normalizeUtterance(faint);
    expect(peak(out)).toBeCloseTo(0.6, 5);
  });

  it('never returns samples outside [-1, 1]', () => {
    const out = normalizeUtterance(new Float32Array([0.5, -0.5, 0.2]));
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(-1);
      expect(out[i]).toBeLessThanOrEqual(1);
    }
  });

  it('does not mutate the input buffer', () => {
    const input = new Float32Array([0.05, -0.05]);
    const copy = Float32Array.from(input);
    normalizeUtterance(input);
    expect(input).toEqual(copy);
  });
});
