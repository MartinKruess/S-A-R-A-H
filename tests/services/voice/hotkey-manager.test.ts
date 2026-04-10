// tests/services/voice/hotkey-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock uiohook-napi with an EventEmitter-like object
const mockUIOhook = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  start: vi.fn(),
}));

vi.mock('uiohook-napi', () => ({
  uIOhook: mockUIOhook,
  UiohookKey: {
    F1: 0x3b,
    F2: 0x3c,
    F3: 0x3d,
    F4: 0x3e,
    F5: 0x3f,
    F6: 0x40,
    F7: 0x41,
    F8: 0x42,
    F9: 0x43,
    F10: 0x44,
    F11: 0x57,
    F12: 0x58,
  },
}));

import { HotkeyManager } from '../../../src/services/voice/hotkey-manager.js';

/** Helper: find the registered handler for a given event type */
function getHandler(event: 'keydown' | 'keyup'): (e: { keycode: number }) => void {
  const call = mockUIOhook.on.mock.calls.find(
    (c: [string, (e: { keycode: number }) => void]) => c[0] === event,
  );
  return call![1];
}

describe('HotkeyManager', () => {
  let manager: HotkeyManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new HotkeyManager();
  });

  afterEach(() => {
    manager.unregister();
  });

  it('register calls uIOhook.start and sets up listeners', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);

    expect(mockUIOhook.on).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(mockUIOhook.on).toHaveBeenCalledWith('keyup', expect.any(Function));
    expect(mockUIOhook.start).toHaveBeenCalledOnce();
  });

  it('keydown triggers onDown, keyup triggers onUp', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);

    const keydownHandler = getHandler('keydown');
    const keyupHandler = getHandler('keyup');

    keydownHandler({ keycode: 0x43 }); // F9
    expect(onDown).toHaveBeenCalledOnce();

    keyupHandler({ keycode: 0x43 });
    expect(onUp).toHaveBeenCalledOnce();
  });

  it('ignores keydown repeat (already down)', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);

    const keydownHandler = getHandler('keydown');

    keydownHandler({ keycode: 0x43 });
    keydownHandler({ keycode: 0x43 }); // repeat — should be ignored
    keydownHandler({ keycode: 0x43 }); // repeat — should be ignored

    expect(onDown).toHaveBeenCalledOnce();
  });

  it('ignores events for wrong keycode', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);

    const keydownHandler = getHandler('keydown');
    const keyupHandler = getHandler('keyup');

    keydownHandler({ keycode: 0x44 }); // F10, not F9
    keyupHandler({ keycode: 0x44 });

    expect(onDown).not.toHaveBeenCalled();
    expect(onUp).not.toHaveBeenCalled();
  });

  it('unregister removes listeners', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);

    const keydownHandler = getHandler('keydown');
    const keyupHandler = getHandler('keyup');

    manager.unregister();

    expect(mockUIOhook.off).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(mockUIOhook.off).toHaveBeenCalledWith('keyup', expect.any(Function));

    // Callbacks should no longer fire (onDown/onUp nulled out)
    keydownHandler({ keycode: 0x43 });
    keyupHandler({ keycode: 0x43 });

    expect(onDown).not.toHaveBeenCalled();
    expect(onUp).not.toHaveBeenCalled();
  });

  it('re-register unregisters first', () => {
    const onDown1 = vi.fn();
    const onUp1 = vi.fn();
    manager.register('F9', onDown1, onUp1);

    const onDown2 = vi.fn();
    const onUp2 = vi.fn();
    manager.register('F10', onDown2, onUp2);

    // First registration's listeners should have been removed
    expect(mockUIOhook.off).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(mockUIOhook.off).toHaveBeenCalledWith('keyup', expect.any(Function));

    // Second registration should set up new listeners
    expect(mockUIOhook.on).toHaveBeenCalledTimes(4); // 2 per register call
    // start should only be called once (first register)
    expect(mockUIOhook.start).toHaveBeenCalledOnce();
  });

  it('is safe to unregister when nothing registered', () => {
    expect(() => manager.unregister()).not.toThrow();
  });
});
