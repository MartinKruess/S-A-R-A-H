import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMain } from 'electron';
import type { AppContext } from '../../src/core/bootstrap.js';
import type { SarahConfigPatch } from '../../src/core/config-schema.js';
import { SarahConfigSchema } from '../../src/core/config-schema.js';
import { registerConfigHandlers } from '../../src/main/ipc-config.js';
import { MAX_MEMORY_EXCLUSIONS, MAX_MEMORY_EXCLUSION_LENGTH } from '../../src/core/memory-exclusions.js';

type Handler = (event: object, input: SarahConfigPatch) => Promise<object>;

function fakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, listener: Handler) => {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

describe('save-config audio patches', () => {
  it('reconfigures VoiceService only for voice mode or PTT-key changes', async () => {
    const initial = SarahConfigSchema.parse({});
    let stored: Record<string, object> = { ...initial };
    const applyConfig = vi.fn(async () => undefined);
    const setRendererCaptureReady = vi.fn();
    const context = {
      parsedConfig: initial,
      registry: {
        get: vi.fn(() => ({ applyConfig, setRendererCaptureReady })),
      },
      config: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (_key: string, value: Record<string, object>) => { stored = value; }),
      },
    } as unknown as AppContext;
    const { ipcMain, handlers } = fakeIpcMain();
    registerConfigHandlers(ipcMain, {
      getAppContext: () => context,
      getMainWindow: () => null,
      dialogWindows: new Map(),
    });
    const save = handlers.get('save-config');
    if (!save) throw new Error('save-config handler was not registered');

    await save({}, {
      controls: { ...initial.controls, quietModeDuration: 120 },
    });
    expect(applyConfig).not.toHaveBeenCalled();

    await save({}, {
      controls: { ...context.parsedConfig.controls, pushToTalkKey: 'F10' },
    });
    expect(applyConfig).toHaveBeenCalledOnce();
    expect(setRendererCaptureReady).not.toHaveBeenCalled();
  });

  it('removes reserved collisions from programmatic custom-command saves', async () => {
    const initial = SarahConfigSchema.parse({});
    let stored: Record<string, object> = { ...initial };
    const context = {
      parsedConfig: initial,
      registry: {
        get: vi.fn(() => ({ applyConfig: vi.fn(async () => undefined) })),
      },
      config: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (_key: string, value: Record<string, object>) => { stored = value; }),
      },
    } as unknown as AppContext;
    const { ipcMain, handlers } = fakeIpcMain();
    registerConfigHandlers(ipcMain, {
      getAppContext: () => context,
      getMainWindow: () => null,
      dialogWindows: new Map(),
    });
    const save = handlers.get('save-config');
    if (!save) throw new Error('save-config handler was not registered');

    await save({}, {
      controls: {
        ...initial.controls,
        customCommands: [
          { command: '/confirm', prompt: 'Kollision' },
          { command: '/eigen', prompt: 'Bleibt erhalten' },
        ],
      },
    });

    expect(context.parsedConfig.controls.customCommands).toEqual([
      { command: '/eigen', prompt: 'Bleibt erhalten' },
    ]);
    expect((stored.controls as {
      customCommands: Array<{ command: string; prompt: string }>;
    }).customCommands).toEqual([
      { command: '/eigen', prompt: 'Bleibt erhalten' },
    ]);
  });

  it('serially merges independent audio patches into the latest committed state', async () => {
    const initial = SarahConfigSchema.parse({});
    let stored: Record<string, object> = { ...initial };
    const config = {
      get: vi.fn(async () => stored),
      set: vi.fn(async (_key: string, value: Record<string, object>) => {
        stored = value;
      }),
    };
    const context = {
      parsedConfig: initial,
      config,
    } as unknown as AppContext;
    const { ipcMain, handlers } = fakeIpcMain();
    const send = vi.fn();
    const dialogSend = vi.fn();
    const dialogWindows = new Map([
      ['settings', {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: dialogSend },
      } as BrowserWindow],
    ]);
    registerConfigHandlers(ipcMain, {
      getAppContext: () => context,
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send },
      }) as BrowserWindow,
      dialogWindows,
    });
    const save = handlers.get('save-config');
    if (!save) throw new Error('save-config handler was not registered');

    await Promise.all([
      save({}, { audio: { inputMuted: true } }),
      save({}, { audio: { inputVolume: 0.4 } }),
    ]);

    expect(context.parsedConfig.audio).toEqual({
      ...initial.audio,
      inputMuted: true,
      inputVolume: 0.4,
    });
    expect(config.set).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('audio-config-changed', context.parsedConfig.audio);
    expect(dialogSend).toHaveBeenLastCalledWith('audio-config-changed', context.parsedConfig.audio);
  });

  it('compares every save with the immutable runtime boot LLM config', async () => {
    const initial = SarahConfigSchema.parse({});
    let stored: Record<string, object> = { ...initial };
    const context = {
      parsedConfig: initial,
      config: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (_key: string, value: Record<string, object>) => { stored = value; }),
      },
    } as unknown as AppContext;
    const { ipcMain, handlers } = fakeIpcMain();
    registerConfigHandlers(ipcMain, {
      getAppContext: () => context,
      getMainWindow: () => null,
      dialogWindows: new Map(),
    });
    const save = handlers.get('save-config');
    if (!save) throw new Error('save-config handler was not registered');

    const changed = await save({}, { llm: { ...initial.llm, routerModel: 'changed:latest' } });
    const unrelated = await save({}, { trust: { ...initial.trust, memoryAllowed: false } });
    const restored = await save({}, { llm: initial.llm });

    expect(changed).toMatchObject({ restartRequired: true, restartReasons: ['Router-Modell'] });
    expect(unrelated).toMatchObject({ restartRequired: true, restartReasons: ['Router-Modell'] });
    expect(restored).toMatchObject({ restartRequired: false, restartReasons: [] });
  });

  it('applies changed memory policy to the running router immediately', async () => {
    const initial = SarahConfigSchema.parse({});
    let stored: Record<string, object> = { ...initial };
    const router = { applyMemoryPolicy: vi.fn(async () => undefined) };
    const context = {
      parsedConfig: initial,
      registry: { get: vi.fn((id: string) => id === 'router' ? router : undefined) },
      config: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (_key: string, value: Record<string, object>) => { stored = value; }),
      },
    } as unknown as AppContext;
    const { ipcMain, handlers } = fakeIpcMain();
    registerConfigHandlers(ipcMain, {
      getAppContext: () => context,
      getMainWindow: () => null,
      dialogWindows: new Map(),
    });
    const save = handlers.get('save-config');
    if (!save) throw new Error('save-config handler was not registered');

    await save({}, {
      trust: { ...initial.trust, memoryAllowed: false, memoryExclusions: ['Finanzen'] },
    });

    expect(router.applyMemoryPolicy).toHaveBeenCalledWith({
      allowed: false,
      exclusions: ['Finanzen'],
    });
  });

  it.each([
    { memoryExclusions: Array.from({ length: MAX_MEMORY_EXCLUSIONS + 1 }, (_, index) => `topic-${index}`) },
    { memoryExclusions: ['x'.repeat(MAX_MEMORY_EXCLUSION_LENGTH + 1)] },
  ])('rejects oversized memory exclusions before persisting or applying them', async ({ memoryExclusions }) => {
    const initial = SarahConfigSchema.parse({});
    const router = { applyMemoryPolicy: vi.fn(async () => undefined) };
    const config = {
      get: vi.fn(async () => initial),
      set: vi.fn(async () => undefined),
    };
    const context = {
      parsedConfig: initial,
      registry: { get: vi.fn(() => router) },
      config,
    } as unknown as AppContext;
    const { ipcMain, handlers } = fakeIpcMain();
    registerConfigHandlers(ipcMain, {
      getAppContext: () => context,
      getMainWindow: () => null,
      dialogWindows: new Map(),
    });
    const save = handlers.get('save-config');
    if (!save) throw new Error('save-config handler was not registered');

    await expect(save({}, {
      trust: { ...initial.trust, memoryExclusions },
    })).rejects.toThrow();

    expect(config.set).not.toHaveBeenCalled();
    expect(router.applyMemoryPolicy).not.toHaveBeenCalled();
    expect(context.parsedConfig).toBe(initial);
  });

  it('retries an identical save after policy cleanup failed and reports success only after cleanup', async () => {
    const initial = SarahConfigSchema.parse({});
    let stored: Record<string, object> = { ...initial };
    let applyAttempts = 0;
    const router = { applyMemoryPolicy: vi.fn(async () => {
      applyAttempts += 1;
      if (applyAttempts === 1) {
        throw Object.assign(new Error('cleanup failed'), { code: 'MEMORY_POLICY_APPLY_FAILED' });
      }
    }) };
    const context = {
      parsedConfig: initial,
      registry: { get: vi.fn((id: string) => id === 'router' ? router : undefined) },
      config: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (_key: string, value: Record<string, object>) => { stored = value; }),
      },
    } as unknown as AppContext;
    const { ipcMain, handlers } = fakeIpcMain();
    registerConfigHandlers(ipcMain, {
      getAppContext: () => context,
      getMainWindow: () => null,
      dialogWindows: new Map(),
    });
    const save = handlers.get('save-config');
    if (!save) throw new Error('save-config handler was not registered');

    const patch = {
      trust: { ...initial.trust, memoryAllowed: false },
    };
    await expect(save({}, patch)).rejects.toMatchObject({ code: 'MEMORY_POLICY_APPLY_FAILED' });

    expect(context.parsedConfig.trust.memoryAllowed).toBe(false);
    expect((stored.trust as { memoryAllowed: boolean }).memoryAllowed).toBe(false);
    expect(router.applyMemoryPolicy).toHaveBeenCalledOnce();

    await expect(save({}, patch)).resolves.toMatchObject({
      config: { trust: { memoryAllowed: false } },
    });
    expect(router.applyMemoryPolicy).toHaveBeenCalledTimes(2);
    expect(router.applyMemoryPolicy).toHaveBeenLastCalledWith({
      allowed: false,
      exclusions: initial.trust.memoryExclusions,
    });
  });

  it('applies persisted voice config even when renderer notification fails', async () => {
    const initial = SarahConfigSchema.parse({});
    let stored: Record<string, object> = { ...initial };
    const voiceService = {
      setRendererCaptureReady: vi.fn(),
      applyConfig: vi.fn(async () => undefined),
    };
    const context = {
      parsedConfig: initial,
      registry: { get: vi.fn(() => voiceService) },
      config: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (_key: string, value: Record<string, object>) => { stored = value; }),
      },
    } as unknown as AppContext;
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn(() => { throw new Error('renderer gone'); }),
      },
    } as unknown as BrowserWindow;
    const { ipcMain, handlers } = fakeIpcMain();
    registerConfigHandlers(ipcMain, {
      getAppContext: () => context,
      getMainWindow: () => mainWindow,
      dialogWindows: new Map(),
    });
    const save = handlers.get('save-config');
    if (!save) throw new Error('save-config handler was not registered');

    await expect(save({}, {
      controls: { ...initial.controls, voiceMode: 'push-to-talk' },
    })).resolves.toMatchObject({
      config: { controls: { voiceMode: 'push-to-talk' } },
    });

    expect(context.config.set).toHaveBeenCalledOnce();
    expect(context.parsedConfig.controls.voiceMode).toBe('push-to-talk');
    expect(voiceService.setRendererCaptureReady).toHaveBeenCalledWith(false);
    expect(voiceService.applyConfig).toHaveBeenCalledOnce();
  });
});
