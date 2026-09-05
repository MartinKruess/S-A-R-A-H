import * as path from 'path';
import { randomUUID } from 'crypto';
import { BrowserWindow, dialog, ipcMain, screen } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { MessageBus } from '../core/message-bus.js';
import type { OllamaContainerManager } from '../services/llm/ollama-container-manager.js';
import type { RouterService } from '../services/llm/router-service.js';
import type { PiperProvider } from '../services/voice/providers/piper-provider.js';
import { VoiceService } from '../services/voice/voice-service.js';
import {
  forwardToRenderers,
  forwardValidatedSpecialistStateToRenderers,
  sendToRendererSafely,
} from './forward-to-renderers.js';
import { SpecialistTaskSnapshotSchema } from '../core/specialist-task.js';
import { isValidChatInput, isValidChatMessage } from './ipc-validation.js';
import { deriveBootCapabilitySteps } from './boot-capabilities.js';
import type { CapabilitySnapshot } from '../core/app-lifecycle-controller.js';
import { CHAT_UNAVAILABLE_MESSAGE, isChatAvailable } from '../core/chat-availability.js';
import { runWithTimeout } from '../core/abort-utils.js';

export interface BootSequenceDeps {
  getMainWindow: () => BrowserWindow | null;
  getAppContext: () => AppContext;
  piperProvider: PiperProvider;
  containerManager: OllamaContainerManager;
  /** Splash completion captured before slow bootstrap/config dialogs finish. */
  splashDone?: Promise<void>;
}

