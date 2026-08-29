import * as path from 'path';
import * as os from 'os';
import { app, BrowserWindow, dialog, screen, shell } from 'electron';
import type { IpcMain } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { SarahConfigPatch } from '../core/config-schema.js';
import { isAudioConfigEqual, mergeSarahConfigPatch, SarahConfigSchema } from '../core/config-schema.js';
import { VoiceService } from '../services/voice/voice-service.js';
import { getService } from './ipc-helpers.js';
import { isValidOptionalTitle } from './ipc-validation.js';
import { getLlmRestartReasons, type SaveConfigResult } from '../core/config-apply.js';
import { removeReservedCustomCommandCollisions } from '../services/commands/builtin-commands.js';
import { sendToRendererSafely } from './forward-to-renderers.js';
import type { RouterService } from '../services/llm/router-service.js';
import { LEGACY_DB_RECOVERY_CONFIRMATION } from '../core/storage/storage.interface.js';
import { MemoryPolicyApplyError } from '../core/memory-policy.js';

export interface ConfigHandlerDeps {
  getAppContext: () => AppContext;
  getMainWindow: () => BrowserWindow | null;
  dialogWindows: Map<string, BrowserWindow>;
  onFolderSelected?: (folderPath: string, senderId: number) => void;
  onTrustChanged?: () => void;
}

