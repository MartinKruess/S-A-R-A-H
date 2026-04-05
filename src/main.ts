import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawnSync } from 'child_process';

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

const KNOWN_ALIASES: Record<string, string[]> = {
  'visual studio code': ['VS Code', 'Code', 'VSCode'],
  'google chrome': ['Chrome'],
  'mozilla firefox': ['Firefox'],
  'microsoft word': ['Word'],
  'microsoft excel': ['Excel'],
  'microsoft outlook': ['Outlook'],
  'microsoft powerpoint': ['PowerPoint'],
  'microsoft onenote': ['OneNote'],
  'microsoft teams': ['Teams'],
  'adobe photoshop': ['Photoshop'],
  'adobe illustrator': ['Illustrator'],
  'adobe premiere pro': ['Premiere'],
  'adobe after effects': ['After Effects'],
  'adobe lightroom': ['Lightroom'],
  'adobe acrobat': ['Acrobat'],
  'libreoffice': ['LibreOffice'],
  'openoffice': ['OpenOffice'],
  'notepad++': ['Notepad++', 'Notepad Plus'],
  'obs studio': ['OBS'],
  'vlc media player': ['VLC'],
  'steam': ['Steam'],
  'discord': ['Discord'],
  'spotify': ['Spotify'],
  'slack': ['Slack'],
  'telegram': ['Telegram'],
  'whatsapp': ['WhatsApp'],
  'zoom': ['Zoom'],
  'git': ['Git'],
  '7-zip': ['7-Zip', '7Zip'],
  'winrar': ['WinRAR'],
  'sublime text': ['Sublime'],
  'jetbrains': ['IntelliJ', 'WebStorm', 'PyCharm'],
};

function generateAliases(displayName: string): string[] {
  const lower = displayName.toLowerCase();
  const aliases: string[] = [];

  for (const [key, knownAliases] of Object.entries(KNOWN_ALIASES)) {
    if (lower.includes(key)) {
      aliases.push(...knownAliases);
    }
  }

  // Strip version numbers: "7-Zip 23.01 (x64)" → "7-Zip"
  const withoutVersion = displayName.replace(/\s+[\d(v][\d.()x ]*$/i, '').trim();
  if (withoutVersion !== displayName && withoutVersion.length > 1 && !aliases.includes(withoutVersion)) {
    aliases.push(withoutVersion);
  }

  return [...new Set(aliases)];
}

function verifyProgramPath(programPath: string): boolean {
  if (!programPath) return false;
  try {
    return fs.existsSync(programPath);
  } catch {
    return false;
  }
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
      // Scan Start Menu .lnk shortcuts — only returns launchable .exe programs
      const script = [
        "$userPath = [Environment]::GetFolderPath('StartMenu') + '\\Programs'",
        "$commonPath = [Environment]::GetFolderPath('CommonStartMenu') + '\\Programs'",
        "$shell = New-Object -ComObject WScript.Shell",
        "$seen = @{}",
        "$userLnks = Get-ChildItem -Path $userPath -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue",
        "$commonLnks = Get-ChildItem -Path $commonPath -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue",
        "$allLnks = @($userLnks) + @($commonLnks)",
        "foreach ($file in $allLnks) {",
        "  if ($null -eq $file) { continue }",
        "  if ($file.Name -match '(Uninstall|Deinstall|Help|Hilfe|Readme|Release|License|Documentation|Diagnos)') { continue }",
        "  if ($file.BaseName -match '^(Magnify|Narrator|On-Screen Keyboard|Steps Recorder|Windows Speech|Internet Explorer|Quick Assist|Remote Desktop Connection|WordPad|Character Map|Math Input|XPS Viewer)$') { continue }",
        "  try {",
        "    $lnk = $shell.CreateShortcut($file.FullName)",
        "    $target = $lnk.TargetPath",
        "    if ($target -and $target -match '\\.exe$' -and -not $seen[$target]) {",
        "      $seen[$target] = $true",
        "      \"$($file.BaseName)\t$target\"",
        "    }",
        "  } catch {}",
        "}",
      ].join('\n');
      const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf-8',
        timeout: 15000,
      });
      if (result.status !== 0 || !result.stdout) return [];

      const raw = result.stdout
        .split('\n')
        .map((line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return null;
          const tabIdx = trimmed.indexOf('\t');
          if (tabIdx === -1) return null;
          return { name: trimmed.substring(0, tabIdx), path: trimmed.substring(tabIdx + 1) };
        })
        .filter((p): p is { name: string; path: string } => p !== null && p.name.length > 0);

      return raw.map(p => ({
        name: p.name,
        path: p.path,
        verified: verifyProgramPath(p.path),
        aliases: generateAliases(p.name),
      }));
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