type BootSeverity = 'info' | 'warning' | 'error';
const SPLASH_TTS_EXPIRY_MS = 8_000;
const ROUTER_CAPABILITY_TIMEOUT_MS = 150_000;
const GPU_PROBE_TIMEOUT_MS = 5_000;
const LIFECYCLE_BOOT_TIMEOUT_MS = 330_000;
const MANUAL_RECOVERY_TIMEOUT_MS = 150_000;

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
  let activeSplashTts: {
    controller: AbortController;
    expiry: ReturnType<typeof setTimeout>;
  } | null = null;
  let activeBoot: Promise<void> | null = null;
  let activeRuntimeRecovery: Promise<{
    ok: boolean;
    modelRecovered: boolean;
    sttRecovered: boolean;
    message?: string;
  }> | null = null;
  const pendingDelays = new Set<{
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
  }>();

  const send = (step: string, message?: string, severity: BootSeverity = 'info'): void => {
    if (stopped) return;
    const win = getMainWindow();
    sendToRendererSafely(win, 'boot-status', { step, message, severity });
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
    signal?: AbortSignal,
  ): Promise<CapabilitySnapshot | undefined> => new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let unsubscribeAfterRegistration = false;
    let settled = false;
    const finish = (capability?: CapabilitySnapshot): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (unsubscribe) unsubscribe();
      else unsubscribeAfterRegistration = true;
      resolve(capability);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      if (unsubscribe) unsubscribe();
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new Error('Capability wait aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
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
      const router = await runWithTimeout(
        (signal) => waitForCapability(ctx, 'router', lifecycleStart, signal),
        ROUTER_CAPABILITY_TIMEOUT_MS,
        'Sarah-Protokoll konnte nicht rechtzeitig aktiviert werden.',
      );
      const routerStep = deriveBootCapabilitySteps(router, { stt: false, tts: false }).router;

      if (routerStep === 'router-ready') {
        const gpu = await runWithTimeout(
          (signal) => containerManager.checkGpu(signal),
          GPU_PROBE_TIMEOUT_MS,
          'GPU-Status konnte nicht rechtzeitig geprüft werden.',
        ).catch(() => 'unknown' as const);
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
      await runWithTimeout(
        () => lifecycleStart,
        LIFECYCLE_BOOT_TIMEOUT_MS,
        'Sarah-Dienste konnten nicht rechtzeitig aktiviert werden.',
      );
      const currentRouter = ctx.lifecycle.snapshot.capabilities.router;
      const currentRouterStep = deriveBootCapabilitySteps(
        currentRouter,
        { stt: false, tts: false },
      ).router;
      if (currentRouterStep !== routerStep) {
        if (currentRouterStep === 'router-ready') {
          send(currentRouterStep);
        } else {
          send(
            currentRouterStep,
            currentRouter?.message
              ?? 'Sarah-Protokoll ist nicht verfügbar. Text- und Spracheingaben bleiben deaktiviert.',
            'error',
          );
        }
      }
      const voice = ctx.registry.get('voice') as VoiceService | undefined;
      const voiceCapabilities = voice?.capabilitySnapshot ?? { stt: false, tts: false };
      const steps = deriveBootCapabilitySteps(currentRouter, voiceCapabilities);

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
      const currentRouter = getAppContext().lifecycle.snapshot.capabilities.router;
      const currentRouterStep = deriveBootCapabilitySteps(
        currentRouter,
        { stt: false, tts: false },
      ).router;
      if (currentRouterStep === 'router-ready') {
        send('router-ready');
      } else {
        send('router-terminal', currentRouter?.message ?? message, 'error');
      }
      send('whisper-unavailable', 'Spracherkennung konnte nicht aktiviert werden.', 'warning');
      await waitForReveal();
      send('piper-unavailable', 'Sprachausgabe konnte nicht aktiviert werden.', 'warning');
    }
  };

  const onBootReady = (): void => {
    if (activeBoot) return;
    activeBoot = runBoot().finally(() => {
      activeBoot = null;
    });
  };
  ipcMain.on('boot-ready', onBootReady);

  const cancelSplashTts = (): void => {
    const request = activeSplashTts;
    if (!request) return;
    activeSplashTts = null;
    clearTimeout(request.expiry);
    request.controller.abort();
  };

  ipcMain.handle('splash-tts', async (_event, text: string) => {
    if (!isValidChatMessage(text)) {
      console.warn('[IPC] invalid payload for splash-tts');
      return null;
    }
    cancelSplashTts();
    const controller = new AbortController();
    const request = {
      controller,
      expiry: setTimeout(() => controller.abort(), SPLASH_TTS_EXPIRY_MS),
    };
    request.expiry.unref?.();
    activeSplashTts = request;
    try {
      const audio = await piperProvider.speak(text, controller.signal);
      if (stopped || controller.signal.aborted || activeSplashTts !== request) return null;
      return { audio: Array.from(audio), sampleRate: 22050 };
    } catch (err) {
      if (!controller.signal.aborted) console.error('[Boot] Splash TTS failed:', err);
      return null;
    } finally {
      clearTimeout(request.expiry);
      if (activeSplashTts === request) activeSplashTts = null;
    }
  });

  const loadFileWithVisibleFailure = (fileName: string, label: string): void => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void mainWindow.loadFile(path.join(__dirname, '..', '..', fileName)).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Boot] ${label} could not be loaded:`, error);
      dialog.showErrorBox(
        'Sarah konnte die Oberfläche nicht laden',
        `${label} konnte nicht geladen werden. Bitte starte Sarah neu.\n\n${message}`,
      );
    });
  };

  const loadDashboardBootMode = (): void => {
    loadFileWithVisibleFailure('dashboard.html', 'Das Dashboard');
  };

  const onSplashDone = (): void => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    if (getAppContext().parsedConfig.onboarding.setupComplete) {
      loadDashboardBootMode();
    } else {
      mainWindow.maximize();
      loadFileWithVisibleFailure('wizard.html', 'Der Einrichtungsassistent');
    }
  };
  if (deps.splashDone) {
    void deps.splashDone.then(() => {
      if (!stopped) onSplashDone();
    });
  } else {
    ipcMain.on('splash-done', onSplashDone);
  }

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

  ipcMain.handle('chat-message', async (_event, input: unknown) => {
    if (!isValidChatInput(input)) {
      console.warn('[IPC] invalid payload for chat-message');
      return { accepted: false, turnId: randomUUID() };
    }
    const { turnId, message, mode } = input;
    const ctx = getAppContext();
    if (ctx.bus.isTurnKnown(turnId)) {
      console.warn('[IPC] duplicate turnId for chat-message refused:', turnId);
      return { accepted: false, turnId };
    }
    const accepted = ctx.bus.emit('runtime', 'turn:accepted', {
      turnId,
      source: 'chat',
      mode,
    });
    if (!accepted) return { accepted: false, turnId };
    if (!isChatAvailable(ctx.lifecycle.snapshot)) {
      ctx.bus.emit('runtime', 'llm:error', {
        turnId,
        message: CHAT_UNAVAILABLE_MESSAGE,
      });
      ctx.bus.emit('runtime', 'turn:terminal', {
        turnId,
        status: 'error',
        message: CHAT_UNAVAILABLE_MESSAGE,
      });
      return { accepted: false, turnId };
    }
    const published = ctx.bus.emit('renderer', 'chat:message', {
      turnId,
      source: 'chat',
      mode,
      originalText: message,
      createdAt: new Date().toISOString(),
    });
    return { accepted: published, turnId };
  });
  ipcMain.handle('get-runtime-status', () => getAppContext().lifecycle.snapshot);
  ipcMain.handle('retry-runtime-recovery', () => {
    if (activeRuntimeRecovery) return activeRuntimeRecovery;
    const attempt = async (): Promise<{
      ok: boolean;
      modelRecovered: boolean;
      sttRecovered: boolean;
      message?: string;
    }> => {
      const ctx = getAppContext();
      const router = ctx.registry?.get('router') as RouterService | undefined;
      const voice = ctx.registry?.get('voice') as VoiceService | undefined;
      const routerState = ctx.lifecycle.snapshot.capabilities.router?.state;
      const workerState = ctx.lifecycle.snapshot.capabilities.local_worker?.state;
      const sttState = ctx.lifecycle.snapshot.capabilities.stt?.state;
      const modelNeedsRecovery = routerState === 'degraded'
        || routerState === 'unavailable'
        || routerState === 'error'
        || workerState === 'degraded'
        || workerState === 'unavailable'
        || workerState === 'error';
      const sttNeedsRecovery = sttState === 'degraded'
        || sttState === 'unavailable'
        || sttState === 'error';
      const [model, stt] = await Promise.allSettled([
        modelNeedsRecovery
          ? runWithTimeout(
              (signal) => router
                ? router.retryRuntimeRecovery(signal)
                : Promise.reject(new Error('Router service is unavailable')),
              MANUAL_RECOVERY_TIMEOUT_MS,
              'Model runtime recovery timed out',
            )
          : Promise.resolve(),
        sttNeedsRecovery
          ? runWithTimeout(
              (signal) => voice
                ? voice.retryRuntimeRecovery(signal)
                : Promise.reject(new Error('Voice service is unavailable')),
              MANUAL_RECOVERY_TIMEOUT_MS,
              'Speech recognition recovery timed out',
            )
          : Promise.resolve(),
      ]);
      const modelRecovered = model.status === 'fulfilled';
      const sttRecovered = stt.status === 'fulfilled';
      const messages = [model, stt]
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      return {
        ok: modelRecovered && sttRecovered,
        modelRecovered,
        sttRecovered,
        ...(messages.length > 0 ? { message: messages.join(' ') } : {}),
      };
    };
    activeRuntimeRecovery = attempt().finally(() => {
      activeRuntimeRecovery = null;
    });
    return activeRuntimeRecovery;
  });
  ipcMain.handle('get-privacy-state', () => {
    const router = getAppContext().registry?.get('router') as RouterService | undefined;
    return router?.privacyState ?? { incognitoActive: false };
  });

  const bus: MessageBus = getAppContext().bus;
  const unsubscribers = [
    forwardToRenderers(bus, 'llm:chunk'),
    forwardToRenderers(bus, 'llm:done'),
    forwardToRenderers(bus, 'llm:error'),
    forwardToRenderers(bus, 'turn:terminal'),
    forwardToRenderers(bus, 'storage:degraded'),
    forwardToRenderers(bus, 'privacy:incognito'),
    forwardValidatedSpecialistStateToRenderers(bus, (payload) => {
      const parsed = SpecialistTaskSnapshotSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    }),
  ];

  const runtimeUnsubscribe = getAppContext().lifecycle.subscribe((snapshot) => {
    sendToRendererSafely(getMainWindow(), 'runtime-status', snapshot);
  });

  const perfByTurn = new Map<string, {
    startedAt: number;
    data: Record<string, unknown>;
    terminal: boolean;
    voiceExpected: boolean;
    voiceDone: boolean;
    fallback: ReturnType<typeof setTimeout> | null;
  }>();
  unsubscribers.push(bus.on('perf:timing', (msg) => {
    const { turnId, label, ms, meta } = msg.data;
    if (!turnId) return;
    const existing = perfByTurn.get(turnId);
    if (!existing && bus.isTurnTerminal(turnId)) return;
    const current = existing ?? {
      startedAt: Date.now(),
      data: {},
      terminal: false,
      voiceExpected: false,
      voiceDone: false,
      fallback: null,
    };
    current.data[`${label}Ms`] = ms;
    if (meta) Object.assign(current.data, meta);
    if (label === 'router') current.data.usedWorker = false;
    if (label === 'worker') current.data.usedWorker = true;
    perfByTurn.set(turnId, current);
  }));

  const logPerf = (turnId: string): void => {
    const current = perfByTurn.get(turnId);
    if (!current) return;
    if (current.fallback) clearTimeout(current.fallback);
    const msKeys = Object.keys(current.data).filter((key) => key.endsWith('Ms'));
    const totalMs = msKeys.reduce((sum, key) => sum + (current.data[key] as number), 0);
    console.log('\n[Performance]', JSON.stringify({
      turnId,
      wallMs: Date.now() - current.startedAt,
      totalMs,
      ...current.data,
    }, null, 2));
    perfByTurn.delete(turnId);
  };
  unsubscribers.push(bus.on('voice:speaking', (msg) => {
    const current = perfByTurn.get(msg.data.turnId) ?? {
      startedAt: Date.now(),
      data: {},
      terminal: false,
      voiceExpected: false,
      voiceDone: false,
      fallback: null,
    };
    current.voiceExpected = true;
    perfByTurn.set(msg.data.turnId, current);
  }));
  unsubscribers.push(bus.on('voice:done', (msg) => {
    const current = perfByTurn.get(msg.data.turnId);
    if (!current) return;
    current.voiceDone = true;
    if (current.terminal) logPerf(msg.data.turnId);
  }));
  unsubscribers.push(bus.on('turn:terminal', (msg) => {
    const current = perfByTurn.get(msg.data.turnId);
    if (!current) return;
    current.terminal = true;
    if (!current.voiceExpected || current.voiceDone) {
      logPerf(msg.data.turnId);
      return;
    }
    current.fallback = setTimeout(() => logPerf(msg.data.turnId), 30_000);
    current.fallback.unref?.();
  }));

  const onBootDone = (): void => {
    cancelSplashTts();
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (transitionInterval) clearInterval(transitionInterval);
    transitionInterval = null;

    const { height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const targetW = Math.round(screenH * 0.3);
    const targetH = Math.round(screenH * 0.33);
    const startBounds = mainWindow.getBounds();
    const startTime = Date.now();
    sendToRendererSafely(mainWindow, 'transition-start');

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
  ipcMain.on('boot-done', onBootDone);

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
    cancelSplashTts();
    ipcMain.removeListener('boot-ready', onBootReady);
    if (!deps.splashDone) ipcMain.removeListener('splash-done', onSplashDone);
    ipcMain.removeListener('wizard-done', onWizardDone);
    ipcMain.removeListener('boot-done', onBootDone);
    ipcMain.removeHandler('splash-tts');
    ipcMain.removeHandler('chat-message');
    ipcMain.removeHandler('get-runtime-status');
    ipcMain.removeHandler('retry-runtime-recovery');
    ipcMain.removeHandler('get-privacy-state');
    for (const perf of perfByTurn.values()) {
      if (perf.fallback) clearTimeout(perf.fallback);
    }
    perfByTurn.clear();
    for (const unsubscribe of unsubscribers) unsubscribe();
    runtimeUnsubscribe();
  };
}
