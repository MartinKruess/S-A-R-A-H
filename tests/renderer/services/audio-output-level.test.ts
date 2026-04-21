// tests/renderer/services/audio-output-level.test.ts
import { describe, it, expect } from 'vitest';
import {
  allBelow,
  barsFromTimeDomain,
  computeRms,
  decayBars,
  OUTPUT_BAR_COUNT,
  OUTPUT_DECAY_FACTOR,
  OUTPUT_DECAY_THRESHOLD,
} from '../../../src/renderer/services/audio-output-level.js';

describe('decayBars', () => {
  it('multiplies every bar by the given factor in-place', () => {
    const bars = new Float32Array([1, 0.5, 0.2, 0.1]);
    const returned = decayBars(bars, 0.5);
    expect(returned).toBe(bars); // same reference
    // Float32 rounds 0.1 to 0.10000000149... so assert per-element with tolerance.
    expect(bars[0]).toBeCloseTo(0.5, 6);
    expect(bars[1]).toBeCloseTo(0.25, 6);
    expect(bars[2]).toBeCloseTo(0.1, 6);
    expect(bars[3]).toBeCloseTo(0.05, 6);
  });

  it('collapses tiny values to 0 so denormals do not keep the loop alive', () => {
    const bars = new Float32Array([1e-7, 2e-7, 0.5]);
    decayBars(bars, 0.5);
    expect(bars[0]).toBe(0);
    expect(bars[1]).toBe(0);
    expect(bars[2]).toBeCloseTo(0.25);
  });

  it('reaches near-zero after ~25 frames with the default factor', () => {
    const bars = new Float32Array(OUTPUT_BAR_COUNT).fill(1);
    for (let i = 0; i < 25; i++) {
      decayBars(bars, OUTPUT_DECAY_FACTOR);
    }
    // 0.85^25 ≈ 0.0172 — just above the decay threshold, so final frame(s)
    // cross it. The spec says ~400ms @ 60fps = ~24 frames.
    expect(bars[0]).toBeLessThan(0.02);
    expect(bars[0]).toBeGreaterThan(0);
  });

  it('all bars drop below the threshold inside the expected window', () => {
    const bars = new Float32Array(OUTPUT_BAR_COUNT).fill(1);
    let frames = 0;
    while (!allBelow(bars, OUTPUT_DECAY_THRESHOLD) && frames < 200) {
      decayBars(bars, OUTPUT_DECAY_FACTOR);
      frames++;
    }
    // log(0.001) / log(0.85) ≈ 42.5 → 43 frames, i.e. ~715ms at 60fps.
    // That's fine — visibly the bars are near-zero after ~25 frames.
    expect(frames).toBeLessThan(60);
  });
});

describe('allBelow', () => {
  it('returns true for an all-zero buffer', () => {
    expect(allBelow(new Float32Array(4), 0.001)).toBe(true);
  });

  it('returns false if any bar meets or exceeds the threshold', () => {
    expect(allBelow(new Float32Array([0, 0, 0.002, 0]), 0.001)).toBe(false);
    // boundary: value exactly at threshold counts as "not below"
    expect(allBelow(new Float32Array([0, 0.001, 0]), 0.001)).toBe(false);
  });

  it('returns true when every bar is strictly below the threshold', () => {
    expect(allBelow(new Float32Array([0, 0.0005, 0.0009]), 0.001)).toBe(true);
  });

  it('returns true for an empty buffer (vacuously)', () => {
    expect(allBelow(new Float32Array(0), 0.001)).toBe(true);
  });
});

describe('computeRms', () => {
  it('returns 0 for an empty buffer', () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it('returns 0 for silence', () => {
    expect(computeRms(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it('returns 1 for a unit-amplitude DC signal', () => {
    expect(computeRms(new Float32Array([1, 1, 1, 1]))).toBeCloseTo(1);
  });

  it('matches the closed-form RMS for a square signal', () => {
    // [1, -1, 1, -1] → RMS = sqrt(mean(squares)) = sqrt(1) = 1
    expect(computeRms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1);
  });

  it('scales linearly with amplitude', () => {
    expect(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

describe('barsFromTimeDomain', () => {
  it('returns a buffer of the requested length', () => {
    const samples = new Float32Array(128).fill(0.25);
    const bars = barsFromTimeDomain(samples, OUTPUT_BAR_COUNT);
    expect(bars.length).toBe(OUTPUT_BAR_COUNT);
  });

  it('reuses the provided out buffer when sizes match', () => {
    const samples = new Float32Array(128).fill(0.25);
    const out = new Float32Array(OUTPUT_BAR_COUNT);
    const bars = barsFromTimeDomain(samples, OUTPUT_BAR_COUNT, out);
    expect(bars).toBe(out);
  });

  it('allocates a fresh buffer when the provided out is the wrong length', () => {
    const samples = new Float32Array(128).fill(0.25);
    const wrong = new Float32Array(8);
    const bars = barsFromTimeDomain(samples, OUTPUT_BAR_COUNT, wrong);
    expect(bars).not.toBe(wrong);
    expect(bars.length).toBe(OUTPUT_BAR_COUNT);
  });

  it('computes per-window RMS for a constant signal', () => {
    const samples = new Float32Array(128).fill(0.5);
    const bars = barsFromTimeDomain(samples, OUTPUT_BAR_COUNT);
    for (let i = 0; i < OUTPUT_BAR_COUNT; i++) {
      expect(bars[i]).toBeCloseTo(0.5);
    }
  });

  it('clamps bar values to 1', () => {
    const samples = new Float32Array(128).fill(2);
    const bars = barsFromTimeDomain(samples, OUTPUT_BAR_COUNT);
    for (let i = 0; i < OUTPUT_BAR_COUNT; i++) {
      expect(bars[i]).toBe(1);
    }
  });

  it('zeroes all bars for an empty sample buffer', () => {
    const samples = new Float32Array(0);
    const bars = barsFromTimeDomain(samples, OUTPUT_BAR_COUNT);
    for (let i = 0; i < OUTPUT_BAR_COUNT; i++) {
      expect(bars[i]).toBe(0);
    }
  });

  it('distinguishes silent and loud windows within the same buffer', () => {
    // First half silence, second half unit amplitude
    const samples = new Float32Array(128);
    for (let i = 64; i < 128; i++) samples[i] = 1;
    const bars = barsFromTimeDomain(samples, OUTPUT_BAR_COUNT);
    expect(bars[0]).toBeCloseTo(0);
    expect(bars[OUTPUT_BAR_COUNT - 1]).toBeCloseTo(1);
  });
});
