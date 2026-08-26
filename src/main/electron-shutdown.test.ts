import { describe, expect, it, vi } from 'vitest';
import { registerElectronShutdown } from './electron-shutdown.js';

function fakeApp() {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  return {
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const current = listeners.get(event) ?? new Set();
      current.add(listener);
      listeners.set(event, current);
    }),
    removeListener: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    quit: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args as never[]);
    },
  };
}

function successfulReport() {
  return {
    services: { services: [], ok: true },
    cleanups: [],
    ok: true,
  };
}

describe('registerElectronShutdown', () => {
  it('prevents direct quit, runs cleanup once and then lets Electron quit again', async () => {
    const app = fakeApp();
    const shutdown = vi.fn(async () => successfulReport());
    registerElectronShutdown(app, () => ({ lifecycle: { shutdown } }), 'win32');
    const event = { preventDefault: vi.fn() };

    app.emit('before-quit', event);
    app.emit('before-quit', event);
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    app.emit('before-quit', event);

    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('routes window-all-closed through app.quit on Windows', () => {
    const app = fakeApp();
    registerElectronShutdown(app, () => null, 'win32');

    app.emit('window-all-closed');

    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('runs cleanup when the primary window closes while an auxiliary window remains', async () => {
    const app = fakeApp();
    const shutdown = vi.fn(async () => successfulReport());
    const coordinator = registerElectronShutdown(app, () => ({ lifecycle: { shutdown } }), 'win32');

    coordinator.handlePrimaryWindowClosed();

    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('keeps the application alive after closing all windows on macOS', () => {
    const app = fakeApp();
    registerElectronShutdown(app, () => null, 'darwin');

    app.emit('window-all-closed');

    expect(app.quit).not.toHaveBeenCalled();
  });

  it('still completes native quit if cleanup rejects', async () => {
    const app = fakeApp();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shutdown = vi.fn(async () => { throw new Error('cleanup failed'); });
    const coordinator = registerElectronShutdown(app, () => ({ lifecycle: { shutdown } }), 'win32');

    await coordinator.shutdown();

    expect(app.quit).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
