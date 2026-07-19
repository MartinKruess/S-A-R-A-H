import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { bootstrap, AppContext } from './core/bootstrap.js';
import { RouterService } from './services/llm/router-service.js';
import { OllamaProvider } from './services/llm/providers/ollama-provider.js';
import { OllamaContainerManager } from './services/llm/ollama-container-manager.js';
import { PERFORMANCE_PROFILE_MAP } from './services/llm/llm-types.js';
import { VoiceService } from './services/voice/voice-service.js';
import { SandboxBrowser } from './main/sandbox-browser.js';
import { ProgramLauncher } from './main/program-launcher.js';
import { SystemActions } from './services/actions/system-actions.js';
import { SpotifyActions } from './services/actions/spotify-actions.js';
import { ActionService } from './services/actions/action-service.js';
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

let mainWindow: BrowserWindow | null = null;
let appContext: AppContext | null = null;
const dialogWindows = new Map<string, BrowserWindow>();
let stopSystemMetrics: (() => void) | null = null;
let stopVoiceLevel: (() => void) | null = null;
let sandboxBrowser: SandboxBrowser | null = null;
let systemActions: SystemActions | null = null;
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
  const numGpu = PERFORMANCE_PROFILE_MAP[llmConfig.performanceProfile] ?? PERFORMANCE_PROFILE_MAP.normal;
  const routerProvider = new OllamaProvider(llmConfig.baseUrl, llmConfig.routerModel, {
    ...llmConfig.options,
    num_ctx: 2048,
    num_gpu: -1,
  });
  const workerOptions = {
    ...llmConfig.options,
    num_ctx: llmConfig.workerOptions.num_ctx,
    num_gpu: numGpu,
  };
  const workerProvider = new OllamaProvider(llmConfig.baseUrl, llmConfig.workerModel, workerOptions);
  const routerService = new RouterService(appContext, routerProvider, workerProvider);

  // --- Action layer (Spec Action-Layer V1) ---
  sandboxBrowser = new SandboxBrowser();
  const programLauncher = new ProgramLauncher();
  systemActions = new SystemActions();
  // Summary runs on whichever model is warm right now — never triggers a load (Spec §3).
  const summarize = (prompt: string): Promise<string> => {
    const provider = routerService.activeModel === '9b' ? workerProvider : routerProvider;
    return provider.chat([{ role: 'user', content: prompt }], () => {}, {
      num_predict: SUMMARY_NUM_PREDICT,
      temperature: SUMMARY_TEMPERATURE,
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
  const spotifyActions = new SpotifyActions(oauth);

  const actionService = new ActionService(appContext.bus, {
    launcher: programLauncher,
    getPrograms: () => appContext!.parsedConfig.resources.programs,
    search: searchService,
    system: systemActions,
    spotify: spotifyActions,
  });
  appContext.registry.register(searchService);
  appContext.registry.register(actionService);

  appContext.registry.register(routerService);

  // Plain class, deliberately not a SarahService/registry entry (YAGNI —
  // registry integration comes with the cockpit status display).
  const containerManager = new OllamaContainerManager(
    llmConfig.baseUrl,
    path.join(app.getAppPath(), 'docker-compose.yml'),
  );

  const { AudioManager } = await import('./services/voice/audio-manager.js');
  const { HotkeyManager } = await import('./services/voice/hotkey-manager.js');
  const { FasterWhisperProvider } = await import('./services/voice/providers/faster-whisper-provider.js');
  const { PiperProvider } = await import('./services/voice/providers/piper-provider.js');
  const { PorcupineProvider } = await import('./services/voice/providers/porcupine-provider.js');

  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', 'resources');
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

  registerVoiceHandlers(ipcMain, {
    getAppContext,
    onChunk: voiceLevel.onChunk,
  });

  registerBootHandlers({
    getMainWindow,
    getAppContext,
    routerService,
    whisperProvider,
    piperProvider,
    containerManager,
  });

  stopSystemMetrics = registerSystemMetricsHandlers(ipcMain, {
    getMainWindow,
    dialogWindows,
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  if (stopSystemMetrics) {
    stopSystemMetrics();
    stopSystemMetrics = null;
  }
  if (stopVoiceLevel) {
    stopVoiceLevel();
    stopVoiceLevel = null;
  }
  // Infrastructure cleanup (M3): SandboxBrowser and timers are not registry
  // services — registry.destroyAll() does not reach them.
  sandboxBrowser?.close();
  systemActions?.clearAllTimers();
  if (appContext) {
    await appContext.shutdown();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
