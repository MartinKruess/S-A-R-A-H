import { app, BrowserWindow, ipcMain, dialog, powerMonitor } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { bootstrap, repairInvalidConfig, AppContext } from './core/bootstrap.js';
import { RouterService } from './services/llm/router-service.js';
import { OllamaContainerManager } from './services/llm/ollama-container-manager.js';
import { ModelRuntime } from './services/llm/model-runtime.js';
import { VoiceService } from './services/voice/voice-service.js';
import { SandboxBrowser } from './main/sandbox-browser.js';
import { ProgramLauncher } from './main/program-launcher.js';
import { SystemActions } from './services/actions/system-actions.js';
import { SpotifyActions } from './services/actions/spotify-actions.js';
import { ActionService } from './services/actions/action-service.js';
import { ReminderStore } from './services/reminders/reminder-store.js';
import { ReminderService } from './services/reminders/reminder-service.js';
import { WindowsMediaController } from './services/actions/media-controller.js';
import { SearchService } from './services/search/search-service.js';
import { EmbeddedBrowserSearchProvider } from './services/search/embedded-browser-search-provider.js';
import { SUMMARY_NUM_PREDICT, SUMMARY_TEMPERATURE } from './services/search/summarize-results.js';
import { registerProgramHandlers } from './main/ipc-programs.js';
import { registerConfigHandlers } from './main/ipc-config.js';
import { registerConnectionHandlers } from './main/ipc-connections.js';
import { KeyAccessError, KeyManager } from './core/crypto/key-manager.js';
import { resetAfterFinalKeyLoss } from './core/crypto/key-loss-reset.js';
import { TokenStore } from './services/integrations/token-store.js';
import { OAuthConnectionService } from './services/integrations/oauth-connection-service.js';
import { getOAuthProviders, redirectPort } from './services/integrations/providers.js';
import { registerVoiceHandlers } from './main/ipc-voice.js';
import { registerBootHandlers } from './main/boot-sequence.js';
import { registerSystemMetricsHandlers } from './main/ipc-system-metrics.js';
import { registerVoiceLevelForwarder } from './main/ipc-voice-level.js';
import {
  registerElectronShutdown,
  type ElectronShutdownCoordinator,
} from './main/electron-shutdown.js';
import { registerVoiceRendererLifecycle } from './main/voice-renderer-lifecycle.js';
import { registerPrimaryRendererRecovery } from './main/primary-renderer-recovery.js';
import { handleFinalKeyLossRecovery } from './main/final-key-loss-recovery.js';
import { retryTransientKeyAccess } from './main/key-access-retry.js';
import { acquireSingleInstanceLock } from './main/single-instance.js';

let mainWindow: BrowserWindow | null = null;
let appContext: AppContext | null = null;
const dialogWindows = new Map<string, BrowserWindow>();
let stopSystemMetrics: (() => void) | null = null;
let stopVoiceLevel: (() => void) | null = null;
let sandboxBrowser: SandboxBrowser | null = null;
let systemActions: SystemActions | null = null;
let bindPrimaryWindowLifecycle: ((window: BrowserWindow) => void) | null = null;
// Kept in module scope so the IPC connection handlers can read it at call time.
let oauth: OAuthConnectionService | null = null;

/**
 * Dev convenience: load a project-root `.env` (KEY=VALUE) into process.env so
 * credentials like SPOTIFY_CLIENT_ID don't have to be set in the shell each
 * launch. Never runs in a packaged build; existing env vars win. No dependency.
 */
