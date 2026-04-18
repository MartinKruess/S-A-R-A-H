import { describe, it, expect } from 'vitest';
import { computeCpuLoad, decideGpuValue, type CpuSnapshot } from './ipc-system-metrics.js';

function snap(idle: number, total: number): CpuSnapshot {
  return { idle, total };
}

describe('computeCpuLoad', () => {
  it('returns 1 when no idle delta (100% busy)', () => {
    const prev: CpuSnapshot[] = [snap(1000, 2000), snap(1000, 2000)];
    const curr: CpuSnapshot[] = [snap(1000, 3000), snap(1000, 3000)];
    expect(computeCpuLoad(prev, curr)).toBe(1);
  });

  it('returns 0 when idle equals total delta (100% idle)', () => {
    const prev: CpuSnapshot[] = [snap(1000, 2000), snap(1000, 2000)];
    const curr: CpuSnapshot[] = [snap(2000, 3000), snap(2000, 3000)];
    expect(computeCpuLoad(prev, curr)).toBe(0);
  });

  it('returns 0 when snapshots are equal (no elapsed time)', () => {
    const prev: CpuSnapshot[] = [snap(1000, 2000), snap(1000, 2000)];
    const curr: CpuSnapshot[] = [snap(1000, 2000), snap(1000, 2000)];
    expect(computeCpuLoad(prev, curr)).toBe(0);
  });

  it('returns expected mid-load fraction', () => {
    const prev: CpuSnapshot[] = [snap(1000, 2000)];
    // idleDelta = 250, totalDelta = 1000 → busy = 0.75
    const curr: CpuSnapshot[] = [snap(1250, 3000)];
    expect(computeCpuLoad(prev, curr)).toBeCloseTo(0.75, 5);
  });

  it('averages across cores', () => {
    const prev: CpuSnapshot[] = [snap(1000, 2000), snap(1000, 2000)];
    // Core 0: busy 1.0, Core 1: busy 0.0 → avg 0.5
    const curr: CpuSnapshot[] = [snap(1000, 3000), snap(2000, 3000)];
    expect(computeCpuLoad(prev, curr)).toBeCloseTo(0.5, 5);
  });

  it('handles empty snapshots defensively', () => {
    expect(computeCpuLoad([], [])).toBe(0);
    expect(computeCpuLoad([snap(0, 0)], [])).toBe(0);
  });

  it('clamps negative deltas defensively (ignores core)', () => {
    const prev: CpuSnapshot[] = [snap(1000, 2000)];
    // totalDelta = 0 → this core is skipped, result 0
    const curr: CpuSnapshot[] = [snap(500, 2000)];
    expect(computeCpuLoad(prev, curr)).toBe(0);
  });
});

describe('decideGpuValue', () => {
  it('passes a normal percentage through as 0..1 and resets zero counter', () => {
    const res = decideGpuValue(3, 42, false);
    expect(res.value).toBeCloseTo(0.42, 5);
    expect(res.nextConsecutiveZeros).toBe(0);
    expect(res.nextDisabled).toBe(false);
  });

  it('clamps raw values above 100 to 1', () => {
    const res = decideGpuValue(0, 150, false);
    expect(res.value).toBe(1);
  });

  it('treats 4 consecutive zeros as null but not yet disabled', () => {
    let consecutive = 0;
    let disabled = false;
    let value: number | null = 0;
    for (let i = 0; i < 4; i++) {
      const r = decideGpuValue(consecutive, 0, disabled);
      consecutive = r.nextConsecutiveZeros;
      disabled = r.nextDisabled;
      value = r.value;
    }
    expect(consecutive).toBe(4);
    expect(disabled).toBe(false);
    expect(value).toBeNull();
  });

  it('disables permanently after 5 consecutive zeros', () => {
    let consecutive = 0;
    let disabled = false;
    for (let i = 0; i < 5; i++) {
      const r = decideGpuValue(consecutive, 0, disabled);
      consecutive = r.nextConsecutiveZeros;
      disabled = r.nextDisabled;
    }
    expect(consecutive).toBe(5);
    expect(disabled).toBe(true);
  });

  it('disables after 5 consecutive undefineds as well', () => {
    let consecutive = 0;
    let disabled = false;
    for (let i = 0; i < 5; i++) {
      const r = decideGpuValue(consecutive, undefined, disabled);
      consecutive = r.nextConsecutiveZeros;
      disabled = r.nextDisabled;
    }
    expect(disabled).toBe(true);
  });

  it('once disabled, never revives even on a valid non-zero reading', () => {
    const res = decideGpuValue(5, 73, true);
    expect(res.value).toBeNull();
    expect(res.nextDisabled).toBe(true);
  });

  it('resets the zero counter on a valid non-zero reading before disable', () => {
    const a = decideGpuValue(4, 0, false);
    expect(a.nextConsecutiveZeros).toBe(5);
    expect(a.nextDisabled).toBe(true);

    const b = decideGpuValue(4, 25, false);
    expect(b.value).toBeCloseTo(0.25, 5);
    expect(b.nextConsecutiveZeros).toBe(0);
    expect(b.nextDisabled).toBe(false);
  });
});
