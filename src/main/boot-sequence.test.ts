import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBus } from '../core/message-bus.js';

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
  ipcMain: electronMocks.ipcMain,
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
}));

import { registerBootHandlers } from './boot-sequence.js';

describe('main boot sequence splash speech ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electronMocks.reset();
    electronMocks.getAllWindows.mockClear();
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
      webContents: { send },
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

  it('publishes terminal degraded boot steps when router capability never settles', async () => {
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send },
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

    cleanup();
  });

  it('preserves voice mode for typed chat while keeping chat as the request source', async () => {
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send },
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
