interface RendererGoneDetails {
  reason?: string;
  exitCode?: number;
}

type RendererGoneListener = (event: object, details: RendererGoneDetails) => void;
type RendererLoadedListener = () => void;

interface RendererRecoveryWebContents {
  isDestroyed(): boolean;
  on(event: 'render-process-gone', listener: RendererGoneListener): object | void;
  on(event: 'did-finish-load', listener: RendererLoadedListener): object | void;
  removeListener(event: 'render-process-gone', listener: RendererGoneListener): object | void;
  removeListener(event: 'did-finish-load', listener: RendererLoadedListener): object | void;
  reload(): void;
}

interface RendererRecoveryWindow {
  isDestroyed(): boolean;
  webContents: RendererRecoveryWebContents;
}

export interface PrimaryRendererRecoveryOptions {
  isShuttingDown: () => boolean;
  replaceWindow: () => Promise<boolean>;
  showFinalError: (message: string) => void;
  reloadDelayMs?: number;
  recoveryTimeoutMs?: number;
}

const DEFAULT_RELOAD_DELAY_MS = 100;
const DEFAULT_RECOVERY_TIMEOUT_MS = 12_000;

/**
 * Recover a crashed primary renderer without turning an intentional close into recovery.
 *
 * - Schedules one reload outside Electron's `render-process-gone` callback.
 * - Requires a completed document load within a bounded deadline.
 * - Replaces only the BrowserWindow when reload cannot recover the renderer.
 * - Surfaces a stable restart instruction instead of entering a replacement loop.
 *
 * @returns Idempotent unsubscriber for window replacement or application shutdown.
 *
 * @category Event Handler
 */
export function registerPrimaryRendererRecovery(
  window: RendererRecoveryWindow,
  options: PrimaryRendererRecoveryOptions,
): () => void {
  const reloadDelayMs = options.reloadDelayMs ?? DEFAULT_RELOAD_DELAY_MS;
  const recoveryTimeoutMs = options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
  let reloadUsed = false;
  let replacementRequested = false;
  let finalErrorShown = false;
  let cleanedUp = false;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  const webContents = window.webContents;

  const clearTimers = (): void => {
    if (reloadTimer) clearTimeout(reloadTimer);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    reloadTimer = null;
    recoveryTimer = null;
  };

  const showFinalError = (details?: RendererGoneDetails): void => {
    if (finalErrorShown || options.isShuttingDown()) return;
    finalErrorShown = true;
    const diagnostic = details?.reason
      ? `\n\nTechnischer Hinweis: ${details.reason}${details.exitCode == null ? '' : ` (${details.exitCode})`}`
      : '';
    options.showFinalError(
      `Die Benutzeroberfläche ist wiederholt abgestürzt und konnte nicht sicher wiederhergestellt werden. Bitte starte Sarah neu.${diagnostic}`,
    );
  };

  const replaceWindow = (details?: RendererGoneDetails): void => {
    if (replacementRequested || options.isShuttingDown()) return;
    replacementRequested = true;
    clearTimers();
    void options.replaceWindow().then((replaced) => {
      if (!replaced) showFinalError(details);
    }).catch(() => showFinalError(details));
  };

  const handleRendererLoaded = (): void => {
    if (!reloadUsed || replacementRequested) return;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const handleRendererGone: RendererGoneListener = (_event, details) => {
    if (options.isShuttingDown() || window.isDestroyed() || webContents.isDestroyed()) return;
    if (reloadUsed) {
      replaceWindow(details);
      return;
    }
    reloadUsed = true;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (options.isShuttingDown() || window.isDestroyed() || webContents.isDestroyed()) return;
      try {
        webContents.reload();
        recoveryTimer = setTimeout(() => replaceWindow(details), recoveryTimeoutMs);
        recoveryTimer.unref?.();
      } catch {
        replaceWindow(details);
      }
    }, reloadDelayMs);
    reloadTimer.unref?.();
  };

  webContents.on('render-process-gone', handleRendererGone);
  webContents.on('did-finish-load', handleRendererLoaded);
  return () => {
    if (cleanedUp) return;
    clearTimers();
    if (!window.isDestroyed() && !webContents.isDestroyed()) {
      webContents.removeListener('render-process-gone', handleRendererGone);
      webContents.removeListener('did-finish-load', handleRendererLoaded);
    }
    cleanedUp = true;
  };
}
