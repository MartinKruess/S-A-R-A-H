// tests/services/voice/hotkey-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  globalShortcut: {
    register: vi.fn().mockReturnValue(true),
    unregister: vi.fn(),
    isRegistered: vi.fn().mockReturnValue(false),
  },
}));

import { HotkeyManager } from '../../../src/services/voice/hotkey-manager.js';
import { globalShortcut } from 'electron';

describe('HotkeyManager', () => {
  let manager: HotkeyManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new HotkeyManager();
  });

  afterEach(() => {
    manager.unregister();
  });

  it('registers a global hotkey', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);
    expect(globalShortcut.register).toHaveBeenCalledWith('F9', expect.any(Function));
  });

  it('unregisters the hotkey', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);
    manager.unregister();
    expect(globalShortcut.unregister).toHaveBeenCalledWith('F9');
  });

  it('unregisters old key when registering new one', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);
    manager.register('F10', onDown, onUp);
    expect(globalShortcut.unregister).toHaveBeenCalledWith('F9');
    expect(globalShortcut.register).toHaveBeenCalledTimes(2);
  });

  it('calls onDown when hotkey fires', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);

    // Simulate the hotkey firing by calling the registered callback
    const registeredCallback = (globalShortcut.register as ReturnType<typeof vi.fn>).mock.calls[0][1];
    registeredCallback();
    expect(onDown).toHaveBeenCalledOnce();
  });

  it('does not call onDown multiple times while held', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);

    const registeredCallback = (globalShortcut.register as ReturnType<typeof vi.fn>).mock.calls[0][1];
    registeredCallback();
    registeredCallback(); // Simulates key repeat
    registeredCallback();
    expect(onDown).toHaveBeenCalledOnce();
  });

  it('is safe to unregister when nothing registered', () => {
    expect(() => manager.unregister()).not.toThrow();
  });
});
