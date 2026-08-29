interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: () => void): unknown;
  quit(): void;
}

interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Claims process ownership before the primary runtime allocates shared resources.
 *
 * - Quits a secondary process immediately when the lock is unavailable.
 * - Restores and focuses the primary window when another launch is attempted.
 *
 * @returns `true` only for the process allowed to continue bootstrapping.
 *
 * @category Event Handler Authorization
 */
export function acquireSingleInstanceLock(
  electronApp: SingleInstanceApp,
  getMainWindow: () => FocusableWindow | null,
): boolean {
  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return false;
  }

  electronApp.on('second-instance', () => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
