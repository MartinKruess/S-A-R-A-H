import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { bootstrap, AppContext } from './core/bootstrap.js';
import { RouterService } from './services/llm/router-service.js';
import { OllamaProvider } from './services/llm/providers/ollama-provider.js';
import { PERFORMANCE_PROFILE_MAP } from './services/llm/llm-types.js';
import type { SarahConfig } from './core/config-schema.js';
import { VoiceService } from './services/voice/voice-service.js';

try {
  require('electron-reloader')(module);
} catch {}

let mainWindow: BrowserWindow | null = null;
let appContext: AppContext | null = null;
const dialogWindows = new Map<string, BrowserWindow>();

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
  libreoffice: ['LibreOffice'],
  openoffice: ['OpenOffice'],
  'notepad++': ['Notepad++', 'Notepad Plus'],
  'obs studio': ['OBS'],
  'vlc media player': ['VLC'],
  'davinci resolve': ['DaVinci', 'Resolve'],
  steam: ['Steam'],
  discord: ['Discord'],
  spotify: ['Spotify'],
  slack: ['Slack'],
  telegram: ['Telegram'],
  whatsapp: ['WhatsApp'],
  zoom: ['Zoom'],
  git: ['Git'],
  '7-zip': ['7-Zip', '7Zip'],
  winrar: ['WinRAR'],
  'sublime text': ['Sublime'],
  jetbrains: ['IntelliJ', 'WebStorm', 'PyCharm'],
  'opera gx': ['Opera'],
  brave: ['Brave'],
  blender: ['Blender'],
  gimp: ['GIMP'],
  audacity: ['Audacity'],
  filezilla: ['FileZilla'],
  postman: ['Postman'],
  docker: ['Docker'],
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
  const withoutVersion = displayName
    .replace(/\s+[\d(v][\d.()x ]*$/i, '')
    .trim();
  if (
    withoutVersion !== displayName &&
    withoutVersion.length > 1 &&
    !aliases.includes(withoutVersion)
  ) {
    aliases.push(withoutVersion);
  }

  return [...new Set(aliases)];
}

/** Patterns that indicate a launcher/updater instead of the real exe */
const UPDATER_PATTERNS = /[/\\](update|updater|auto-?update)\.exe$/i;
const LAUNCHER_PATTERNS = /[/\\](launcher|pdflauncher|.*launcher)\.exe$/i;

function classifyProgramPath(
  programPath: string,
): 'exe' | 'launcher' | 'appx' | 'updater' {
  if (!programPath) return 'exe';
  if (programPath.startsWith('appx:')) return 'appx';
  if (UPDATER_PATTERNS.test(programPath)) return 'updater';
  if (LAUNCHER_PATTERNS.test(programPath)) return 'launcher';
  return 'exe';
}

function verifyProgramPath(programPath: string): boolean {
  if (!programPath) return false;
  try {
    return fs.existsSync(programPath);
  } catch {
    return false;
  }
}

/**
 * Find programs that share overlapping aliases and mark them with a duplicateGroup.
 * e.g. "OpenOffice Calc", "OpenOffice Writer", "OpenOffice Base" → group "OpenOffice"
 */
function markDuplicateGroups(
  programs: {
    name: string;
    path: string;
    type: string;
    verified: boolean;
    aliases: string[];
    duplicateGroup?: string;
  }[],
): void {
  // Group by longest shared alias
  const aliasOwners = new Map<string, string[]>();
  for (const prog of programs) {
    for (const alias of prog.aliases) {
      const lower = alias.toLowerCase();
      if (!aliasOwners.has(lower)) aliasOwners.set(lower, []);
      aliasOwners.get(lower)!.push(prog.name);
    }
  }

  // Aliases shared by 2+ programs → mark those programs
  for (const [alias, owners] of aliasOwners) {
    if (owners.length >= 2) {
      for (const prog of programs) {
        if (owners.includes(prog.name)) {
          prog.duplicateGroup = alias;
        }
      }
    }
  }
}

