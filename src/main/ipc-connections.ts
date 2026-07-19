// src/main/ipc-connections.ts
// IPC handlers for the generic "Integrationen" connection layer. Mirrors the
// shape of ipc-config.ts and delegates to the OAuthConnectionService (Main).

import type { IpcMain } from 'electron';
import type { OAuthConnectionService } from '../services/integrations/oauth-connection-service.js';

export interface ConnectionHandlerDeps {
  getOAuth: () => OAuthConnectionService;
}

export function registerConnectionHandlers(ipcMain: IpcMain, deps: ConnectionHandlerDeps): void {
  const { getOAuth } = deps;

  ipcMain.handle('connections-list', () => {
    return getOAuth().listConnections();
  });

  ipcMain.handle('connection-connect', async (_event, providerId: string) => {
    try {
      await getOAuth().connect(providerId);
      return { ok: true };
    } catch (err) {
      // Never crash the handler — surface the error text to the renderer instead.
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('connection-disconnect', async (_event, providerId: string) => {
    await getOAuth().disconnect(providerId);
  });
}
