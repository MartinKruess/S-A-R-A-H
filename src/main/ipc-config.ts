import * as path from 'path';
import * as os from 'os';
import { app, BrowserWindow, dialog, screen, shell } from 'electron';
import type { IpcMain } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { SarahConfigPatch } from '../core/config-schema.js';
import { isAudioConfigEqual } from '../core/config-schema.js';
import { VoiceService } from '../services/voice/voice-service.js';
import { getService } from './ipc-helpers.js';
import { isValidOptionalTitle } from './ipc-validation.js';
import { getLlmRestartReasons, type SaveConfigResult } from '../core/config-apply.js';

export interface ConfigHandlerDeps {
  getAppContext: () => AppContext;
  getMainWindow: () => BrowserWindow | null;
  dialogWindows: Map<string, BrowserWindow>;
}

export function registerConfigHandlers(ipcMain: IpcMain, deps: ConfigHandlerDeps): void {
  const { getAppContext, getMainWindow, dialogWindows } = deps;
  let saveQueue: Promise<void> = Promise.resolve();

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
    (_event, config: SarahConfigPatch): Promise<SaveConfigResult> => {
      const operation = saveQueue.then(async () => {
        const ctx = getAppContext();
        const existing = (await ctx.config.get<Record<string, unknown>>('root')) ?? {};
        const previousAudio = ctx.parsedConfig.audio;
        const previousVoiceMode = ctx.parsedConfig.controls.voiceMode;
        const previousLlm = ctx.parsedConfig.llm;
        const merged = {
          ...existing,
          ...config,
          ...(
            config.audio
              ? { audio: { ...ctx.parsedConfig.audio, ...config.audio } }
              : {}
          ),
        };

        const { SarahConfigSchema } = await import('../core/config-schema.js');
        const parsed = SarahConfigSchema.parse(merged);

        await ctx.config.set('root', merged);
        ctx.parsedConfig = parsed;

        const inputDeviceChanged = previousAudio.inputDeviceId !== parsed.audio.inputDeviceId;
        const voiceModeChanged = previousVoiceMode !== parsed.controls.voiceMode;
        const voiceService = 'controls' in config || inputDeviceChanged
          ? getService<VoiceService>(ctx, 'voice')
          : null;
        if (voiceService && (voiceModeChanged || inputDeviceChanged)) {
          // Invalidate readiness synchronously in main before the renderer event
          // crosses the process boundary. Otherwise an off -> PTT switch has a
          // brief window in which the old readiness could register the hotkey.
          voiceService.setRendererCaptureReady(false);
        }
        if (voiceModeChanged) {
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            // Renderer capture ownership must move before the main-process hotkey
            // is reconfigured. This prevents a newly-enabled PTT key from
            // accepting input while the microphone graph is still cold.
            win.webContents.send('voice-input-config-changed', {
              voiceMode: parsed.controls.voiceMode,
            });
          }
        }

        if ('controls' in config && voiceService) {
          await voiceService.applyConfig();
        }

        if (!isAudioConfigEqual(previousAudio, parsed.audio)) {
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('audio-config-changed', parsed.audio);
          }
        }

        const restartReasons = getLlmRestartReasons(previousLlm, parsed.llm);
        return {
          config: ctx.parsedConfig,
          restartRequired: restartReasons.length > 0,
          restartReasons,
        };
      });
      saveQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
  );

  ipcMain.handle('select-folder', async (event, title?: string) => {
    if (!isValidOptionalTitle(title)) {
      console.warn('[IPC] invalid payload for select-folder');
      return null;
    }
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
    if (typeof view !== 'string' || view.length === 0 || view.length > 50) {
      console.warn('[IPC] invalid payload for open-dialog');
      return;
    }
    const existing = dialogWindows.get(view);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }

    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const w = Math.round(screenW * 0.8);
    const h = Math.round(screenH * 0.8);

    const dialogWin = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 720,
      minHeight: 520,
      backgroundColor: '#05070d',
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

  ipcMain.handle('open-external-url', async (_event, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('Only https URLs are allowed');
    }
    await shell.openExternal(parsed.toString());
  });
}