export function registerConfigHandlers(ipcMain: IpcMain, deps: ConfigHandlerDeps): void {
  const { getAppContext, getMainWindow, dialogWindows } = deps;
  let saveQueue: Promise<void> = Promise.resolve();
  let memoryPolicyRecoveryRequired = false;
  // ModelRuntime is immutable for the lifetime of this process. Keep that
  // boot contract separate from the mutable persisted config snapshot.
  const bootLlm = structuredClone(getAppContext().parsedConfig.llm);

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

  ipcMain.handle('legacy-db-recovery-review', async () => {
    const recovery = getAppContext().db.reviewLegacyDbRecovery;
    if (!recovery) throw new Error('Legacy DB recovery is not supported');
    return recovery.call(getAppContext().db);
  });

  ipcMain.handle('legacy-db-recovery-restore', async (event, input: { quarantineIds?: number[] }) => {
    const quarantineIds = input?.quarantineIds;
    if (!Array.isArray(quarantineIds) || quarantineIds.length === 0 || quarantineIds.length > 10
      || quarantineIds.some((id) => !Number.isInteger(id) || id <= 0)
      || new Set(quarantineIds).size !== quarantineIds.length) {
      throw new Error('Invalid legacy DB recovery selection');
    }
    const ctx = getAppContext();
    if (!ctx.db.reviewLegacyDbRecovery || !ctx.db.restoreLegacyDbRecovery) {
      throw new Error('Legacy DB recovery is not supported');
    }
    const review = await ctx.db.reviewLegacyDbRecovery();
    const availableIds = new Set(review.candidates.map((candidate) => candidate.quarantineId));
    if (quarantineIds.some((id) => !availableIds.has(id))) {
      throw new Error('Legacy DB recovery selection changed after review');
    }
    const selectedCandidates = review.candidates.filter(
      (candidate) => quarantineIds.includes(candidate.quarantineId),
    );

    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    const choice = win
      ? await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Alte verschlüsselte Daten wiederherstellen?',
        message: `${quarantineIds.length} isolierte Altwerte wiederherstellen?`,
        detail: `${review.warning}\n\n${selectedCandidates.map((candidate) => (
          `${candidate.table} · Zeile ${candidate.rowId} · ${candidate.column}: „${candidate.preview}“`
        )).join('\n')}\n\nVor der Wiederherstellung wird automatisch eine vollständige Datenbank-Sicherung erstellt. Ohne deine Bestätigung bleiben die Werte isoliert und werden nicht von Sarah verwendet.`,
        buttons: ['Abbrechen', 'Geprüfte Altwerte wiederherstellen'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      : { response: 0 };
    if (choice.response !== 1) return null;
    return ctx.db.restoreLegacyDbRecovery(quarantineIds, LEGACY_DB_RECOVERY_CONFIRMATION);
  });

  ipcMain.handle(
    'save-config',
    (_event, config: SarahConfigPatch): Promise<SaveConfigResult> => {
      const operation = saveQueue.then(async () => {
        const ctx = getAppContext();
        const existing = (await ctx.config.get<Record<string, unknown>>('root')) ?? {};
        const previousAudio = ctx.parsedConfig.audio;
        const previousVoiceMode = ctx.parsedConfig.controls.voiceMode;
        const previousPushToTalkKey = ctx.parsedConfig.controls.pushToTalkKey;
        const previousTrust = ctx.parsedConfig.trust;
        let parsed = mergeSarahConfigPatch(ctx.parsedConfig, config);
        const customCommands = removeReservedCustomCommandCollisions(parsed.controls.customCommands);
        if (customCommands.length !== parsed.controls.customCommands.length) {
          parsed = {
            ...parsed,
            controls: { ...parsed.controls, customCommands },
          };
        }
        await ctx.config.set('root', parsed);
        ctx.parsedConfig = parsed;

        const memoryPolicyChanged = previousTrust.memoryAllowed !== parsed.trust.memoryAllowed
          || JSON.stringify(previousTrust.memoryExclusions) !== JSON.stringify(parsed.trust.memoryExclusions);
        const trustChanged = JSON.stringify(previousTrust) !== JSON.stringify(parsed.trust);
        if (memoryPolicyChanged || memoryPolicyRecoveryRequired) {
          const router = ctx.registry?.get('router') as RouterService | undefined;
          if (router) {
            memoryPolicyRecoveryRequired = true;
            try {
              await router.applyMemoryPolicy({
                allowed: parsed.trust.memoryAllowed,
                exclusions: parsed.trust.memoryExclusions,
              });
              memoryPolicyRecoveryRequired = false;
            } catch (error) {
              memoryPolicyRecoveryRequired = true;
              try {
                await ctx.config.set('root', existing);
                ctx.parsedConfig = SarahConfigSchema.parse(existing);
              } catch (rollbackError) {
                throw new MemoryPolicyApplyError(
                  `Memory policy failed and configuration rollback failed: ${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'}`,
                );
              }
              throw error;
            }
          } else if (memoryPolicyRecoveryRequired) {
            throw new MemoryPolicyApplyError('Memory policy cleanup retry requires the running router');
          }
        }
        if (trustChanged) {
          // A confirmation is valid only under the trust contract that created it.
          ctx.actionConfirmations.clear();
          deps.onTrustChanged?.();
        }

        const inputDeviceChanged = previousAudio.inputDeviceId !== parsed.audio.inputDeviceId;
        const voiceModeChanged = previousVoiceMode !== parsed.controls.voiceMode;
        const pushToTalkKeyChanged = previousPushToTalkKey !== parsed.controls.pushToTalkKey;
        const voiceConfigChanged = voiceModeChanged || pushToTalkKeyChanged;
        const voiceService = voiceConfigChanged || inputDeviceChanged
          ? getService<VoiceService>(ctx, 'voice')
          : null;
        if (voiceService && (voiceModeChanged || inputDeviceChanged)) {
          // Invalidate readiness synchronously in main before the renderer event
          // crosses the process boundary. Otherwise an off -> PTT switch has a
          // brief window in which the old readiness could register the hotkey.
          voiceService.setRendererCaptureReady(false);
        }
        if (voiceModeChanged) {
          // Renderer capture ownership should move before the main-process
          // hotkey is reconfigured. Delivery failure must not strand the
          // already-persisted config between disk and VoiceService, though.
          sendToRendererSafely(getMainWindow(), 'voice-input-config-changed', {
            voiceMode: parsed.controls.voiceMode,
          });
        }

        if (voiceConfigChanged && voiceService) {
          await voiceService.applyConfig();
        }

        if (!isAudioConfigEqual(previousAudio, parsed.audio)) {
          const recipients = new Set<BrowserWindow>();
          const mainWindow = getMainWindow();
          if (mainWindow) recipients.add(mainWindow);
          for (const dialogWindow of dialogWindows.values()) recipients.add(dialogWindow);
          for (const win of recipients) {
            sendToRendererSafely(win, 'audio-config-changed', parsed.audio);
          }
        }

        const restartReasons = getLlmRestartReasons(bootLlm, parsed.llm);
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
    const selectedFolder = result.filePaths[0];
    deps.onFolderSelected?.(selectedFolder, event.sender.id);
    return selectedFolder;
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
