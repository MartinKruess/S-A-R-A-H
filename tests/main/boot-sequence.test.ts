import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBus } from '../../src/core/message-bus.js';

const electronMocks = vi.hoisted(() => {
  type Listener = (...args: Array<string | number | object | null | undefined>) => void;
  type SplashResult = { audio: number[]; sampleRate: number } | null;
  type Handler = (_event: object, payload: string) => Promise<SplashResult>;
  const listeners = new Map<string, Array<{ listener: Listener; once: boolean }>>();
  const handlers = new Map<string, Handler>();

  const addListener = (channel: string, listener: Listener, once: boolean): void => {
    const entries = listeners.get(channel) ?? [];
    entries.push({ listener, once });
    listeners.set(channel, entries);
  };

  return {
    handlers,
    getAllWindows: vi.fn(() => []),
    showErrorBox: vi.fn(),
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
      on: (channel: string, listener: Listener) => addListener(channel, listener, false),
      once: (channel: string, listener: Listener) => addListener(channel, listener, true),
      removeListener: (channel: string, listener: Listener) => {
        listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry.listener !== listener));
      },
    },
    emit(channel: string): void {
      const entries = [...(listeners.get(channel) ?? [])];
      listeners.set(channel, entries.filter((entry) => !entry.once));
      for (const entry of entries) entry.listener();
    },
    reset(): void {
      listeners.clear();
      handlers.clear();
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: electronMocks.getAllWindows },
  dialog: { showErrorBox: electronMocks.showErrorBox },
  ipcMain: electronMocks.ipcMain,
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
}));

import { registerBootHandlers } from '../../src/main/boot-sequence.js';

