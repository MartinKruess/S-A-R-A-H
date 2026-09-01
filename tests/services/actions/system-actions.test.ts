import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SystemActions } from '../../../src/services/actions/system-actions.js';

describe('SystemActions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('platform guard rejects everything on non-win32 without touching binaries', async () => {
    const execFn = vi.fn();
    const sys = new SystemActions({ execFn, platform: 'linux' });
    expect((await sys.setVolume(50)).speak).toBe('Das unterstützt dein System nicht.');
    expect(sys.setTimer(5).speak).toBe('Das unterstützt dein System nicht.');
    expect((await sys.lockScreen()).speak).toBe('Das unterstützt dein System nicht.');
    expect(execFn).not.toHaveBeenCalled();
  });

  it('lock_screen calls rundll32 with a fixed args array', async () => {
    const execFn = vi.fn((_c: string, _a: string[], cb: (e: Error | null) => void) => cb(null));
    const sys = new SystemActions({ execFn, platform: 'win32' });
    expect((await sys.lockScreen()).ok).toBe(true);
    expect(execFn).toHaveBeenCalledWith('rundll32.exe', ['user32.dll,LockWorkStation'], expect.any(Function));
  });

  it('set_volume runs the fixed powershell script with the number inlined', async () => {
    const execFn = vi.fn((_c: string, _a: string[], cb: (e: Error | null) => void) => cb(null));
    const sys = new SystemActions({ execFn, platform: 'win32' });
    expect((await sys.setVolume(50)).ok).toBe(true);
    const args = execFn.mock.calls[0][1] as string[];
    expect(execFn.mock.calls[0][0]).toBe('powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toContain('SetMasterVolumeLevelScalar');
    expect(args[3]).toContain('0.5'); // 50% → scalar
  });

  it('timers: max 5, single notify with duration, cleanup after expiry', () => {
    const notify = vi.fn();
    const sys = new SystemActions({ execFn: vi.fn(), platform: 'win32', onNotify: notify });
    for (let i = 0; i < 5; i++) expect(sys.setTimer(10).ok).toBe(true);
    expect(sys.setTimer(10)).toEqual({ ok: false, speak: 'Ich habe schon 5 Timer laufen.' });

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(notify).toHaveBeenCalledTimes(5);
    expect(notify).toHaveBeenCalledWith('Dein 10-Minuten-Timer ist abgelaufen.');
    expect(sys.setTimer(1).ok).toBe(true); // slots free again
  });

  it('supports canonical seconds, combined durations, labels and legacy minute expiry', () => {
    const notify = vi.fn();
    const sys = new SystemActions({ execFn: vi.fn(), platform: 'win32', onNotify: notify });

    expect(sys.setTimer({ durationSeconds: 1 })).toEqual({ ok: true });
    expect(sys.setTimer({ durationSeconds: 330, label: '  Brötchen  ' })).toEqual({ ok: true });
    expect(sys.setTimer(1)).toEqual({ ok: true });

    vi.advanceTimersByTime(1000);
    expect(notify).toHaveBeenCalledWith('Dein 1-Sekunden-Timer ist abgelaufen.');
    vi.advanceTimersByTime(329_000);
    expect(notify).toHaveBeenCalledWith('Dein Brötchen-Timer ist abgelaufen.');
    expect(notify).toHaveBeenCalledWith('Dein 1-Minuten-Timer ist abgelaufen.');
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it('defensively rejects invalid domain timers and values over 24 hours', () => {
    const sys = new SystemActions({ execFn: vi.fn(), platform: 'win32' });
    expect(sys.setTimer({ durationSeconds: 0 }).ok).toBe(false);
    expect(sys.setTimer({ durationSeconds: 86_401 }).ok).toBe(false);
    expect(sys.setTimer({ durationSeconds: 10, label: 'Eier]' }).ok).toBe(false);
    expect(sys.setTimer(1441).ok).toBe(false);
  });

  it('timer survives a clock jump (standby): re-arms with remaining time instead of firing early', () => {
    const notify = vi.fn();
    const sys = new SystemActions({ execFn: vi.fn(), platform: 'win32', onNotify: notify });
    const now = vi.spyOn(Date, 'now');
    const start = Date.now();
    sys.setTimer(10);
    // setTimeout fires, but only 4 real minutes have passed (throttled timeout after resume):
    now.mockReturnValue(start + 4 * 60 * 1000);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(notify).not.toHaveBeenCalled(); // re-armed with remaining 6 min
    now.mockReturnValue(start + 10 * 60 * 1000);
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('clearAllTimers cancels everything silently', () => {
    const notify = vi.fn();
    const sys = new SystemActions({ execFn: vi.fn(), platform: 'win32', onNotify: notify });
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    sys.setTimer(5, controller.signal);
    sys.clearAllTimers();
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(notify).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('cancels one timer by exact normalized label and leaves other timers running', () => {
    const notify = vi.fn();
    const sys = new SystemActions({ execFn: vi.fn(), platform: 'win32', onNotify: notify });
    sys.setTimer({ durationSeconds: 10, label: 'Brötchen' });
    sys.setTimer({ durationSeconds: 10, label: 'Eier' });

    expect(sys.cancelTimers({ kind: 'label', label: '  eIER  ' })).toEqual({
      ok: true,
      speak: 'Der Eier-Timer wurde abgebrochen.',
    });
    vi.advanceTimersByTime(10_000);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Dein Brötchen-Timer ist abgelaufen.');
  });

  it('cancels one timer by exact duration', () => {
    const notify = vi.fn();
    const sys = new SystemActions({ execFn: vi.fn(), platform: 'win32', onNotify: notify });
    sys.setTimer({ durationSeconds: 10, label: 'Eier' });
    sys.setTimer({ durationSeconds: 15, label: 'Brötchen' });

    expect(sys.cancelTimers({ kind: 'duration', durationSeconds: 10 })).toEqual({
      ok: true,
      speak: 'Der 10-Sekunden-Timer wurde abgebrochen.',
    });
    vi.advanceTimersByTime(15_000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Dein Brötchen-Timer ist abgelaufen.');
  });

  it('cancels nothing for missing and ambiguous selectors', () => {
    const notify = vi.fn();
    const sys = new SystemActions({ execFn: vi.fn(), platform: 'win32', onNotify: notify });
    sys.setTimer({ durationSeconds: 10, label: 'Eier' });
    sys.setTimer({ durationSeconds: 10, label: 'Eier' });

    expect(sys.cancelTimers({ kind: 'label', label: 'Nudeln' }).ok).toBe(false);
    expect(sys.cancelTimers({ kind: 'label', label: 'Eier' }).speak).toContain('mehrere');
    expect(sys.cancelTimers({ kind: 'duration', durationSeconds: 10 }).speak).toContain('mehrere');
    vi.advanceTimersByTime(10_000);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('cancels all timers explicitly while clearAllTimers remains silent', () => {
    const notify = vi.fn();
    const sys = new SystemActions({ execFn: vi.fn(), platform: 'win32', onNotify: notify });
    sys.setTimer({ durationSeconds: 10, label: 'Eier' });
    sys.setTimer({ durationSeconds: 20, label: 'Brötchen' });
    expect(sys.cancelTimers({ kind: 'all' })).toEqual({
      ok: true,
      speak: 'Alle laufenden Timer wurden abgebrochen.',
    });
    expect(sys.cancelTimers({ kind: 'all' })).toEqual({ ok: false, speak: 'Es laufen keine Timer.' });
    vi.advanceTimersByTime(20_000);
    expect(notify).not.toHaveBeenCalled();

    sys.setTimer({ durationSeconds: 1 });
    sys.clearAllTimers();
    vi.advanceTimersByTime(1000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('cancels an armed timer when its owning action is aborted', () => {
    const notify = vi.fn();
    const sys = new SystemActions({ execFn: vi.fn(), platform: 'win32', onNotify: notify });
    const controller = new AbortController();

    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    expect(sys.setTimer(5, controller.signal)).toEqual({ ok: true });
    controller.abort();
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(notify).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(sys.setTimer(1)).toEqual({ ok: true });
  });
});
