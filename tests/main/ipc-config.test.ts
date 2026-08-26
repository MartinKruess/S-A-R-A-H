import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
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
    registerConfigHandlers(ipcMain, {
      getAppContext: () => context,
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { send },
      }) as never,
      dialogWindows: new Map(),
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
  });
});
