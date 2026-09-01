import { describe, expect, it, vi } from 'vitest';
import { acquireSingleInstanceLock } from '../../src/main/single-instance.js';

function createApp(lockGranted: boolean) {
  let secondInstance: (() => void) | null = null;
  return {
    app: {
      requestSingleInstanceLock: vi.fn(() => lockGranted),
      on: vi.fn((_event: 'second-instance', listener: () => void) => {
        secondInstance = listener;
      }),
      quit: vi.fn(),
    },
    emitSecondInstance: () => secondInstance?.(),
  };
}

describe('acquireSingleInstanceLock', () => {
  it('quits a secondary process without registering shared-runtime handlers', () => {
    const { app } = createApp(false);

    expect(acquireSingleInstanceLock(app, () => null)).toBe(false);

    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.on).not.toHaveBeenCalled();
  });

  it('restores, shows and focuses the existing primary window on a second launch', () => {
    const { app, emitSecondInstance } = createApp(true);
    const window = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    expect(acquireSingleInstanceLock(app, () => window)).toBe(true);
    emitSecondInstance();

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('does not touch a destroyed primary window', () => {
    const { app, emitSecondInstance } = createApp(true);
    const window = {
      isDestroyed: vi.fn(() => true),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    acquireSingleInstanceLock(app, () => window);
    emitSecondInstance();

    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });
});