app.whenReady().then(async () => {
  createWindow();
  appContext = await bootstrap(app.getPath('userData'));

  // Show dialog if config validation failed
  if (appContext.configErrors) {
    const issues = appContext.configErrors.map((e) => `• ${e}`).join('\n');
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Konfigurationsfehler',
      message: 'Die Konfigurationsdatei enthält ungültige Werte:',
      detail: `${issues}\n\nMit Standard-Werten fortfahren?`,
      buttons: ['Mit Defaults fortfahren', 'Beenden'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) {
      app.quit();
      return;
    }
  }

  // --- Preload: create providers (fast, no activation) ---
  const { llm: llmConfig } = appContext.parsedConfig;
  const routerProvider = new OllamaProvider(llmConfig.baseUrl, llmConfig.routerModel, { ...llmConfig.options, num_ctx: 2048 });
  const numGpu = PERFORMANCE_PROFILE_MAP[llmConfig.performanceProfile] ?? PERFORMANCE_PROFILE_MAP.normal;
  const workerOptions = {
    ...llmConfig.options,
    num_ctx: llmConfig.workerOptions.num_ctx,
    num_gpu: numGpu,
  };
  const workerProvider = new OllamaProvider(llmConfig.baseUrl, llmConfig.workerModel, workerOptions);
  const routerService = new RouterService(appContext, routerProvider, workerProvider);
  appContext.registry.register(routerService);

  const { AudioManager } = await import('./services/voice/audio-manager.js');
  const { HotkeyManager } = await import('./services/voice/hotkey-manager.js');
  const { FasterWhisperProvider } = await import('./services/voice/providers/faster-whisper-provider.js');
  const { PiperProvider } = await import('./services/voice/providers/piper-provider.js');
  const { PorcupineProvider } = await import('./services/voice/providers/porcupine-provider.js');

  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', 'resources');
  const picovoiceKey = process.env.PICOVOICE_ACCESS_KEY ?? '';
  const whisperProvider = new FasterWhisperProvider(resourcesPath);
  const piperProvider = new PiperProvider(resourcesPath);
  const porcupineProvider = new PorcupineProvider(resourcesPath, picovoiceKey);
  const audioManager = new AudioManager();
  const hotkeyManager = new HotkeyManager();

  const voiceService = new VoiceService(
    appContext,
    whisperProvider,
    piperProvider,
    porcupineProvider,
    audioManager,
    hotkeyManager,
  );
  appContext.registry.register(voiceService);

  // --- Start heavy inits immediately (parallel to Phase 1) ---
  let whisperDone = false;
  let whisperError = false;
  let routerDone = false;
  let routerError = false;

  const send = (step: string, message?: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('boot-status', { step, message });
    }
  };

  // Fire-and-forget: Whisper init
  whisperProvider.init()
    .then(() => { whisperDone = true; })
    .catch((err) => {
      console.error('[Boot] Whisper init failed:', err);
      whisperDone = true;
      whisperError = true;
    });

  // Fire-and-forget: Router init
  routerService.init()
    .then(() => { routerDone = true; })
    .catch((err) => {
      console.error('[Boot] Router init failed:', err);
      routerDone = true;
      routerError = true;
    });

  ipcMain.once('boot-ready', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    try {
      // Step 1: Whisper — show status, wait if still loading
      send('whisper', 'Spracherkennung wird aktiviert ...');
      if (!whisperDone) {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (whisperDone) { clearInterval(check); resolve(); }
          }, 50);
        });
      }

      // Step 2: Router — show status, wait if still loading
      send('router', 'Sarah Protokoll wird initialisiert ...');
      if (!routerDone) {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (routerDone) { clearInterval(check); resolve(); }
          }, 50);
        });
      }

      // Signal router ready — renderer starts orb reveal (even if router errored)
      send('router-ready');

      // Wait for reveal animation to finish (renderer sends reveal-done IPC)
      await new Promise<void>((resolve) => {
        ipcMain.once('reveal-done', () => resolve());
        setTimeout(resolve, 8000); // Fallback
      });

      send('piper', 'Sprachprotokolle werden geladen ...');
      // Piper init is near-instant (file checks only), so add minimum display time
      await Promise.all([
        piperProvider.init().catch((err) => {
          console.error('[Boot] Piper init failed:', err);
        }),
        new Promise((r) => setTimeout(r, 1000)),
      ]);

      // Signal piper ready — renderer starts break + TTS
      send('piper-ready');

      // Wire up remaining service plumbing (TtsQueue, hotkeys, subscriptions, status)
      // Provider inits are idempotent, so double-calling is safe
      await appContext!.registry.initAll().catch((err) => {
        console.error('[Boot] Service wiring failed:', err);
      });
    } catch (err) {
      console.error('[Boot] Activation failed:', err);
      send('piper-ready');
      await appContext!.registry.initAll().catch(() => {});
    }
  });

  // Splash TTS handler (uses Piper directly, VoiceService not wired yet)
  ipcMain.handle('splash-tts', async (_event, text: string) => {
    try {
      const audio = await piperProvider.speak(text);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voice:play-audio', {
          audio: Array.from(audio),
          sampleRate: 22050,
        });
      }
    } catch (err) {
      console.error('[Boot] Splash TTS failed:', err);
    }
  });

  ipcMain.on('splash-done', async () => {
    if (mainWindow) {
      if (appContext!.parsedConfig.onboarding.setupComplete) {
        // Dashboard: compact window (25vh x 30vh), both relative to screen height
        const { height: screenH } =
          require('electron').screen.getPrimaryDisplay().workAreaSize;
        mainWindow.setSize(
          Math.round(screenH * 0.3),
          Math.round(screenH * 0.33),
        );
        mainWindow.setPosition(0, 0);
        mainWindow.loadFile(path.join(__dirname, '..', 'dashboard.html'));
      } else {
        // Wizard: fullscreen
        mainWindow.maximize();
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
    return appContext!.parsedConfig;
  });

  ipcMain.handle(
    'save-config',
    async (_event, config: Partial<SarahConfig>) => {
      const existing = (await appContext!.config.get<Record<string, unknown>>('root')) ?? {};
      const merged = { ...existing, ...config };
      await appContext!.config.set('root', merged);

      // Re-parse merged config
      const { SarahConfigSchema } = await import('./core/config-schema.js');
      appContext!.parsedConfig = SarahConfigSchema.parse(merged);

      // Apply voice config changes live when controls section is saved
      if ('controls' in config) {
        const voiceService = appContext!.registry.get('voice');
        if (voiceService && voiceService instanceof VoiceService) {
          await voiceService.applyConfig();
        }
      }

      return appContext!.parsedConfig;
    },
  );

  ipcMain.handle('is-first-run', () => {
    return !appContext!.parsedConfig.onboarding.setupComplete;
  });

  ipcMain.handle('select-folder', async (event, title?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
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
      backgroundColor: '#0a0a1a',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    dialogWin.center();
    dialogWin.loadFile(path.join(__dirname, '..', 'dialog.html'), {
      query: { view },
    });

    dialogWindows.set(view, dialogWin);
    dialogWin.on('closed', () => {
      dialogWindows.delete(view);
    });
  });

  ipcMain.handle('chat-message', async (_event, text: string) => {
    const voiceService = appContext!.registry.get('voice') as VoiceService | undefined;
    if (voiceService && voiceService.voiceState === 'idle' && voiceService.status === 'running') {
      voiceService.setInteractionMode('chatspeak');
    }
    appContext!.bus.emit('renderer', 'chat:message', { text, mode: 'chat' });
  });

  // Forward LLM events to all renderer windows
  const forwardToRenderers = <T extends import('./core/bus-events.js').BusTopic>(topic: T) => {
    appContext!.bus.on(topic, (msg) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(topic, msg.data);
        }
      }
    });
  };

  forwardToRenderers('llm:chunk');
  forwardToRenderers('llm:done');
  forwardToRenderers('llm:error');

  // ── Performance timing collector ──
  let perfStart = 0;
  let perfData: Record<string, unknown> = {};

  appContext!.bus.on('perf:timing', (msg) => {
    const { label, ms, meta } = msg.data;
    if (!perfStart) perfStart = Date.now();
    perfData[`${label}Ms`] = ms;
    if (meta) Object.assign(perfData, meta);
    if (label === 'router') perfData.usedWorker = false;
    if (label === 'worker') perfData.usedWorker = true;
  });

  const logPerf = () => {
    if (!perfStart) return;
    const msKeys = Object.keys(perfData).filter(k => k.endsWith('Ms'));
    const totalMs = msKeys.reduce((sum, k) => sum + (perfData[k] as number), 0);
    console.log('\n[⏱ Performance]', JSON.stringify({ totalMs, ...perfData }, null, 2));
    perfStart = 0;
    perfData = {};
  };

  appContext!.bus.on('voice:done', logPerf);
  // Chat-only mode (no voice) — log on llm:done if no whisper was involved
  appContext!.bus.on('llm:done', () => {
    if (!perfData.whisperMs) logPerf();
  });

  // Voice IPC handlers
  ipcMain.handle('voice-get-state', () => {
    const voiceService = appContext?.registry.get('voice');
    if (!voiceService || !(voiceService instanceof VoiceService)) return 'idle';
    return voiceService.voiceState;
  });

  ipcMain.handle('voice-playback-done', () => {
    appContext!.bus.emit('renderer', 'voice:playback-done', {});
  });

  ipcMain.handle('voice-audio-chunk', (_event, chunk: number[]) => {
    const voiceService = appContext?.registry.get('voice');
    if (voiceService && voiceService instanceof VoiceService) {
      voiceService.feedAudioChunk(new Float32Array(chunk));
    }
  });

  ipcMain.handle('voice-set-interaction-mode', (_event, mode: string) => {
    const voiceService = appContext?.registry.get('voice');
    if (voiceService && voiceService instanceof VoiceService) {
      voiceService.setInteractionMode(mode as 'chat' | 'voice');
    }
  });

  ipcMain.handle('voice-config-changed', async () => {
    const voiceService = appContext?.registry.get('voice');
    if (voiceService && voiceService instanceof VoiceService) {
      await voiceService.applyConfig();
    }
  });

  // Forward voice events to renderers
  forwardToRenderers('voice:state');
  forwardToRenderers('voice:listening');
  forwardToRenderers('voice:transcript');
  forwardToRenderers('voice:speaking');
  forwardToRenderers('voice:done');
  forwardToRenderers('voice:error');
  forwardToRenderers('voice:interrupted');
  forwardToRenderers('voice:wake');
  forwardToRenderers('voice:play-audio');

  ipcMain.handle('scan-folder-exes', (_event, folderPath: string) => {
    try {
      if (!folderPath || !fs.existsSync(folderPath)) return [];
      const results: { name: string; path: string }[] = [];
      const seen = new Set<string>();

      // Strategy: scan top-level subdirectories, pick the "main" exe per folder
      // (the one whose name matches the folder name, or the largest exe)
      let topEntries: fs.Dirent[];
      try {
        topEntries = fs.readdirSync(folderPath, { withFileTypes: true });
      } catch {
        return [];
      }

      for (const entry of topEntries) {
        const full = path.join(folderPath, entry.name);

        if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
          // Direct exe in the scanned folder
          const lower = entry.name.toLowerCase();
          if (
            lower.match(
              /(unins|setup|install|update|crash|helper|redis|vc_red|dxsetup|dotnet)/i,
            )
          )
            continue;
          const baseName = entry.name.replace(/\.exe$/i, '');
          if (!seen.has(lower)) {
            seen.add(lower);
            results.push({ name: baseName, path: full });
          }
          continue;
        }

        if (!entry.isDirectory()) continue;

        // For each subfolder, find the "best" exe
        const folderName = entry.name.toLowerCase();
        let bestExe: { name: string; path: string; score: number } | null =
          null;

        function findExes(dir: string, depth: number): void {
          if (depth > 2) return;
          let children: fs.Dirent[];
          try {
            children = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const child of children) {
            const childPath = path.join(dir, child.name);
            if (child.isDirectory() && depth < 2) {
              findExes(childPath, depth + 1);
            } else if (
              child.isFile() &&
              child.name.toLowerCase().endsWith('.exe')
            ) {
              const exeLower = child.name.toLowerCase().replace(/\.exe$/, '');
              if (
                exeLower.match(
                  /(unins|setup|install|update|crash|helper|redis|vc_red|dxsetup|dotnet|web[vw]iew|cef|_)/,
                )
              )
                continue;
              // Score: prefer exe name matching folder name
              const normExe = exeLower.replace(/[\s\-.]/g, '');
              const normFolder = folderName.replace(/[\s\-.]/g, '');
              let score = 0;
              if (normExe === normFolder) score = 100;
              else if (
                normFolder.includes(normExe) ||
                normExe.includes(normFolder)
              )
                score = 50;
              else score = 0;
              if (!bestExe || score > bestExe.score) {
                bestExe = {
                  name: child.name.replace(/\.exe$/i, ''),
                  path: childPath,
                  score,
                };
              }
            }
          }
        }

        findExes(full, 0);
        // Only accept if the exe name relates to the folder name
        if (
          bestExe &&
          (bestExe as any).score >= 50 &&
          !seen.has((bestExe as any).name.toLowerCase())
        ) {
          seen.add((bestExe as any).name.toLowerCase());
          results.push({
            name: (bestExe as any).name,
            path: (bestExe as any).path,
          });
        }
      }

      const mapped = results.map((p) => ({
        name: p.name,
        path: p.path,
        type: classifyProgramPath(p.path),
        verified: verifyProgramPath(p.path),
        aliases: generateAliases(p.name),
        duplicateGroup: undefined as string | undefined,
      }));
      markDuplicateGroups(mapped);
      return mapped;
    } catch {
      return [];
    }
  });

  ipcMain.handle('detect-programs', () => {
    try {
      const script = [
        '# Shared noise filter',
        'function Test-Noise($name) {',
        "  if ($name -match '(Uninstall|Deinstall|Help|Hilfe|Readme|Release Note|License|Documentation|Diagnos|Installer|Setup|Updater|AutoUpdate|Crash|Reporter|Migration|Repair|Proxy|entfernen|Website|FAQs|User Guide|Getting Started|Support Center|Manuals|Module Docs|Samples|im Internet|Private Brows|reset prefer|skinned|Cert Kit|Immersive Control)') { return $true }",
        "  if ($name -match '(Application Verifier|Developer |IDLE \\(|iSCSI|ODBC|Math Input|SDK Shell|SDK$|Windows Fax|Windows PowerShell|Windows Software|Windows Media|Windows App|Fairlight|Control Panel|Blackmagic RAW|Blackmagic Proxy|DaVinci Control|Neu in dieser)') { return $true }",
        "  if ($name -match '(^Magnify|^Narrator|^On-Screen Keyboard|^Steps Recorder|^Windows Speech|^Internet Explorer|Quick Assist|Remote Desktop|^WordPad|^Character Map|^XPS Viewer|^Administrative|^RecoveryDrive|^Speech Recognition|^Task Manager|^System Configuration|^System Information|^Registry Editor|^Resource Monitor|^Disk Cleanup|^Snipping Tool|^dfrgui|^Paint$|MDN Web)') { return $true }",
        "  if ($name -match '(^Notepad$|^Command Prompt|^Git (Bash|CMD|GUI)|^Filme|^Medien-|^Solitaire|Native Tools|Cross Tools)') { return $true }",
        '  return $false',
        '}',
        '',
        '# Phase 1: .lnk shortcuts',
        '$shell = New-Object -ComObject WScript.Shell',
        '$seenExe = @{}',
        '$results = @{}',
        "$userPath = [Environment]::GetFolderPath('StartMenu') + '\\Programs'",
        "$commonPath = [Environment]::GetFolderPath('CommonStartMenu') + '\\Programs'",
        "$userLnks = Get-ChildItem -Path $userPath -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue",
        "$commonLnks = Get-ChildItem -Path $commonPath -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue",
        '$allLnks = @($userLnks) + @($commonLnks)',
        'foreach ($file in $allLnks) {',
        '  if ($null -eq $file) { continue }',
        '  if (Test-Noise $file.BaseName) { continue }',
        '  try {',
        '    $lnk = $shell.CreateShortcut($file.FullName)',
        '    $target = $lnk.TargetPath',
        "    if ($target -and $target -match '\\.exe$' -and -not $seenExe[$target]) {",
        '      $seenExe[$target] = $true',
        '      $results[$file.BaseName] = $target',
        '    }',
        '  } catch {}',
        '}',
        '',
        '# Phase 2: Get-StartApps (Store/UWP apps like Spotify)',
        'try {',
        '  Get-StartApps 2>$null | ForEach-Object {',
        '    $name = $_.Name',
        '    $appId = $_.AppID',
        '    if (-not $name -or $name.Length -gt 50) { return }',
        '    if (Test-Noise $name) { return }',
        "    if ($name -match '(Settings|Store|Cortana|Microsoft Store|Tools for)') { return }",
        "    if ($appId -match '^(Microsoft\\.(Windows|Xbox|Bing|GetHelp|People|Tips|Maps|Messaging|MixedReality|3D|Print|Wallet|549981|ScreenSketch|MSPaint|YourPhone|MicrosoftEdge)|windows\\.|ms-resource:)') { return }",
        "    if ($name -match '^(Bildschirm|Aufgaben|Computer|Datentr|Dienste|Druckv|Editor|Eingabe|Ereignis|Komponenten|Kurznotizen|Laufwerke|Leistungs|Lokale Sicher|Registrier|Ressource|Schritt|Sprachausgabe|System|Task-Manager|Wiederherstell|Windows-|Zeichentabelle|Tipps|3D-Viewer)') { return }",
        '    if (-not $results.ContainsKey($name)) {',
        '      $results[$name] = "appx:$appId"',
        '    }',
        '  }',
        '} catch {}',
        '',
        '# Output sorted',
        'foreach ($entry in $results.GetEnumerator() | Sort-Object Key) {',
        '  "$($entry.Key)\t$($entry.Value)"',
        '}',
      ].join('\n');
      const result = spawnSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {
          encoding: 'utf-8',
          timeout: 20000,
        },
      );
      if (result.status !== 0 || !result.stdout) return [];

      const raw = result.stdout
        .split('\n')
        .map((line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return null;
          const tabIdx = trimmed.indexOf('\t');
          if (tabIdx === -1) return null;
          return {
            name: trimmed.substring(0, tabIdx),
            path: trimmed.substring(tabIdx + 1),
          };
        })
        .filter(
          (p): p is { name: string; path: string } =>
            p !== null && p.name.length > 0,
        );

      const mapped = raw.map((p) => ({
        name: p.name,
        path: p.path,
        type: classifyProgramPath(p.path),
        verified: p.path.startsWith('appx:') ? true : verifyProgramPath(p.path),
        aliases: generateAliases(p.name),
        duplicateGroup: undefined as string | undefined,
      }));
      markDuplicateGroups(mapped);
      return mapped;
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

app.on('window-all-closed', async () => {
  if (appContext) {
    await appContext.shutdown();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
