import { describe, it, expect, vi } from 'vitest';
import { createAudioSync, near, persistMuteWithRollback } from './voice-audio-sync.js';

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

describe('audio persistence', () => {
  it('sends an atomic audio patch without a stale config read', async () => {
    const saveConfig = vi.fn().mockResolvedValue({});
    vi.stubGlobal('window', {
      __sarah: {
        onAudioConfigChanged: vi.fn().mockReturnValue(vi.fn()),
        getConfig: vi.fn().mockResolvedValue({ audio: {} }),
        saveConfig,
      },
    });
    const sync = createAudioSync('test', vi.fn());

    expect(await sync.persist({ inputMuted: true })).toBe(true);
    expect(saveConfig).toHaveBeenCalledWith({ audio: { inputMuted: true } });
    expect(window.__sarah?.getConfig).toHaveBeenCalledOnce();
  });

  it('rolls MUTE back visibly when persistence fails', async () => {
    const sync = {
      persist: vi.fn().mockResolvedValue(false),
      dispose: vi.fn(),
    };
    const rollback = vi.fn();

    await persistMuteWithRollback(sync, true, rollback);

    expect(sync.persist).toHaveBeenCalledWith({ inputMuted: true });
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('does not overwrite a newer config event with a stale startup snapshot', async () => {
    let resolveSnapshot!: (value: { audio: { inputMuted: boolean } }) => void;
    let applyEvent!: (audio: { inputMuted: boolean }) => void;
    vi.stubGlobal('window', {
      __sarah: {
        onAudioConfigChanged: vi.fn((listener) => {
          applyEvent = listener;
          return vi.fn();
        }),
        getConfig: vi.fn(() => new Promise((resolve) => {
          resolveSnapshot = resolve;
        })),
        saveConfig: vi.fn(),
      },
    });
    const applied: boolean[] = [];
    createAudioSync('test', (audio) => applied.push(audio.inputMuted));

    applyEvent({ inputMuted: true });
    resolveSnapshot({ audio: { inputMuted: false } });
    await Promise.resolve();

    expect(applied).toEqual([true]);
  });
});
