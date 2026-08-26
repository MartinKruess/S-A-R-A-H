import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMain } from 'electron';
import type { AppContext } from '../../src/core/bootstrap.js';
import type { SarahConfigPatch } from '../../src/core/config-schema.js';
import { SarahConfigSchema } from '../../src/core/config-schema.js';
import { registerConfigHandlers } from '../../src/main/ipc-config.js';

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
});
