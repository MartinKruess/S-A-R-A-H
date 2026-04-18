import { describe, it, expect } from 'vitest';
import { computeCpuLoad, type CpuSnapshot } from './ipc-system-metrics.js';

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
