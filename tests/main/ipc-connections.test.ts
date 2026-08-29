import { describe, it, expect, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { registerConnectionHandlers } from '../../src/main/ipc-connections';
import type { OAuthConnectionService } from '../../src/services/integrations/oauth-connection-service';
import type { ConnectionInfo } from '../../src/services/integrations/oauth-connection-service';

type Handler = (event: unknown, arg: unknown) => unknown;

/** Minimal fake ipcMain that records the registered invoke-handlers. */
function fakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, listener: Handler) => {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

const CONNECTIONS: ConnectionInfo[] = [
  { id: 'spotify', displayName: 'Spotify', configured: true, connected: false },
];

describe('registerConnectionHandlers', () => {
  it('connections-list returns the service connection list', async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const oauth = {
      listConnections: vi.fn(() => CONNECTIONS),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as OAuthConnectionService;

    registerConnectionHandlers(ipcMain, { getOAuth: () => oauth });

    const result = await handlers.get('connections-list')!(null, undefined);
    expect(result).toEqual(CONNECTIONS);
  });

  it('connection-connect returns { ok: true } on success', async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const oauth = {
      connect: vi.fn(async () => undefined),
    } as unknown as OAuthConnectionService;

    registerConnectionHandlers(ipcMain, { getOAuth: () => oauth });

    const result = await handlers.get('connection-connect')!(null, 'spotify');
    expect(oauth.connect).toHaveBeenCalledWith('spotify');
    expect(result).toEqual({ ok: true });
  });

  it('connection-connect maps a thrown error to { ok: false, error } without crashing', async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const oauth = {
      connect: vi.fn(async () => {
        throw new Error('Port belegt');
      }),
    } as unknown as OAuthConnectionService;

    registerConnectionHandlers(ipcMain, { getOAuth: () => oauth });

    const result = await handlers.get('connection-connect')!(null, 'spotify');
    expect(result).toEqual({ ok: false, error: 'Port belegt' });
  });

  it('connection-disconnect delegates to the service', async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const oauth = {
      disconnect: vi.fn(async () => undefined),
    } as unknown as OAuthConnectionService;

    registerConnectionHandlers(ipcMain, { getOAuth: () => oauth });

    await handlers.get('connection-disconnect')!(null, 'spotify');
    expect(oauth.disconnect).toHaveBeenCalledWith('spotify');
  });
});
