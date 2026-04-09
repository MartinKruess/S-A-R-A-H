// src/services/voice/hotkey-manager.ts
import { globalShortcut } from 'electron';

/**
 * Manages a global Push-to-Talk hotkey.
 *
 * Uses toggle mode: first press → onDown, second press → onUp.
 * Includes debounce to ignore key-repeat events from globalShortcut.
 */
export class HotkeyManager {
  private currentKey: string | null = null;

  /** Minimum ms between toggle events (ignores key-repeat) */
  private static readonly DEBOUNCE_MS = 300;

  /**
   * Register a global hotkey for push-to-talk (toggle mode).
   * First press calls onDown, second press calls onUp.
   */
  register(key: string, onDown: () => void, onUp: () => void): void {
    if (this.currentKey) {
      this.unregister();
    }

    this.currentKey = key;
    let isDown = false;
    let lastToggleTime = 0;

    const success = globalShortcut.register(key, () => {
      const now = Date.now();
      if (now - lastToggleTime < HotkeyManager.DEBOUNCE_MS) return;
      lastToggleTime = now;

      if (!isDown) {
        isDown = true;
        onDown();
      } else {
        isDown = false;
        onUp();
      }
    });
    process.stderr.write(`\n=== HOTKEY REGISTER: key='${key}' success=${success} (toggle mode) ===\n`);
  }

  /**
   * Unregister the current hotkey.
   */
  unregister(): void {
    if (this.currentKey) {
      globalShortcut.unregister(this.currentKey);
      this.currentKey = null;
    }
  }
}
