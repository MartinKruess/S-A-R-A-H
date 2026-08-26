import type { AppShutdownReport } from '../core/app-lifecycle-controller.js';

interface QuitEvent {
  preventDefault(): void;
}

interface ElectronAppLifecycle {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown;
  on(event: 'window-all-closed', listener: () => void): unknown;
  removeListener(event: 'before-quit', listener: (event: QuitEvent) => void): unknown;
  removeListener(event: 'window-all-closed', listener: () => void): unknown;
  quit(): void;
}

interface ShutdownContext {
  lifecycle: {
    shutdown(): Promise<AppShutdownReport>;
  };
}

export interface ElectronShutdownCoordinator {
  shutdown(): Promise<void>;
  handlePrimaryWindowClosed(): void;
  dispose(): void;
}

/**
 * Route Electron quit and window-close events through one asynchronous cleanup.
 *
 * - Prevents the first native quit until application cleanup has settled.
 * - Shares one shutdown promise across repeated/direct quit requests.
 * - Re-enters `app.quit()` only after cleanup, where the completed guard lets it pass.
 *
 * @returns Coordinator for tests and process-lifetime disposal.
 *
 * @category Event Handler
 */
export function registerElectronShutdown(
  electronApp: ElectronAppLifecycle,
  getContext: () => ShutdownContext | null,
  platform = process.platform,
): ElectronShutdownCoordinator {
  let shutdownPromise: Promise<void> | null = null;
  let shutdownCompleted = false;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        const context = getContext();
        if (context) {
          const report = await context.lifecycle.shutdown();
          if (!report.ok) console.error('[Shutdown] Cleanup completed with errors:', report);
        }
      } catch (error) {
        console.error('[Shutdown] Unexpected lifecycle failure:', error);
      } finally {
        shutdownCompleted = true;
        electronApp.quit();
      }
    })();
    return shutdownPromise;
  };

  const onBeforeQuit = (event: QuitEvent): void => {
    if (shutdownCompleted) return;
    event.preventDefault();
    void shutdown();
  };

  const onWindowAllClosed = (): void => {
    if (platform !== 'darwin') electronApp.quit();
  };

  electronApp.on('before-quit', onBeforeQuit);
  electronApp.on('window-all-closed', onWindowAllClosed);

  return {
    shutdown,
    handlePrimaryWindowClosed: () => {
      if (platform !== 'darwin') void shutdown();
    },
    dispose: () => {
      electronApp.removeListener('before-quit', onBeforeQuit);
      electronApp.removeListener('window-all-closed', onWindowAllClosed);
    },
  };
}
