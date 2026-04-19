import { describe, it, expect } from 'vitest';
import { near } from './voice-audio-sync.js';

describe('near', () => {
  it('returns true for exactly equal values', () => {
    expect(near(0, 0)).toBe(true);
    expect(near(0.5, 0.5)).toBe(true);
    expect(near(1, 1)).toBe(true);
  });

  it('returns true for values within the default epsilon (1e-4)', () => {
    // Classic IPC round-trip rounding: 0.1 + 0.2 = 0.30000000000000004
    expect(near(0.1 + 0.2, 0.3)).toBe(true);
    expect(near(0.82, 0.82000005)).toBe(true);
  });

  it('returns false for values outside the default epsilon', () => {
    expect(near(0.5, 0.51)).toBe(false);
    expect(near(0.5, 0.5002)).toBe(false);
    expect(near(0, 1)).toBe(false);
  });

  it('respects a custom epsilon', () => {
    expect(near(0.5, 0.51, 0.02)).toBe(true);
    expect(near(0.5, 0.53, 0.02)).toBe(false);
  });

  it('handles negative differences symmetrically', () => {
    expect(near(0.5, 0.5 - 1e-5)).toBe(true);
    expect(near(0.5 - 1e-5, 0.5)).toBe(true);
    expect(near(0.5, 0.5 - 0.01)).toBe(false);
  });
});
