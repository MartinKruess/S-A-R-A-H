import { afterEach, describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { computeRms, registerVoiceLevelForwarder, updateBars } from '../../src/main/ipc-voice-level.js';

const CAPTURE_A = '11111111-1111-4111-8111-111111111111';
const CAPTURE_B = '22222222-2222-4222-8222-222222222222';

function fakeWindow(send: ReturnType<typeof vi.fn>, webContentsDestroyed = false): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => webContentsDestroyed,
      send,
    },
  } as unknown as BrowserWindow;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

describe('registerVoiceLevelForwarder', () => {
  it('resets the throttled history when capture ownership changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const send = vi.fn();
    const forwarder = registerVoiceLevelForwarder({
      getMainWindow: () => fakeWindow(send),
      dialogWindows: new Map(),
    });

    forwarder.onChunk(CAPTURE_A, new Float32Array([0.8]));
    forwarder.onChunk(CAPTURE_A, new Float32Array([0.7]));
    forwarder.onChunk(CAPTURE_B, new Float32Array([0.2]));
    vi.advanceTimersByTime(100);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('voice:level', expect.objectContaining({
      captureId: CAPTURE_B,
      rms: expect.closeTo(0.2),
    }));
    const latest = send.mock.calls.at(-1)?.[1] as { bars: number[] };
    expect(latest.bars.slice(0, -1).every((bar) => bar === 0)).toBe(true);
    forwarder.stop();
  });

  it('isolates destroyed and throwing renderer windows from later recipients', () => {
    const mainSend = vi.fn(() => { throw new Error('main closing'); });
    const destroyedSend = vi.fn();
    const throwingDialogSend = vi.fn(() => { throw new Error('dialog closing'); });
    const healthyDialogSend = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const forwarder = registerVoiceLevelForwarder({
      getMainWindow: () => fakeWindow(mainSend),
      dialogWindows: new Map([
        ['destroyed', fakeWindow(destroyedSend, true)],
        ['throwing', fakeWindow(throwingDialogSend)],
        ['healthy', fakeWindow(healthyDialogSend)],
      ]),
    });

    expect(() => {
      forwarder.onChunk(CAPTURE_A, new Float32Array([0.5]));
    }).not.toThrow();
    expect(destroyedSend).not.toHaveBeenCalled();
    expect(healthyDialogSend).toHaveBeenCalledWith(
      'voice:level',
      expect.objectContaining({ captureId: CAPTURE_A }),
    );
    forwarder.stop();
  });
});
