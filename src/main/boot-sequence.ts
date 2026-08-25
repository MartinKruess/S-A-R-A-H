import * as path from 'path';
import { BrowserWindow, ipcMain, screen } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { MessageBus } from '../core/message-bus.js';
import type { OllamaContainerManager } from '../services/llm/ollama-container-manager.js';
import type { PiperProvider } from '../services/voice/providers/piper-provider.js';
import { VoiceService } from '../services/voice/voice-service.js';
import { forwardToRenderers } from './forward-to-renderers.js';
import { isValidChatMessage } from './ipc-validation.js';
import { deriveBootCapabilitySteps } from './boot-capabilities.js';
import type { CapabilitySnapshot } from '../core/app-lifecycle-controller.js';

export interface BootSequenceDeps {
  getMainWindow: () => BrowserWindow | null;
  getAppContext: () => AppContext;
  piperProvider: PiperProvider;
  containerManager: OllamaContainerManager;
}

type BootSeverity = 'info' | 'warning' | 'error';

/**
 * Register the splash, chat and boot bridge for the current main-process run.
 *
 * - Starts services through the application lifecycle exactly once.
 * - Emits terminal success/degraded steps from verified capability state.
 * - Returns a cleanup that removes IPC/bus listeners and animation timers.
 *
 * @returns Idempotent boot-handler cleanup.
 *
 * @category Event Handler
 */
