import { describe, it, expect } from 'vitest';
import { computeRms, updateBars } from './ipc-voice-level.js';

describe('computeRms', () => {
  it('returns 0 for an empty buffer', () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it('returns 0 for an all-zero buffer', () => {
    expect(computeRms(new Float32Array(128))).toBe(0);
  });

  it('returns 1 for a constant-1 buffer', () => {
    const samples = new Float32Array(64);
    samples.fill(1);
    expect(computeRms(samples)).toBeCloseTo(1, 5);
  });

  it('returns 0.5 for a constant-0.5 buffer', () => {
    const samples = new Float32Array(64);
    samples.fill(0.5);
    expect(computeRms(samples)).toBeCloseTo(0.5, 5);
  });

  it('returns plausible value for a mixed signal', () => {
    const samples = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    // RMS = sqrt((0.25+0.25+0.25+0.25)/4) = 0.5
    expect(computeRms(samples)).toBeCloseTo(0.5, 5);
  });

  it('clamps result to [0, 1]', () => {
    const samples = new Float32Array([2, -2, 2, -2]);
    // Raw RMS would be 2, but we clamp to 1
    expect(computeRms(samples)).toBe(1);
  });
});

describe('updateBars', () => {
  it('starts from empty and fills up without shifting', () => {
    let bars: number[] = [];
    bars = updateBars(bars, 0.3);
    expect(bars.length).toBe(16);
    expect(bars[bars.length - 1]).toBeCloseTo(0.3, 5);
    // Oldest positions should be 0
    expect(bars[0]).toBe(0);
  });

  it('keeps length at 16 across many pushes', () => {
    let bars: number[] = new Array<number>(16).fill(0);
    for (let i = 0; i < 100; i++) {
      bars = updateBars(bars, i / 100);
      expect(bars.length).toBe(16);
    }
  });

  it('drops oldest and appends newest (FIFO, oldest → newest)', () => {
    const initial = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 0, 0, 0, 0, 0];
    const next = updateBars(initial, 0.42);
    expect(next.length).toBe(16);
    expect(next[next.length - 1]).toBeCloseTo(0.42, 5);
    // Previous newest shifts left by 1
    expect(next[next.length - 2]).toBeCloseTo(initial[initial.length - 1], 5);
    // Oldest from initial is dropped
    expect(next[0]).toBeCloseTo(initial[1], 5);
  });

  it('clamps new values into [0, 1]', () => {
    let bars: number[] = new Array<number>(16).fill(0);
    bars = updateBars(bars, 5);
    expect(bars[bars.length - 1]).toBe(1);
    bars = updateBars(bars, -3);
    expect(bars[bars.length - 1]).toBe(0);
  });

  it('handles over-full incoming arrays by trimming to 16', () => {
    const overFull = new Array<number>(25).fill(0.5);
    const next = updateBars(overFull, 0.9);
    expect(next.length).toBe(16);
    expect(next[next.length - 1]).toBeCloseTo(0.9, 5);
  });
});
