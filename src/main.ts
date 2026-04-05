import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';

try {
  require('electron-reloader')(module);
} catch {}

let mainWindow: BrowserWindow | null = null;

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig(): Record<string, unknown> {
  try {
    const data = fs.readFileSync(getConfigPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    backgroundColor: '#0a0a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'splash.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.on('splash-done', () => {
    if (mainWindow) {
      mainWindow.maximize();
      const config = loadConfig();
      if (config.setupComplete) {
        mainWindow.loadFile(path.join(__dirname, '..', 'dashboard.html'));
      } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'wizard.html'));
      }
    }
  });

  ipcMain.handle('get-system-info', async () => {
    const cpus = os.cpus();
    const homedir = os.homedir();
    return {
      os: `${os.type()} ${os.release()}`,
      platform: process.platform,
      arch: os.arch(),
      cpu: cpus.length > 0 ? cpus[0].model : 'Unknown',
      cpuCores: String(cpus.length),
      totalMemory: `${Math.round(os.totalmem() / (1024 ** 3))} GB`,
      freeMemory: `${Math.round(os.freemem() / (1024 ** 3))} GB`,
      hostname: os.hostname(),
      shell: process.env.SHELL || process.env.COMSPEC || 'Unknown',
      language: app.getLocale(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      folders: JSON.stringify({
        documents: path.join(homedir, 'Documents'),
        downloads: path.join(homedir, 'Downloads'),
        pictures: path.join(homedir, 'Pictures'),
        desktop: path.join(homedir, 'Desktop'),
      }),
    };
  });

  ipcMain.handle('get-config', () => {
    return loadConfig();
  });

  ipcMain.handle('save-config', (_event, config: Record<string, unknown>) => {
    const existing = loadConfig();
    const merged = { ...existing, ...config };
    saveConfig(merged);
    return merged;
  });

  ipcMain.handle('is-first-run', () => {
    const config = loadConfig();
    return !config.setupComplete;
  });

  ipcMain.handle('select-folder', async (_event, title?: string) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title ?? 'Ordner auswählen',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('detect-programs', () => {
    try {
      const ps = [
        "Get-ItemProperty",
        "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
        "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
        "2>$null",
        "| Where-Object {",
        "$_.DisplayName -and",
        "$_.DisplayName -notmatch",
        "'(Update|Redistributable|SDK|Runtime|Pack|Driver|Microsoft \\.NET|Windows Kit|Visual C\\+\\+)'",
        "}",
        "| Select-Object -ExpandProperty DisplayName -Unique",
        "| Sort-Object",
      ].join(' ');
      const output = execSync(`powershell -NoProfile -Command "${ps}"`, {
        encoding: 'utf-8',
        timeout: 15000,
      });
      return output
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0);
    } catch {
      return [];
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
