import * as path from 'path';
import { BrowserWindow, ipcMain } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { MessageBus } from '../core/message-bus.js';
import type { RouterService } from '../services/llm/router-service.js';
import type { PiperProvider } from '../services/voice/providers/piper-provider.js';
import type { FasterWhisperProvider } from '../services/voice/providers/faster-whisper-provider.js';
import { VoiceService } from '../services/voice/voice-service.js';
import { forwardToRenderers } from './forward-to-renderers.js';

export interface BootSequenceDeps {
  getMainWindow: () => BrowserWindow | null;
  getAppContext: () => AppContext;
  routerService: RouterService;
  whisperProvider: FasterWhisperProvider;
  piperProvider: PiperProvider;
}

export function registerBootHandlers(deps: BootSequenceDeps): void {
  const { getMainWindow, getAppContext, routerService, whisperProvider, piperProvider } = deps;

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
  const routerReady = routerService.init().catch((err) => {
    console.error('[Boot] Router init failed:', err);
  });

  ipcMain.once('boot-ready', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;

    try {
      send('whisper', 'Spracherkennung wird aktiviert ...');
      await whisperReady;

      send('router', 'Sarah Protokoll wird initialisiert ...');
      await routerReady;

      // Signal router ready — renderer starts orb reveal (even if router errored)
      send('router-ready');

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
      // Provider inits are idempotent, so double-calling is safe
      const ctx = getAppContext();
      await ctx.registry.initAll().catch((err) => {
        console.error('[Boot] Service wiring failed:', err);
      });
    } catch (err) {
      console.error('[Boot] Activation failed:', err);
      send('piper-ready');
      const ctx = getAppContext();
      await ctx.registry.initAll().catch(() => {});
    }
  });

  // Splash TTS handler (uses Piper directly, VoiceService not wired yet)
  ipcMain.handle('splash-tts', async (_event, text: string) => {
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
    const { screen } = require('electron');
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    mainWindow.setPosition(
      Math.round((screenW - 800) / 2),
      Math.round((screenH - 600) / 2),
    );
    loadDashboardBootMode();
  });

  ipcMain.handle('chat-message', async (_event, text: string) => {
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