export function registerBootHandlers(deps: BootSequenceDeps): () => void {
  const { getMainWindow, getAppContext, piperProvider, containerManager } = deps;
  let stopped = false;
  let transitionInterval: ReturnType<typeof setInterval> | null = null;
  let revealTimeout: ReturnType<typeof setTimeout> | null = null;
  let revealResolver: (() => void) | null = null;
  const pendingDelays = new Set<{
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
  }>();

  const send = (step: string, message?: string, severity: BootSeverity = 'info'): void => {
    if (stopped) return;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('boot-status', { step, message, severity });
    }
  };

  const delay = (ms: number): Promise<void> => new Promise((resolve) => {
    const entry = {
      timer: null as unknown as ReturnType<typeof setTimeout>,
      resolve,
    };
    entry.timer = setTimeout(() => {
      pendingDelays.delete(entry);
      resolve();
    }, ms);
    pendingDelays.add(entry);
    const timer = entry.timer;
    timer.unref?.();
  });

  const waitForReveal = (): Promise<void> => new Promise((resolve) => {
    if (stopped) {
      resolve();
      return;
    }
    const finish = (): void => {
      if (revealTimeout) clearTimeout(revealTimeout);
      revealTimeout = null;
      revealResolver = null;
      ipcMain.removeListener('reveal-done', finish);
      resolve();
    };
    revealResolver = finish;
    ipcMain.once('reveal-done', finish);
    revealTimeout = setTimeout(finish, 8_000);
  });

  const waitForCapability = (
    ctx: AppContext,
    name: string,
    startPromise: Promise<unknown>,
  ): Promise<CapabilitySnapshot | undefined> => new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let unsubscribeAfterRegistration = false;
    let settled = false;
    const finish = (capability?: CapabilitySnapshot): void => {
      if (settled) return;
      settled = true;
      if (unsubscribe) unsubscribe();
      else unsubscribeAfterRegistration = true;
      resolve(capability);
    };
    unsubscribe = ctx.lifecycle.subscribe((snapshot) => {
      const capability = snapshot.capabilities[name];
      if (capability && !['registered', 'starting'].includes(capability.state)) {
        finish(capability);
      }
    });
    if (unsubscribeAfterRegistration) unsubscribe();
    void startPromise.catch(() => finish(ctx.lifecycle.snapshot.capabilities[name]));
  });

  const runBoot = async (): Promise<void> => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || stopped) return;

    const ctx = getAppContext();
    send('whisper', 'Spracherkennung wird aktiviert ...');
    send('router', 'Sarah Protokoll wird initialisiert ...');

    try {
      const lifecycleStart = ctx.lifecycle.start();
      const router = await waitForCapability(ctx, 'router', lifecycleStart);
      const routerStep = deriveBootCapabilitySteps(router, { stt: false, tts: false }).router;

      if (routerStep === 'router-ready') {
        const gpu = await containerManager.checkGpu();
        if (gpu === 'cpu') {
          send(
            'router',
            'Warnung: Ollama läuft ohne GPU — Antworten werden sehr langsam.',
            'warning',
          );
          await delay(3_000);
          if (stopped) return;
        }
        send(routerStep);
      } else {
        send(
          routerStep,
          router?.message ?? 'Sarah-Protokoll ist nicht verfügbar. Text- und Spracheingaben bleiben deaktiviert.',
          'error',
        );
      }

      const reveal = waitForReveal();
      await lifecycleStart;
      const voice = ctx.registry.get('voice') as VoiceService | undefined;
      const voiceCapabilities = voice?.capabilitySnapshot ?? { stt: false, tts: false };
      const steps = deriveBootCapabilitySteps(router, voiceCapabilities);

      send(
        steps.stt,
        voiceCapabilities.stt ? undefined : 'Spracherkennung ist nicht verfügbar. Textchat bleibt nutzbar.',
        voiceCapabilities.stt ? 'info' : 'warning',
      );

      await reveal;
      if (stopped) return;

      send('piper', 'Sprachprotokolle werden geladen ...');
      await delay(1_000);
      send(
        steps.tts,
        voiceCapabilities.tts ? undefined : 'Sprachausgabe ist nicht verfügbar. Antworten erscheinen als Text.',
        voiceCapabilities.tts ? 'info' : 'warning',
      );
    } catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      console.error('[Boot] Activation failed:', value);
      if (stopped) return;
      send('router-terminal', message, 'error');
      send('whisper-unavailable', 'Spracherkennung konnte nicht aktiviert werden.', 'warning');
      await waitForReveal();
      send('piper-unavailable', 'Sprachausgabe konnte nicht aktiviert werden.', 'warning');
    }
  };

  const onBootReady = (): void => { void runBoot(); };
  ipcMain.once('boot-ready', onBootReady);

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

  const loadDashboardBootMode = (): void => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void mainWindow.loadFile(path.join(__dirname, '..', '..', 'dashboard.html'));
  };

  const onSplashDone = (): void => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    if (getAppContext().parsedConfig.onboarding.setupComplete) {
      loadDashboardBootMode();
    } else {
      mainWindow.maximize();
      void mainWindow.loadFile(path.join(__dirname, '..', '..', 'wizard.html'));
    }
  };
  ipcMain.on('splash-done', onSplashDone);

  const onWizardDone = (): void => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.unmaximize();
    mainWindow.setSize(800, 600);
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    mainWindow.setPosition(
      Math.round((screenW - 800) / 2),
      Math.round((screenH - 600) / 2),
    );
    loadDashboardBootMode();
  };
  ipcMain.on('wizard-done', onWizardDone);

  ipcMain.handle('chat-message', async (_event, text: string) => {
    if (!isValidChatMessage(text)) {
      console.warn('[IPC] invalid payload for chat-message');
      return;
    }
    const ctx = getAppContext();
    if (!ctx.lifecycle.acceptingWork || ctx.lifecycle.snapshot.capabilities.router?.state !== 'ready') {
      ctx.bus.emit('runtime', 'llm:error', {
        message: 'Sarah ist noch nicht bereit oder der Router ist nicht verfügbar.',
      });
      return;
    }
    const voiceService = ctx.registry.get('voice') as VoiceService | undefined;
    if (voiceService && voiceService.voiceState === 'idle' && voiceService.status === 'running') {
      voiceService.setChatSpeak();
    }
    ctx.bus.emit('renderer', 'chat:message', { text, mode: 'chat' });
  });
  ipcMain.handle('get-runtime-status', () => getAppContext().lifecycle.snapshot);

  const bus: MessageBus = getAppContext().bus;
  const unsubscribers = [
    forwardToRenderers(bus, 'llm:chunk'),
    forwardToRenderers(bus, 'llm:done'),
    forwardToRenderers(bus, 'llm:error'),
    forwardToRenderers(bus, 'storage:degraded'),
  ];

  const runtimeUnsubscribe = getAppContext().lifecycle.subscribe((snapshot) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('runtime-status', snapshot);
  });

  let perfStart = 0;
  let perfData: Record<string, unknown> = {};
  unsubscribers.push(bus.on('perf:timing', (msg) => {
    const { label, ms, meta } = msg.data;
    if (!perfStart) perfStart = Date.now();
    perfData[`${label}Ms`] = ms;
    if (meta) Object.assign(perfData, meta);
    if (label === 'router') perfData.usedWorker = false;
    if (label === 'worker') perfData.usedWorker = true;
  }));

  const logPerf = (): void => {
    if (!perfStart) return;
    const msKeys = Object.keys(perfData).filter((key) => key.endsWith('Ms'));
    const totalMs = msKeys.reduce((sum, key) => sum + (perfData[key] as number), 0);
    console.log('\n[Performance]', JSON.stringify({ totalMs, ...perfData }, null, 2));
    perfStart = 0;
    perfData = {};
  };
  unsubscribers.push(bus.on('voice:done', logPerf));
  unsubscribers.push(bus.on('llm:done', () => {
    if (!perfData.whisperMs) logPerf();
  }));

  const onBootDone = (): void => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const { height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const targetW = Math.round(screenH * 0.3);
    const targetH = Math.round(screenH * 0.33);
    const startBounds = mainWindow.getBounds();
    const startTime = Date.now();
    mainWindow.webContents.send('transition-start');

    transitionInterval = setInterval(() => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) {
        if (transitionInterval) clearInterval(transitionInterval);
        transitionInterval = null;
        return;
      }
      const progress = Math.min((Date.now() - startTime) / 1_500, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      win.setBounds({
        x: Math.round(startBounds.x * (1 - eased)),
        y: Math.round(startBounds.y * (1 - eased)),
        width: Math.round(startBounds.width + (targetW - startBounds.width) * eased),
        height: Math.round(startBounds.height + (targetH - startBounds.height) * eased),
      });
      if (progress >= 1 && transitionInterval) {
        clearInterval(transitionInterval);
        transitionInterval = null;
      }
    }, 16);
  };
  ipcMain.once('boot-done', onBootDone);

  return () => {
    if (stopped) return;
    stopped = true;
    if (transitionInterval) clearInterval(transitionInterval);
    transitionInterval = null;
    if (revealTimeout) clearTimeout(revealTimeout);
    revealTimeout = null;
    revealResolver?.();
    revealResolver = null;
    for (const pending of pendingDelays) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    pendingDelays.clear();
    ipcMain.removeListener('boot-ready', onBootReady);
    ipcMain.removeListener('splash-done', onSplashDone);
    ipcMain.removeListener('wizard-done', onWizardDone);
    ipcMain.removeListener('boot-done', onBootDone);
    ipcMain.removeHandler('splash-tts');
    ipcMain.removeHandler('chat-message');
    ipcMain.removeHandler('get-runtime-status');
    for (const unsubscribe of unsubscribers) unsubscribe();
    runtimeUnsubscribe();
  };
}
