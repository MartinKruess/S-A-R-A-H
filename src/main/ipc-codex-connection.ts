import type { IpcMain } from 'electron';
import { CodexConnectionStateSchema, CodexLoginInputSchema, type CodexConnectionState } from '../core/codex-connection.js';
import type { CodexConnectionService } from './codex-connection-service.js';
/** Validates managed-login IPC without exposing account credentials. */
export function registerCodexConnectionHandlers(ipcMain: IpcMain, service: CodexConnectionService): void {
  const failure: CodexConnectionState = {state:'unavailable', message:'Codex-Anmeldung konnte nicht sicher ausgeführt werden.'};
  const safe = async (operation:()=>Promise<CodexConnectionState>) => {
    try { return CodexConnectionStateSchema.parse(await operation()); } catch { return failure; }
  };
  ipcMain.handle('codex-connection-start', (_event, input: unknown) => {
    const parsed = CodexLoginInputSchema.safeParse(input);
    return parsed.success ? safe(()=>service.start(parsed.data)) : failure;
  });
  ipcMain.handle('codex-connection-status', () => safe(()=>service.status()));
  ipcMain.handle('codex-connection-logout', () => safe(()=>service.logout()));
}
