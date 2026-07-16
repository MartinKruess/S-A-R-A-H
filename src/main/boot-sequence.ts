import * as path from 'path';
import { BrowserWindow, ipcMain, screen } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { MessageBus } from '../core/message-bus.js';
import type { RouterService } from '../services/llm/router-service.js';
import type { OllamaContainerManager } from '../services/llm/ollama-container-manager.js';
import type { PiperProvider } from '../services/voice/providers/piper-provider.js';
import type { FasterWhisperProvider } from '../services/voice/providers/faster-whisper-provider.js';
import { VoiceService } from '../services/voice/voice-service.js';
import { forwardToRenderers } from './forward-to-renderers.js';
import { isValidChatMessage } from './ipc-validation.js';

export interface BootSequenceDeps {
  getMainWindow: () => BrowserWindow | null;
  getAppContext: () => AppContext;
  routerService: RouterService;
  whisperProvider: FasterWhisperProvider;
  piperProvider: PiperProvider;
  containerManager: OllamaContainerManager;
}

export function registerBootHandlers(deps: BootSequenceDeps): void {
  const { getMainWindow, getAppContext, routerService, whisperProvider, piperProvider, containerManager } = deps;

  const send = (step: string, message?: string) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('boot-status', { step, message });
    }
  };

  // Start heavy inits immediately, keep promise refs so boot-ready can await them.
  const whisperReady = whisperProvider.init().catch((err) => {
    console.error('[Boot] Whisper init failed:', err);
  });
  // Container must be up before router init — chained so the promise still
  // starts eagerly at registration time (orb-reveal timing unchanged).
  let containerError: string | null = null;
  const routerReady = containerManager
    .ensureRunning()
    .then(() => routerService.init())
    .catch((err) => {
      containerError = err instanceof Error ? err.message : String(err);
      console.error('[Boot] Ollama container/router init failed:', err);
    });

  ipcMain.once('boot-ready', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;

    try {
      send('whisper', 'Spracherkennung wird aktiviert ...');

      // Router determines orb reveal — don't block on whisper (takes 30-45s cold)
      send('router', 'Sarah Protokoll wird initialisiert ...');
      await routerReady;

      if (containerError) {
        send('router', containerError);
        // Keep the error readable before router-ready hides the status line
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        const gpu = await containerManager.checkGpu();
        if (gpu === 'cpu') {
          console.warn('[Boot] Ollama is running WITHOUT GPU (CPU mode)');
          send('router', 'Warnung: Ollama läuft ohne GPU — Antworten werden sehr langsam.');
          // Keep the warning readable before router-ready hides the status line
          await new Promise((r) => setTimeout(r, 3000));
        }
      }

      // Signal router ready — renderer starts orb reveal (even if router errored)
      send('router-ready');

      // Whisper finishes in background; signal renderer when ready so it can enable voice
      whisperReady
        .then(() => { send('whisper-ready'); })
        .catch(() => { send('whisper-ready'); });

      // Wait for reveal animation to finish (renderer sends reveal-done IPC)
      await new Promise<void>((resolve) => {
        ipcMain.once('reveal-done', () => resolve());
        setTimeout(resolve, 8000); // Fallback
      });

      send('piper', 'Sprachprotokolle werden geladen ...');
      // Piper init is near-instant (file checks only), so add minimum display time
      await Promise.all([
        piperProvider.init().catch((err) => {
          console.error('[Boot] Piper init failed:', err);
        }),
        new Promise((r) => setTimeout(r, 1000)),
      ]);

      // Signal piper ready — renderer starts break + TTS
      send('piper-ready');

      // Wire up remaining service plumbing (TtsQueue, hotkeys, subscriptions, status)
      // init() is single-flight (A8): repeated calls return the same promise
      const ctx = getAppContext();
      await ctx.registry.initAll().catch((err) => {
        console.error('[Boot] Service wiring failed:', err);
      });
    } catch (err) {
      console.error('[Boot] Activation failed:', err);
      send('router-ready');
      send('piper-ready');
      const ctx = getAppContext();
      await ctx.registry.initAll().catch(() => {});
    }
  });

  // Splash TTS handler (uses Piper directly, VoiceService not wired yet)
  ipcMain.handle('splash-tts', async (_event, text: string) => {
    if (!isValidChatMessage(text)) {
      console.warn('[IPC] invalid payload for splash-tts');
      return;
    }
    try {
      const audio = await piperProvider.speak(text);
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voice:play-audio', {
          audio: Array.from(audio),
          sampleRate: 22050,
        });
      }
    } catch (err) {
      console.error('[Boot] Splash TTS failed:', err);
    }
  });

  function loadDashboardBootMode(): void {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Window is already 800x600 centered from splash — just swap the page
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dashboard.html'));
  }

  ipcMain.on('splash-done', () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    if (getAppContext().parsedConfig.onboarding.setupComplete) {
      loadDashboardBootMode();
    } else {
      mainWindow.maximize();
      mainWindow.loadFile(path.join(__dirname, '..', '..', 'wizard.html'));
    }
  });

  ipcMain.on('wizard-done', () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Wizard was maximized — restore to splash size and center
    mainWindow.unmaximize();
    mainWindow.setSize(800, 600);
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    mainWindow.setPosition(
      Math.round((screenW - 800) / 2),
      Math.round((screenH - 600) / 2),
    );
    loadDashboardBootMode();
  });

  ipcMain.handle('chat-message', async (_event, text: string) => {
    if (!isValidChatMessage(text)) {
      console.warn('[IPC] invalid payload for chat-message');
      return;
    }
    const ctx = getAppContext();
    const voiceService = ctx.registry.get('voice') as VoiceService | undefined;
    if (voiceService && voiceService.voiceState === 'idle' && voiceService.status === 'running') {
      // Only enable one-shot TTS when user types in voice mode, not in chat mode
      voiceService.setChatSpeak();
    }
    ctx.bus.emit('renderer', 'chat:message', { text, mode: 'chat' });
  });

  // Forward LLM events to all renderer windows
  const bus: MessageBus = getAppContext().bus;
  forwardToRenderers(bus, 'llm:chunk');
  forwardToRenderers(bus, 'llm:done');
  forwardToRenderers(bus, 'llm:error');

  // ── Performance timing collector ──
  let perfStart = 0;
  let perfData: Record<string, unknown> = {};

  bus.on('perf:timing', (msg) => {
    const { label, ms, meta } = msg.data;
    if (!perfStart) perfStart = Date.now();
    perfData[`${label}Ms`] = ms;
    if (meta) Object.assign(perfData, meta);
    if (label === 'router') perfData.usedWorker = false;
    if (label === 'worker') perfData.usedWorker = true;
  });

  const logPerf = () => {
    if (!perfStart) return;
    const msKeys = Object.keys(perfData).filter(k => k.endsWith('Ms'));
    const totalMs = msKeys.reduce((sum, k) => sum + (perfData[k] as number), 0);
    console.log('\n[⏱ Performance]', JSON.stringify({ totalMs, ...perfData }, null, 2));
    perfStart = 0;
    perfData = {};
  };

  bus.on('voice:done', logPerf);
  // Chat-only mode (no voice) — log on llm:done if no whisper was involved
  bus.on('llm:done', () => {
    if (!perfData.whisperMs) logPerf();
  });

  ipcMain.once('boot-done', () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;

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
      const win = getMainWindow();
      if (!win || win.isDestroyed()) {
        clearInterval(interval);
        return;
      }
      const elapsed = Date.now() - startTime;
      const p = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);

      win.setBounds({
        x: Math.round(startBounds.x + (targetX - startBounds.x) * eased),
        y: Math.round(startBounds.y + (targetY - startBounds.y) * eased),
        width: Math.round(startBounds.width + (targetW - startBounds.width) * eased),
        height: Math.round(startBounds.height + (targetH - startBounds.height) * eased),
      });

      if (p >= 1) clearInterval(interval);
    }, 16);
  });
}