describe('main boot sequence splash speech ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electronMocks.reset();
    electronMocks.getAllWindows.mockClear();
    electronMocks.showErrorBox.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('aborts and discards splash speech that finishes after renderer fallback', async () => {
    let resolveSpeech!: (audio: Float32Array) => void;
    let speechSignal: AbortSignal | undefined;
    const speak = vi.fn((_text: string, signal?: AbortSignal) => {
      speechSignal = signal;
      return new Promise<Float32Array>((resolve) => { resolveSpeech = resolve; });
    });
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setBounds: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      setSize: vi.fn(),
      setPosition: vi.fn(),
    };
    const bus = new MessageBus();
    const snapshot = { state: 'ready', capabilities: {} };
    const context = {
      bus,
      parsedConfig: { onboarding: { setupComplete: true } },
      registry: { get: vi.fn() },
      lifecycle: {
        snapshot,
        subscribe: vi.fn((listener: (value: typeof snapshot) => void) => {
          listener(snapshot);
          return vi.fn();
        }),
      },
    };

    const cleanup = registerBootHandlers({
      getMainWindow: () => mainWindow as never,
      getAppContext: () => context as never,
      piperProvider: { speak } as never,
      containerManager: { checkGpu: vi.fn() } as never,
    });
    const handler = electronMocks.handlers.get('splash-tts');
    expect(handler).toBeDefined();

    const request = handler!({}, 'Huch, jetzt bin ich einsatzbereit!');
    await Promise.resolve();
    electronMocks.emit('boot-done');

    expect(speechSignal?.aborted).toBe(true);
    resolveSpeech(new Float32Array([0.25]));
    await expect(request).resolves.toBeNull();
    expect(send).not.toHaveBeenCalledWith('voice:play-audio', expect.anything());

    cleanup();
  });

  it('consumes splash completion that was captured before boot handlers registered', async () => {
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: vi.fn() },
      loadFile: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      parsedConfig: { onboarding: { setupComplete: true } },
      bus: new MessageBus(),
      lifecycle: { snapshot: { state: 'registered', capabilities: {} }, subscribe: vi.fn(() => vi.fn()) },
      registry: { get: vi.fn() },
    };

    const cleanup = registerBootHandlers({
      getMainWindow: () => mainWindow as never,
      getAppContext: () => context as never,
      piperProvider: { speak: vi.fn() } as never,
      containerManager: { checkGpu: vi.fn() } as never,
      splashDone: Promise.resolve(),
    });
    await Promise.resolve();

    expect(mainWindow.loadFile).toHaveBeenCalledWith(expect.stringMatching(/dashboard\.html$/));
    cleanup();
  });

  it('keeps boot handlers registered when runtime-status delivery races renderer teardown', () => {
    const snapshot = { state: 'registered', capabilities: {} };
    const context = {
      parsedConfig: { onboarding: { setupComplete: true } },
      bus: new MessageBus(),
      lifecycle: {
        snapshot,
        subscribe: vi.fn((listener: (value: typeof snapshot) => void) => {
          listener(snapshot);
          return vi.fn();
        }),
      },
      registry: { get: vi.fn() },
    };
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn(() => { throw new Error('renderer gone'); }),
      },
    };

    const cleanup = registerBootHandlers({
      getMainWindow: () => mainWindow as never,
      getAppContext: () => context as never,
      piperProvider: { speak: vi.fn() } as never,
      containerManager: { checkGpu: vi.fn() } as never,
    });

    expect(electronMocks.handlers.has('get-runtime-status')).toBe(true);
    cleanup();
  });

  it('exposes manual model and speech recovery through one bounded IPC request', async () => {
    const retryModel = vi.fn().mockResolvedValue(undefined);
    const retrySpeech = vi.fn().mockResolvedValue(undefined);
    const snapshot = {
      state: 'degraded',
      capabilities: {
        router: { state: 'error', message: 'Docker fehlt' },
        stt: { state: 'unavailable', message: 'Python fehlt' },
      },
    };
    const context = {
      parsedConfig: { onboarding: { setupComplete: true } },
      bus: new MessageBus(),
      lifecycle: { snapshot, subscribe: vi.fn(() => vi.fn()) },
      registry: {
        get: vi.fn((id: string) => (
          id === 'router'
            ? { retryRuntimeRecovery: retryModel }
            : id === 'voice'
              ? { retryRuntimeRecovery: retrySpeech }
              : undefined
        )),
      },
    };
    const cleanup = registerBootHandlers({
      getMainWindow: () => null,
      getAppContext: () => context as never,
      piperProvider: { speak: vi.fn() } as never,
      containerManager: { checkGpu: vi.fn() } as never,
    });
    const handler = electronMocks.handlers.get('retry-runtime-recovery') as unknown as (
      event: object,
    ) => Promise<{ ok: boolean; modelRecovered: boolean; sttRecovered: boolean }>;

    await expect(handler({})).resolves.toEqual({
      ok: true,
      modelRecovered: true,
      sttRecovered: true,
    });
    expect(retryModel).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(retrySpeech).toHaveBeenCalledWith(expect.any(AbortSignal));
    cleanup();
    expect(electronMocks.handlers.has('retry-runtime-recovery')).toBe(false);
  });

  it('publishes terminal degraded boot steps when router capability never settles', async () => {
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setBounds: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      setSize: vi.fn(),
      setPosition: vi.fn(),
    };
    const bus = new MessageBus();
    const lifecycleStart = new Promise<void>(() => {});
    const snapshot = {
      state: 'starting',
      capabilities: { router: { state: 'starting' } },
    };
    const context = {
      bus,
      parsedConfig: { onboarding: { setupComplete: true } },
      registry: { get: vi.fn() },
      lifecycle: {
        snapshot,
        start: vi.fn(() => lifecycleStart),
        subscribe: vi.fn(() => vi.fn()),
      },
    };
    const cleanup = registerBootHandlers({
      getMainWindow: () => mainWindow as never,
      getAppContext: () => context as never,
      piperProvider: { speak: vi.fn() } as never,
      containerManager: { checkGpu: vi.fn() } as never,
    });

    electronMocks.emit('boot-ready');
    await vi.advanceTimersByTimeAsync(150_000);
    await Promise.resolve();

    expect(send).toHaveBeenCalledWith(
      'boot-status',
      expect.objectContaining({ step: 'router-terminal', severity: 'error' }),
    );

    await vi.advanceTimersByTimeAsync(8_000);
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith(
      'boot-status',
      expect.objectContaining({ step: 'piper-unavailable', severity: 'warning' }),
    );

    cleanup();
  });

  it('corrects an initial router failure when recovery finishes before lifecycle start', async () => {
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setBounds: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      setSize: vi.fn(),
      setPosition: vi.fn(),
    };
    const bus = new MessageBus();
    let resolveLifecycleStart!: () => void;
    const lifecycleStart = new Promise<void>((resolve) => { resolveLifecycleStart = resolve; });
    let snapshot: {
      state: string;
      capabilities: { router: { state: string; message?: string } };
    } = {
      state: 'starting',
      capabilities: {
        router: { state: 'unavailable', message: 'Ollama offline' },
      },
    };
    const listeners = new Set<(value: typeof snapshot) => void>();
    const context = {
      bus,
      parsedConfig: { onboarding: { setupComplete: true } },
      registry: {
        get: vi.fn(() => ({ capabilitySnapshot: { stt: true, tts: true } })),
      },
      lifecycle: {
        get snapshot() { return snapshot; },
        start: vi.fn(() => lifecycleStart),
        subscribe: vi.fn((listener: (value: typeof snapshot) => void) => {
          listeners.add(listener);
          listener(snapshot);
          return () => listeners.delete(listener);
        }),
      },
    };
    const cleanup = registerBootHandlers({
      getMainWindow: () => mainWindow as never,
      getAppContext: () => context as never,
      piperProvider: { speak: vi.fn() } as never,
      containerManager: { checkGpu: vi.fn() } as never,
    });

    electronMocks.emit('boot-ready');
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'boot-status',
        expect.objectContaining({ step: 'router-terminal', severity: 'error' }),
      );
    });

    snapshot = {
      state: 'ready',
      capabilities: { router: { state: 'ready' } },
    };
    for (const listener of listeners) listener(snapshot);
    resolveLifecycleStart();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'boot-status',
        expect.objectContaining({ step: 'router-ready' }),
      );
    });

    const terminalIndex = send.mock.calls.findIndex(([, payload]) => payload.step === 'router-terminal');
    const readyIndex = send.mock.calls.findIndex(([, payload]) => payload.step === 'router-ready');
    expect(readyIndex).toBeGreaterThan(terminalIndex);
    cleanup();
  });

  it('accepts a second dashboard boot handshake after the wizard reloads it', async () => {
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setBounds: vi.fn(),
    };
    const snapshot = { state: 'ready', capabilities: { router: { state: 'ready' } } };
    const lifecycle = {
      snapshot,
      start: vi.fn(async () => snapshot),
      subscribe: vi.fn((listener: (value: typeof snapshot) => void) => {
        listener(snapshot);
        return vi.fn();
      }),
    };
    const context = {
      bus: new MessageBus(),
      parsedConfig: { onboarding: { setupComplete: true } },
      registry: { get: vi.fn(() => ({ capabilitySnapshot: { stt: false, tts: false } })) },
      lifecycle,
    };
    const cleanup = registerBootHandlers({
      getMainWindow: () => mainWindow as never,
      getAppContext: () => context as never,
      piperProvider: { speak: vi.fn() } as never,
      containerManager: { checkGpu: vi.fn(async () => 'gpu') } as never,
    });

    electronMocks.emit('boot-ready');
    await vi.waitFor(() => expect(lifecycle.start).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(
      'boot-status',
      expect.objectContaining({ step: 'whisper-unavailable' }),
    ));
    electronMocks.emit('reveal-done');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(
      'boot-status',
      expect.objectContaining({ step: 'piper-unavailable' }),
    ));

    electronMocks.emit('boot-ready');
    await vi.waitFor(() => expect(lifecycle.start).toHaveBeenCalledTimes(2));
    cleanup();
  });

  it('keeps an already-ready router truthful when the remaining lifecycle start times out', async () => {
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setBounds: vi.fn(),
    };
    const snapshot = { state: 'starting', capabilities: { router: { state: 'ready' } } };
    const context = {
      bus: new MessageBus(),
      parsedConfig: { onboarding: { setupComplete: true } },
      registry: { get: vi.fn() },
      lifecycle: {
        snapshot,
        start: vi.fn(() => new Promise<void>(() => {})),
        subscribe: vi.fn((listener: (value: typeof snapshot) => void) => {
          listener(snapshot);
          return vi.fn();
        }),
      },
    };
    const cleanup = registerBootHandlers({
      getMainWindow: () => mainWindow as never,
      getAppContext: () => context as never,
      piperProvider: { speak: vi.fn() } as never,
      containerManager: { checkGpu: vi.fn(async () => 'gpu') } as never,
    });

    electronMocks.emit('boot-ready');
    await vi.advanceTimersByTimeAsync(330_000);
    await Promise.resolve();

    expect(send).not.toHaveBeenCalledWith(
      'boot-status',
      expect.objectContaining({ step: 'router-terminal' }),
    );
    expect(send).toHaveBeenCalledWith(
      'boot-status',
      expect.objectContaining({ step: 'router-ready' }),
    );
    cleanup();
  });

  it('shows a visible error when the dashboard transition cannot be loaded', async () => {
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: vi.fn() },
      loadFile: vi.fn().mockRejectedValue(new Error('disk read failed')),
      unmaximize: vi.fn(),
      setSize: vi.fn(),
      setPosition: vi.fn(),
    };
    const context = {
      bus: new MessageBus(),
      parsedConfig: { onboarding: { setupComplete: true } },
      registry: { get: vi.fn() },
      lifecycle: { snapshot: { state: 'ready', capabilities: {} }, subscribe: vi.fn(() => vi.fn()) },
    };
    const cleanup = registerBootHandlers({
      getMainWindow: () => mainWindow as never,
      getAppContext: () => context as never,
      piperProvider: { speak: vi.fn() } as never,
      containerManager: { checkGpu: vi.fn() } as never,
    });

    electronMocks.emit('wizard-done');
    await Promise.resolve();
    await Promise.resolve();

    expect(electronMocks.showErrorBox).toHaveBeenCalledWith(
      'Sarah konnte die Oberfläche nicht laden',
      expect.stringContaining('Das Dashboard konnte nicht geladen werden'),
    );
    cleanup();
  });

  it('preserves voice mode for typed chat while keeping chat as the request source', async () => {
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setBounds: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      setSize: vi.fn(),
      setPosition: vi.fn(),
    };
    const bus = new MessageBus();
    const snapshot = {
      state: 'ready',
      capabilities: { router: { state: 'ready' } },
    };
    const context = {
      bus,
      parsedConfig: { onboarding: { setupComplete: true } },
      registry: { get: vi.fn() },
      lifecycle: {
        snapshot,
        subscribe: vi.fn((listener: (value: typeof snapshot) => void) => {
          listener(snapshot);
          return vi.fn();
        }),
      },
    };
    const requests: Array<{ source: string; mode: string; originalText: string }> = [];
    bus.on('chat:message', (message) => requests.push(message.data));
    const cleanup = registerBootHandlers({
      getMainWindow: () => mainWindow as never,
      getAppContext: () => context as never,
      piperProvider: { speak: vi.fn() } as never,
      containerManager: { checkGpu: vi.fn() } as never,
    });
    const handler = electronMocks.handlers.get('chat-message') as unknown as (
      event: object,
      input: { turnId: string; message: string; mode: 'chat' | 'voice' },
    ) => Promise<{ accepted: boolean; turnId: string }>;
    const turnId = '34343434-3434-4434-8434-343434343434';

    await expect(handler({}, { turnId, message: 'Erkläre mir Rom', mode: 'voice' })).resolves.toEqual({
      accepted: true,
      turnId,
    });
    expect(requests).toEqual([{
      turnId,
      source: 'chat',
      mode: 'voice',
      originalText: 'Erkläre mir Rom',
      createdAt: expect.any(String),
    }]);

    cleanup();
  });
});
