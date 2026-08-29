import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPrimaryRendererRecovery } from './primary-renderer-recovery.js';

type GoneDetails = { reason?: string; exitCode?: number };
type GoneListener = (event: object, details: GoneDetails) => void;
type LoadedListener = () => void;

class FakeWebContents {
  readonly reload = vi.fn();
  private goneListener: GoneListener | null = null;
  private loadedListener: LoadedListener | null = null;
  destroyed = false;

  isDestroyed(): boolean { return this.destroyed; }

  on(event: 'render-process-gone', listener: GoneListener): object;
  on(event: 'did-finish-load', listener: LoadedListener): object;
  on(event: 'render-process-gone' | 'did-finish-load', listener: GoneListener | LoadedListener): object {
    if (event === 'render-process-gone') this.goneListener = listener as GoneListener;
    else this.loadedListener = listener as LoadedListener;
    return this;
  }

  removeListener(event: 'render-process-gone', listener: GoneListener): object;
  removeListener(event: 'did-finish-load', listener: LoadedListener): object;
  removeListener(
    event: 'render-process-gone' | 'did-finish-load',
    listener: GoneListener | LoadedListener,
  ): object {
    if (event === 'render-process-gone' && this.goneListener === listener) this.goneListener = null;
    if (event === 'did-finish-load' && this.loadedListener === listener) this.loadedListener = null;
    return this;
  }

  emitGone(details: GoneDetails = {}): void { this.goneListener?.({}, details); }
  emitLoaded(): void { this.loadedListener?.(); }
  hasGoneListener(): boolean { return this.goneListener !== null; }
}

function createFixture() {
  const webContents = new FakeWebContents();
  let windowDestroyed = false;
  return {
    webContents,
    window: {
      isDestroyed: () => windowDestroyed,
      webContents,
    },
    destroyWindow: () => { windowDestroyed = true; },
  };
}

describe('primary renderer crash recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reloads outside the crash callback and accepts a completed document load', async () => {
    const fixture = createFixture();
    const replaceWindow = vi.fn(async () => true);
    registerPrimaryRendererRecovery(fixture.window, {
      isShuttingDown: () => false,
      replaceWindow,
      showFinalError: vi.fn(),
      reloadDelayMs: 10,
      recoveryTimeoutMs: 100,
    });

    fixture.webContents.emitGone({ reason: 'crashed' });
    expect(fixture.webContents.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(fixture.webContents.reload).toHaveBeenCalledOnce();
    fixture.webContents.emitLoaded();
    await vi.advanceTimersByTimeAsync(100);

    expect(replaceWindow).not.toHaveBeenCalled();
  });

  it('replaces only the window when reload does not finish by the deadline', async () => {
    const fixture = createFixture();
    const replaceWindow = vi.fn(async () => true);
    registerPrimaryRendererRecovery(fixture.window, {
      isShuttingDown: () => false,
      replaceWindow,
      showFinalError: vi.fn(),
      reloadDelayMs: 10,
      recoveryTimeoutMs: 100,
    });

    fixture.webContents.emitGone({ reason: 'oom', exitCode: 22 });
    await vi.advanceTimersByTimeAsync(110);

    expect(replaceWindow).toHaveBeenCalledOnce();
  });

  it('uses the bounded replacement after a second crash in the same window', async () => {
    const fixture = createFixture();
    const replaceWindow = vi.fn(async () => true);
    registerPrimaryRendererRecovery(fixture.window, {
      isShuttingDown: () => false,
      replaceWindow,
      showFinalError: vi.fn(),
      reloadDelayMs: 10,
      recoveryTimeoutMs: 100,
    });

    fixture.webContents.emitGone({ reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(10);
    fixture.webContents.emitLoaded();
    fixture.webContents.emitGone({ reason: 'killed' });
    await Promise.resolve();

    expect(replaceWindow).toHaveBeenCalledOnce();
  });

  it('shows a final restart instruction if bounded window replacement is unavailable', async () => {
    const fixture = createFixture();
    const showFinalError = vi.fn();
    registerPrimaryRendererRecovery(fixture.window, {
      isShuttingDown: () => false,
      replaceWindow: async () => false,
      showFinalError,
      reloadDelayMs: 10,
      recoveryTimeoutMs: 100,
    });

    fixture.webContents.emitGone({ reason: 'oom', exitCode: 22 });
    await vi.advanceTimersByTimeAsync(110);

    expect(showFinalError).toHaveBeenCalledOnce();
    expect(showFinalError).toHaveBeenCalledWith(expect.stringContaining('oom (22)'));
  });

  it('does not recover during shutdown and removes its listener on cleanup', async () => {
    const fixture = createFixture();
    const replaceWindow = vi.fn(async () => true);
    const cleanup = registerPrimaryRendererRecovery(fixture.window, {
      isShuttingDown: () => true,
      replaceWindow,
      showFinalError: vi.fn(),
      reloadDelayMs: 10,
      recoveryTimeoutMs: 100,
    });

    fixture.webContents.emitGone({ reason: 'killed' });
    cleanup();
    await vi.runAllTimersAsync();

    expect(fixture.webContents.reload).not.toHaveBeenCalled();
    expect(replaceWindow).not.toHaveBeenCalled();
    expect(fixture.webContents.hasGoneListener()).toBe(false);
  });

  it('keeps cleanup idempotent after the BrowserWindow was destroyed', () => {
    const fixture = createFixture();
    const cleanup = registerPrimaryRendererRecovery(fixture.window, {
      isShuttingDown: () => true,
      replaceWindow: async () => false,
      showFinalError: vi.fn(),
    });

    fixture.destroyWindow();
    cleanup();
    cleanup();
  });
});