function loadDevEnv(): void {
  if (app.isPackaged) return;
  try {
    const content = fs.readFileSync(path.join(app.getAppPath(), '.env'), 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // No .env in dev — fine, fall back to real env vars.
  }
}

/**
 * Applies an explicitly requested development-only user-data directory.
 *
 * - Keeps destructive recovery and privacy acceptance tests away from real profiles.
 * - Rejects relative paths and symbolic-link targets.
 * - Has no effect in packaged builds.
 *
 * @category Security Utility
 */
function applyDevUserDataOverride(): void {
  const requestedPath = process.env.SARAH_DEV_USER_DATA?.trim();
  if (app.isPackaged || !requestedPath) return;
  if (!path.isAbsolute(requestedPath)) {
    throw new Error('SARAH_DEV_USER_DATA must be an absolute path');
  }

  const resolvedPath = path.resolve(requestedPath);
  fs.mkdirSync(resolvedPath, { recursive: true });
  const stat = fs.lstatSync(resolvedPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('SARAH_DEV_USER_DATA must reference a local directory');
  }
  const sessionPath = path.join(resolvedPath, 'electron-session');
  fs.mkdirSync(sessionPath, { recursive: true });
  app.setPath('userData', resolvedPath);
  app.setPath('sessionData', sessionPath);
}

interface PrimaryWindowCreationOptions {
  page?: 'splash.html' | 'dashboard.html' | 'wizard.html';
  bounds?: { x: number; y: number; width: number; height: number };
}

function createWindow(
  electronShutdown: ElectronShutdownCoordinator,
  options: PrimaryWindowCreationOptions = {},
): BrowserWindow {
  const bounds = options.bounds;
  const window = new BrowserWindow({
    width: bounds?.width ?? 800,
    height: bounds?.height ?? 600,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    show: false,
    backgroundColor: '#05070d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;
  const page = options.page ?? 'splash.html';
  void window.loadFile(path.join(__dirname, '..', page)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Boot] The splash screen could not be loaded:', error);
    dialog.showErrorBox(
      'Sarah konnte die Oberfläche nicht laden',
      `Der Startbildschirm konnte nicht geladen werden. Bitte installiere Sarah erneut.\n\n${message}`,
    );
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // Auxiliary windows (for example the hidden sandbox browser used by Search)
  // can keep Electron alive after the primary UI closes. The primary window is
  // the application ownership boundary on Windows, so close it through the same
  // idempotent shutdown coordinator instead of waiting for window-all-closed.
  window.once('closed', () => {
    if (mainWindow !== window) return;
    mainWindow = null;
    electronShutdown.handlePrimaryWindowClosed();
  });

  // Windows does not guarantee Electron's before-quit/will-quit events during
  // logout or system shutdown. Start the same idempotent cleanup best-effort
  // when the OS ends the session; normal window/direct quit remains awaitable.
  window.on('session-end', () => {
    void appContext?.lifecycle.shutdown();
  });
  bindPrimaryWindowLifecycle?.(window);
  return window;
}

function startPrimaryInstance(): void {
  const electronShutdown = registerElectronShutdown(app, () => appContext);
  let resolveSplashDone!: () => void;
  const splashDone = new Promise<void>((resolve) => {
    resolveSplashDone = resolve;
  });
  ipcMain.once('splash-done', resolveSplashDone);
  loadDevEnv();

  app.whenReady().then(async () => {
  createWindow(electronShutdown);
  appContext = await retryTransientKeyAccess(
    () => bootstrap(app.getPath('userData')),
    {
      retries: 2,
      delayMs: 250,
      isTransient: (error) => error instanceof KeyAccessError && !error.isFinalKeyLoss,
    },
  );

  // Show dialog if config validation failed
  if (appContext.configErrors) {
    const issues = appContext.configErrors.map((e) => `• ${e}`).join('\n');
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Konfigurationsfehler',
      message: 'Die Konfigurationsdatei enthält ungültige Werte:',
      detail: `${issues}\n\nMit den sicher reparierten Werten fortfahren?`,
      buttons: ['Sicher repariert fortfahren', 'Beenden'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) {
      app.quit();
      return;
    }
    await repairInvalidConfig(appContext);
  }

  // --- Preload: create providers (fast, no activation) ---
  const { llm: llmConfig } = appContext.parsedConfig;
  const containerManager = new OllamaContainerManager(
    llmConfig.baseUrl,
    path.join(app.getAppPath(), 'docker-compose.yml'),
  );
  const modelRuntime = new ModelRuntime({
    config: llmConfig,
    containerManager,
    onCapability: (name, state, message) => {
      appContext?.lifecycle.setCapability(name, state, message);
    },
  });
  const routerService = new RouterService(appContext, modelRuntime);

  // --- Action layer (Spec Action-Layer V1) ---
  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', 'resources');
  sandboxBrowser = new SandboxBrowser();
  appContext.lifecycle.registerCleanup('sandbox-browser', () => {
    sandboxBrowser?.close();
    sandboxBrowser = null;
  });
  const programLauncher = new ProgramLauncher();
  systemActions = new SystemActions();
  appContext.lifecycle.registerCleanup('system-action-timers', () => {
    systemActions?.clearAllTimers();
    systemActions = null;
  });
  // Free-form summaries are a worker capability. The tag-only router is not
  // exposed to SearchService and therefore cannot accidentally generate text.
  const summarize = (
    messages: import('./services/llm/llm-provider.interface.js').ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string> => {
    return modelRuntime.generateWorkerMessages(messages, {
      num_predict: SUMMARY_NUM_PREDICT,
      temperature: SUMMARY_TEMPERATURE,
      signal,
    });
  };
  const searchService = new SearchService(
    new EmbeddedBrowserSearchProvider(sandboxBrowser),
    sandboxBrowser,
    summarize,
  );
  // --- Integrations / OAuth connection layer (Spec Integrationen V1) ---
  // Built BEFORE the ActionService so SpotifyActions can take the oauth instance.
  // AppContext does not expose its KeyManager, so construct a fresh one over the
  // same userData dir (KeyManager is idempotent — reuses the existing sarah.key).
  // `oauth` is kept in module scope so the IPC connection handlers can read it.
  const keyManager = new KeyManager(app.getPath('userData'));
  const tokenStore = new TokenStore(app.getPath('userData'), keyManager);
  oauth = new OAuthConnectionService({
    providers: getOAuthProviders(),
    tokenStore,
    redirectPort: redirectPort(),
  });
  appContext.lifecycle.registerCleanup('oauth-loopback', async () => {
    await oauth?.destroy();
    oauth = null;
  });
  const spotifyActions = new SpotifyActions(oauth);
  const mediaController = new WindowsMediaController(
    path.join(resourcesPath, 'media-helper', 'media-helper.exe'),
  );
  const reminderStore = new ReminderStore(appContext.db, {
    persistent: appContext.databasePersistent,
  });
  const reminderService = new ReminderService({
    store: reminderStore,
    notify: (notification, signal) => {
      if (routerService.status !== 'running') return false;
      if (signal?.aborted) return false;
      const notificationId = randomUUID();
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (accepted: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe();
          signal?.removeEventListener('abort', abort);
          resolve(accepted);
        };
        const abort = (): void => finish(false);
        const unsubscribe = appContext!.bus.on('action:notify-accepted', (message) => {
          if (message.data.notificationId === notificationId) finish(true);
        });
        const timeout = setTimeout(() => finish(false), 30_000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
          finish(false);
          return;
        }
        const published = appContext!.bus.emit('reminders', 'action:notify', {
          notificationId,
          kind: 'reminder',
          speak: notification.speak,
          originMode: notification.originMode,
          privateContext: notification.privateContext,
        });
        if (!published) finish(false);
      });
    },
    onError: (error) => {
      console.warn('[Reminders] Reconcile failed', { name: error.name });
    },
  });

  const actionService = new ActionService(appContext.bus, {
    launcher: programLauncher,
    getPrograms: () => appContext!.parsedConfig.resources.programs,
    search: searchService,
    system: systemActions,
    spotify: spotifyActions,
    media: mediaController,
    reminders: reminderService,
    confirmationGate: appContext.actionConfirmations,
    getConfirmationLevel: () => appContext!.parsedConfig.trust.confirmationLevel,
    getFileAccess: () => appContext!.parsedConfig.trust.fileAccess,
    getWebAccessAllowed: () => appContext!.parsedConfig.trust.webAccessAllowed,
    getReminderPersistencePolicy: () => ({
      allowed: appContext!.parsedConfig.trust.memoryAllowed,
      exclusions: appContext!.parsedConfig.trust.memoryExclusions,
    }),
  });
  // Registration order is dependency order; shutdown reverses it. Search uses
  // the worker runtime and ActionService uses Search, so both must stop before
  // RouterService releases Ollama models. Voice starts on its own delayed lane
  // while this model-dependent prefix initializes; reminders still wait for
  // both lanes and therefore keep their existing dependency position.
  appContext.registry.register(routerService);
  appContext.registry.register(searchService);
  appContext.registry.register(actionService);

  const { AudioManager } = await import('./services/voice/audio-manager.js');
  const { HotkeyManager } = await import('./services/voice/hotkey-manager.js');
  const { FasterWhisperProvider } = await import('./services/voice/providers/faster-whisper-provider.js');
  const { PiperProvider } = await import('./services/voice/providers/piper-provider.js');
  const { PorcupineProvider } = await import('./services/voice/providers/porcupine-provider.js');

  const picovoiceKey = process.env.PICOVOICE_ACCESS_KEY ?? '';
  const whisperProvider = new FasterWhisperProvider(resourcesPath);
  const piperProvider = new PiperProvider(resourcesPath);
  const porcupineProvider = new PorcupineProvider(resourcesPath, picovoiceKey);
  const audioManager = new AudioManager();
  const hotkeyManager = new HotkeyManager();

  const voiceService = new VoiceService(
    appContext,
    whisperProvider,
    piperProvider,
    porcupineProvider,
    audioManager,
    hotkeyManager,
  );
  appContext.registry.register(voiceService, { startDelayMs: 3_000 });
  appContext.registry.register(reminderService);
  const reconcileRemindersAfterResume = (): void => {
    if (reminderService.status !== 'running') return;
    void reminderService.reconcile().catch((error: object) => {
      console.warn('[Reminders] Resume reconcile failed', {
        name: error instanceof Error ? error.name : 'NonError',
      });
    });
  };
  powerMonitor.on('resume', reconcileRemindersAfterResume);
  appContext.lifecycle.registerCleanup('reminder-power-monitor', () => {
    powerMonitor.removeListener('resume', reconcileRemindersAfterResume);
  }, 'before_services');
  let stopVoiceRendererLifecycle: (() => void) | null = null;
  let stopPrimaryRendererRecovery: (() => void) | null = null;
  let replacementUsed = false;
  bindPrimaryWindowLifecycle = (window) => {
    stopVoiceRendererLifecycle?.();
    stopPrimaryRendererRecovery?.();
    stopVoiceRendererLifecycle = registerVoiceRendererLifecycle(window, voiceService);
    stopPrimaryRendererRecovery = registerPrimaryRendererRecovery(window, {
      isShuttingDown: () => {
        const state = appContext?.lifecycle.snapshot.state;
        return state === 'stopping' || state === 'stopped';
      },
      replaceWindow: async () => {
        if (replacementUsed || mainWindow !== window || window.isDestroyed()) return false;
        replacementUsed = true;
        const bounds = window.getBounds();
        const wasMaximized = window.isMaximized();
        const page = appContext?.parsedConfig.onboarding.setupComplete
          ? 'dashboard.html'
          : 'wizard.html';
        const replacement = createWindow(electronShutdown, { page, bounds });
        if (wasMaximized) replacement.maximize();
        window.destroy();
        return true;
      },
      showFinalError: (message) => {
        dialog.showErrorBox('Sarahs Oberfläche ist abgestürzt', message);
      },
    });
  };
  if (mainWindow) bindPrimaryWindowLifecycle(mainWindow);
  appContext.lifecycle.registerCleanup('primary-window-lifecycle', () => {
    bindPrimaryWindowLifecycle = null;
    stopVoiceRendererLifecycle?.();
    stopVoiceRendererLifecycle = null;
    stopPrimaryRendererRecovery?.();
    stopPrimaryRendererRecovery = null;
  }, 'before_services');

  // --- Shared dependency getters (avoid stale refs in modules) ---
  const getMainWindow = () => mainWindow;
  const getAppContext = () => appContext!;

  // --- Register IPC handler modules ---
  const folderScanGrant = registerProgramHandlers(ipcMain, {
    getFileAccess: () => appContext!.parsedConfig.trust.fileAccess,
    getAllowedFolders: () => {
      const config = appContext!.parsedConfig;
      return [
        ...Object.values(config.system.folders),
        config.skills.programmingProjectsFolder,
        config.resources.picturesFolder,
        config.resources.installFolder,
        config.resources.gamesFolder,
        config.resources.extraProgramsFolder,
        ...config.resources.importantFolders,
        ...config.resources.pdfCategories.map((category) => category.folder),
      ].filter((folder) => folder.length > 0);
    },
  });

  registerConfigHandlers(ipcMain, {
    getAppContext,
    getMainWindow,
    dialogWindows,
    onFolderSelected: folderScanGrant.grantFolderAccess,
    onTrustChanged: folderScanGrant.invalidateFolderGrants,
  });

  registerConnectionHandlers(ipcMain, { getOAuth: () => oauth! });

  const voiceLevel = registerVoiceLevelForwarder({
    getMainWindow,
    dialogWindows,
  });
  stopVoiceLevel = voiceLevel.stop;
  appContext.lifecycle.registerCleanup('voice-level-forwarder', () => {
    stopVoiceLevel?.();
    stopVoiceLevel = null;
  }, 'before_services');

  const stopVoiceHandlers = registerVoiceHandlers(ipcMain, {
    getAppContext,
    onChunk: voiceLevel.onChunk,
  });
  appContext.lifecycle.registerCleanup('voice-ipc-handlers', stopVoiceHandlers, 'before_services');

  const stopBootHandlers = registerBootHandlers({
    getMainWindow,
    getAppContext,
    piperProvider,
    containerManager,
    splashDone,
  });
  appContext.lifecycle.registerCleanup('boot-handlers', stopBootHandlers, 'before_services');

  stopSystemMetrics = registerSystemMetricsHandlers(ipcMain, {
    getMainWindow,
    dialogWindows,
  });
  appContext.lifecycle.registerCleanup('system-metrics', () => {
    stopSystemMetrics?.();
    stopSystemMetrics = null;
  }, 'before_services');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(electronShutdown);
    }
  });
}).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[Main] Fatal bootstrap error:', error);
  if (error instanceof KeyAccessError && error.isFinalKeyLoss) {
    try {
      const resetStarted = await handleFinalKeyLossRecovery([], {
        showMessageBox: (options) => mainWindow
          ? dialog.showMessageBox(mainWindow, options)
          : dialog.showMessageBox(options),
        reset: (confirmation) => resetAfterFinalKeyLoss(
          app.getPath('userData'),
          error,
          confirmation,
        ),
        relaunch: () => app.relaunch(),
        exit: (code) => app.exit(code),
      });
      if (!resetStarted) app.quit();
      return;
    } catch (resetError) {
      const resetMessage = resetError instanceof Error ? resetError.message : String(resetError);
      dialog.showErrorBox(
        'Sarah konnte die unlesbaren Daten nicht sicher archivieren',
        `Der Reset wurde nicht abgeschlossen. Sarah startet nicht mit einem leeren Speicher.\n\n${resetMessage}`,
      );
      app.quit();
      return;
    }
  }
  if (error instanceof KeyAccessError) {
    dialog.showErrorBox(
      'Schlüsselschutz des Betriebssystems vorübergehend nicht verfügbar',
      'Sarah konnte den sicheren Schlüsselspeicher auch nach zwei erneuten Versuchen nicht erreichen. '
      + `Es wurden keine Daten zurückgesetzt oder überschrieben. Bitte starte Sarah oder das Gerät später erneut.\n\n${message}`,
    );
    app.quit();
    return;
  }
  dialog.showErrorBox(
    'Sarah konnte nicht gestartet werden',
    `Die Grunddienste konnten nicht initialisiert werden.\n\n${message}`,
  );
  try {
    await appContext?.lifecycle.shutdown();
  } catch (cleanupError) {
    console.error('[Main] Fatal bootstrap cleanup failed:', cleanupError);
  } finally {
    app.quit();
  }
});
}

applyDevUserDataOverride();
if (acquireSingleInstanceLock(app, () => mainWindow)) {
  startPrimaryInstance();
}
