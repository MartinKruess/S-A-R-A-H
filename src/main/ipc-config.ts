import * as path from 'path';
import * as os from 'os';
import { app, BrowserWindow, dialog } from 'electron';
import type { IpcMain } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { SarahConfig } from '../core/config-schema.js';
import { VoiceService } from '../services/voice/voice-service.js';
import { getService } from './ipc-helpers.js';

export interface ConfigHandlerDeps {
  getAppContext: () => AppContext;
  getMainWindow: () => BrowserWindow | null;
  dialogWindows: Map<string, BrowserWindow>;
}

export function registerConfigHandlers(ipcMain: IpcMain, deps: ConfigHandlerDeps): void {
  const { getAppContext, getMainWindow, dialogWindows } = deps;

  ipcMain.handle('get-system-info', async () => {
    const cpus = os.cpus();
    const homedir = os.homedir();
    return {
      os: `${os.type()} ${os.release()}`,
      platform: process.platform,
      arch: os.arch(),
      cpu: cpus.length > 0 ? cpus[0].model : 'Unknown',
      cpuCores: String(cpus.length),
      totalMemory: `${Math.round(os.totalmem() / 1024 ** 3)} GB`,
      freeMemory: `${Math.round(os.freemem() / 1024 ** 3)} GB`,
      hostname: os.hostname(),
      shell: process.env.SHELL || process.env.COMSPEC || 'Unknown',
      language: app.getLocale(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      folders: {
        documents: path.join(homedir, 'Documents'),
        downloads: path.join(homedir, 'Downloads'),
        pictures: path.join(homedir, 'Pictures'),
        desktop: path.join(homedir, 'Desktop'),
      },
    };
  });

  ipcMain.handle('get-config', () => {
    return getAppContext().parsedConfig;
  });

  ipcMain.handle(
    'save-config',
    async (_event, config: Partial<SarahConfig>) => {
      const ctx = getAppContext();
      const existing = (await ctx.config.get<Record<string, unknown>>('root')) ?? {};
      const previousAudio = ctx.parsedConfig.audio;
      const merged = { ...existing, ...config };

      const { SarahConfigSchema } = await import('../core/config-schema.js');
      const parsed = SarahConfigSchema.parse(merged);

      await ctx.config.set('root', merged);
      ctx.parsedConfig = parsed;

      if ('controls' in config) {
        await getService<VoiceService>(ctx, 'voice').applyConfig();
      }

      if (JSON.stringify(previousAudio) !== JSON.stringify(parsed.audio)) {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('audio-config-changed', parsed.audio);
        }
      }

      return ctx.parsedConfig;
    },
  );

  ipcMain.handle('select-folder', async (event, title?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: title ?? 'Ordner auswählen',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('open-dialog', (_event, view: string) => {
    const existing = dialogWindows.get(view);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }

    const { screen } = require('electron');
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const w = Math.round(screenW * 0.8);
    const h = Math.round(screenH * 0.8);

    const dialogWin = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 720,
      minHeight: 520,
      backgroundColor: '#0a0a1a',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    dialogWin.center();
    dialogWin.loadFile(path.join(__dirname, '..', '..', 'dialog.html'), {
      query: { view },
    });

    dialogWindows.set(view, dialogWin);
    dialogWin.on('closed', () => {
      dialogWindows.delete(view);
    });
  });
}
