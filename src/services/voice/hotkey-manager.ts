// src/services/voice/hotkey-manager.ts
import { globalShortcut } from 'electron';

/**
 * Manages a global Push-to-Talk hotkey.
 *
 * Electron's globalShortcut only fires on keydown (repeated while held).
 * We detect key release by checking if the accelerator stops firing.
 */
export class HotkeyManager {
  private currentKey: string | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Register a global hotkey for push-to-talk.
   * @param key — Electron accelerator string, e.g. 'F9'
   * @param onDown — Called once when key is first pressed
   * @param onUp — Called when key is released
   */
  register(key: string, onDown: () => void, onUp: () => void): void {
    if (this.currentKey) {
      this.unregister();
    }

    this.currentKey = key;
    let isDown = false;
    let lastFireTime = 0;

    globalShortcut.register(key, () => {
      const now = Date.now();
      if (!isDown) {
        isDown = true;
        onDown();
      }
      lastFireTime = now;

      // Start polling for key release if not already polling
      if (!this.pollInterval) {
        this.pollInterval = setInterval(() => {
          if (Date.now() - lastFireTime > 200) {
            isDown = false;
            onUp();
            if (this.pollInterval) {
              clearInterval(this.pollInterval);
              this.pollInterval = null;
            }
          }
        }, 50);
      }
    });
  }

  /**
   * Unregister the current hotkey.
   */
  unregister(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.currentKey) {
      globalShortcut.unregister(this.currentKey);
      this.currentKey = null;
    }
  }
}
