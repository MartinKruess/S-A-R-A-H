import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppContext } from '../../src/core/bootstrap.js';
import { MessageBus } from '../../src/core/message-bus.js';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

const { registerVoiceHandlers } = await import('../../src/main/ipc-voice.js');

type Handler = (event: object, input: object) => void;

function fakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: vi.fn(),
    } as unknown as IpcMain,
  };
}

describe('voice-audio-chunk IPC', () => {
  it('forwards level telemetry only for chunks accepted by the active capture', () => {
    const feedAudioChunk = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const bus = new MessageBus();
    const context = {
      bus,
      registry: {
        get: () => ({ feedAudioChunk }),
      },
    } as unknown as AppContext;
    const onChunk = vi.fn();
    const { ipcMain, handlers } = fakeIpcMain();
    const unregister = registerVoiceHandlers(ipcMain, {
      getAppContext: () => context,
      onChunk,
    });
    const handler = handlers.get('voice-audio-chunk');
    if (!handler) throw new Error('voice-audio-chunk handler was not registered');
    const captureId = '11111111-1111-4111-8111-111111111111';

    handler({}, { captureId, chunk: [0.1] });
    handler({}, { captureId, chunk: [0.2] });

    expect(feedAudioChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk).toHaveBeenCalledWith(captureId, expect.any(Float32Array));
    unregister();
  });
});
