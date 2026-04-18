import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { bootstrap, AppContext } from './core/bootstrap.js';
import { RouterService } from './services/llm/router-service.js';
import { OllamaProvider } from './services/llm/providers/ollama-provider.js';
import { PERFORMANCE_PROFILE_MAP } from './services/llm/llm-types.js';
import { VoiceService } from './services/voice/voice-service.js';
import { registerProgramHandlers } from './main/ipc-programs.js';
import { registerConfigHandlers } from './main/ipc-config.js';
import { registerVoiceHandlers } from './main/ipc-voice.js';
import { registerBootHandlers } from './main/boot-sequence.js';
import { registerSystemMetricsHandlers } from './main/ipc-system-metrics.js';
import { registerVoiceLevelForwarder } from './main/ipc-voice-level.js';

try {
  require('electron-reloader')(module);
} catch {}

let mainWindow: BrowserWindow | null = null;
let appContext: AppContext | null = null;
const dialogWindows = new Map<string, BrowserWindow>();
let stopSystemMetrics: (() => void) | null = null;
let stopVoiceLevel: (() => void) | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    backgroundColor: '#0a0a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
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
  const routerProvider = new OllamaProvider(llmConfig.baseUrl, llmConfig.routerModel, { ...llmConfig.options, num_ctx: 2048 });
  const numGpu = PERFORMANCE_PROFILE_MAP[llmConfig.performanceProfile] ?? PERFORMANCE_PROFILE_MAP.normal;
  const workerOptions = {
    ...llmConfig.options,
    num_ctx: llmConfig.workerOptions.num_ctx,
    num_gpu: numGpu,
  };
  const workerProvider = new OllamaProvider(llmConfig.baseUrl, llmConfig.workerModel, workerOptions);
  const routerService = new RouterService(appContext, routerProvider, workerProvider);
  appContext.registry.register(routerService);

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
  });

  stopSystemMetrics = registerSystemMetricsHandlers(ipcMain, {
    getMainWindow,
    dialogWindows,
  });

  ipcMain.once('boot-done', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const { screen } = require('electron');
    const { height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const targetW = Math.round(screenH * 0.3);
    const targetH = Math.round(screenH * 0.33);
    const targetX = 0;
    const targetY = 0;

    const startBounds = mainWindow.getBounds();
    const duration = 1500;
    const startTime = Date.now();

    mainWindow.webContents.send('transition-start');

    const interval = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        clearInterval(interval);
        return;
      }
      const elapsed = Date.now() - startTime;
      const p = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);

      mainWindow.setBounds({
        x: Math.round(startBounds.x + (targetX - startBounds.x) * eased),
        y: Math.round(startBounds.y + (targetY - startBounds.y) * eased),
        width: Math.round(startBounds.width + (targetW - startBounds.width) * eased),
        height: Math.round(startBounds.height + (targetH - startBounds.height) * eased),
      });

      if (p >= 1) clearInterval(interval);
    }, 16);
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
  if (appContext) {
    await appContext.shutdown();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
