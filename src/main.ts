import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { bootstrap, AppContext } from './core/bootstrap.js';
import { RouterService } from './services/llm/router-service.js';
import { OllamaContainerManager } from './services/llm/ollama-container-manager.js';
import { ModelRuntime } from './services/llm/model-runtime.js';
import { VoiceService } from './services/voice/voice-service.js';
import { SandboxBrowser } from './main/sandbox-browser.js';
import { ProgramLauncher } from './main/program-launcher.js';
import { SystemActions } from './services/actions/system-actions.js';
import { SpotifyActions } from './services/actions/spotify-actions.js';
import { ActionService } from './services/actions/action-service.js';
import { WindowsMediaController } from './services/actions/media-controller.js';
import { SearchService } from './services/search/search-service.js';
import { EmbeddedBrowserSearchProvider } from './services/search/embedded-browser-search-provider.js';
import { SUMMARY_NUM_PREDICT, SUMMARY_TEMPERATURE } from './services/search/summarize-results.js';
import { registerProgramHandlers } from './main/ipc-programs.js';
import { registerConfigHandlers } from './main/ipc-config.js';
import { registerConnectionHandlers } from './main/ipc-connections.js';
import { KeyManager } from './core/crypto/key-manager.js';
import { TokenStore } from './services/integrations/token-store.js';
import { OAuthConnectionService } from './services/integrations/oauth-connection-service.js';
import { getOAuthProviders, redirectPort } from './services/integrations/providers.js';
import { registerVoiceHandlers } from './main/ipc-voice.js';
import { registerBootHandlers } from './main/boot-sequence.js';
import { registerSystemMetricsHandlers } from './main/ipc-system-metrics.js';
import { registerVoiceLevelForwarder } from './main/ipc-voice-level.js';
import { registerElectronShutdown } from './main/electron-shutdown.js';

let mainWindow: BrowserWindow | null = null;
let appContext: AppContext | null = null;
const dialogWindows = new Map<string, BrowserWindow>();
let stopSystemMetrics: (() => void) | null = null;
let stopVoiceLevel: (() => void) | null = null;
let sandboxBrowser: SandboxBrowser | null = null;
let systemActions: SystemActions | null = null;
// Kept in module scope so the IPC connection handlers can read it at call time.
let oauth: OAuthConnectionService | null = null;

const electronShutdown = registerElectronShutdown(app, () => appContext);

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
loadDevEnv();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    backgroundColor: '#05070d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'splash.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Auxiliary windows (for example the hidden sandbox browser used by Search)
  // can keep Electron alive after the primary UI closes. The primary window is
  // the application ownership boundary on Windows, so close it through the same
  // idempotent shutdown coordinator instead of waiting for window-all-closed.
  mainWindow.once('closed', () => {
    mainWindow = null;
    electronShutdown.handlePrimaryWindowClosed();
  });

  // Windows does not guarantee Electron's before-quit/will-quit events during
  // logout or system shutdown. Start the same idempotent cleanup best-effort
  // when the OS ends the session; normal window/direct quit remains awaitable.
  mainWindow.on('session-end', () => {
    void appContext?.lifecycle.shutdown();
  });
}

app.whenReady().then(async () => {
  createWindow();
  appContext = await bootstrap(app.getPath('userData'));

  // Show dialog if config validation failed
  if (appContext.configErrors) {
    const issues = appContext.configErrors.map((e) => `• ${e}`).join('\n');
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Konfigurationsfehler',
      message: 'Die Konfigurationsdatei enthält ungültige Werte:',
      detail: `${issues}\n\nMit Standard-Werten fortfahren?`,
      buttons: ['Mit Defaults fortfahren', 'Beenden'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) {
      app.quit();
      return;
    }
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
  const summarize = (prompt: string, signal?: AbortSignal): Promise<string> => {
    return modelRuntime.generateWorkerText(prompt, {
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

  const actionService = new ActionService(appContext.bus, {
    launcher: programLauncher,
    getPrograms: () => appContext!.parsedConfig.resources.programs,
    search: searchService,
    system: systemActions,
    spotify: spotifyActions,
    media: mediaController,
  });
  // Registration order is dependency order; shutdown reverses it. Search uses
  // the worker runtime and ActionService uses Search, so both must stop before
  // RouterService releases Ollama models.
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
  appContext.registry.register(voiceService);

  // --- Shared dependency getters (avoid stale refs in modules) ---
  const getMainWindow = () => mainWindow;
  const getAppContext = () => appContext!;

  // --- Register IPC handler modules ---
  registerProgramHandlers(ipcMain);

  registerConfigHandlers(ipcMain, {
    getAppContext,
    getMainWindow,
    dialogWindows,
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
      createWindow();
    }
  });
}).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[Main] Fatal bootstrap error:', error);
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
