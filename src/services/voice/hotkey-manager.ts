// src/services/voice/hotkey-manager.ts
import { uIOhook, UiohookKey } from 'uiohook-napi';

// Map common key names to uiohook keycodes
const KEY_MAP: Record<string, number> = {
  F1: UiohookKey.F1,
  F2: UiohookKey.F2,
  F3: UiohookKey.F3,
  F4: UiohookKey.F4,
  F5: UiohookKey.F5,
  F6: UiohookKey.F6,
  F7: UiohookKey.F7,
  F8: UiohookKey.F8,
  F9: UiohookKey.F9,
  F10: UiohookKey.F10,
  F11: UiohookKey.F11,
  F12: UiohookKey.F12,
};

/**
 * Manages a global Push-to-Talk hotkey using uiohook-napi.
 *
 * Uses hold mode: keydown → onDown, keyup → onUp.
 * Detects real key-up events for true hold-to-talk behavior.
 */
export class HotkeyManager {
  private currentKey: string | null = null;
  private keyCode: number | null = null;
  private isDown = false;
  private onDown: (() => void) | null = null;
  private onUp: (() => void) | null = null;
  private started = false;

  private keydownHandler = (e: { keycode: number }) => {
    if (e.keycode === this.keyCode && !this.isDown) {
      this.isDown = true;
      this.onDown?.();
    }
  };

  private keyupHandler = (e: { keycode: number }) => {
    if (e.keycode === this.keyCode && this.isDown) {
      this.isDown = false;
      this.onUp?.();
    }
  };

  /**
   * Register a global hotkey for hold-to-talk.
   * Hold key → onDown, release key → onUp.
   */
  register(key: string, onDown: () => void, onUp: () => void): void {
    if (this.currentKey) {
      this.unregister();
    }

    const keyCode = KEY_MAP[key];
    if (keyCode === undefined) {
      console.warn(`[HotkeyManager] Unknown key: '${key}', falling back to toggle mode`);
      return;
    }

    this.currentKey = key;
    this.keyCode = keyCode;
    this.onDown = onDown;
    this.onUp = onUp;
    this.isDown = false;

    uIOhook.on('keydown', this.keydownHandler);
    uIOhook.on('keyup', this.keyupHandler);

    if (!this.started) {
      uIOhook.start();
      this.started = true;
    }

  }

  /**
   * Unregister the current hotkey.
   */
  unregister(): void {
    if (this.currentKey) {
      uIOhook.off('keydown', this.keydownHandler);
      uIOhook.off('keyup', this.keyupHandler);
      this.currentKey = null;
      this.keyCode = null;
      this.onDown = null;
      this.onUp = null;
      this.isDown = false;
    }
  }
}
