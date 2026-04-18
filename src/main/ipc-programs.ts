import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import type { IpcMain } from 'electron';
import {
  classifyProgramPath,
  verifyProgramPath,
  generateAliases,
  markDuplicateGroups,
} from './program-utils.js';

export function registerProgramHandlers(ipcMain: IpcMain): void {
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
        // Cast needed: TS narrows `bestExe` to null across the closure boundary
        const picked = bestExe as { name: string; path: string; score: number } | null;
        if (picked && picked.score >= 50 && !seen.has(picked.name.toLowerCase())) {
          seen.add(picked.name.toLowerCase());
          results.push({ name: picked.name, path: picked.path });
        }
      }

      const mapped = results.map((p) => ({
        name: p.name,
        path: p.path,
        type: classifyProgramPath(p.path),
        source: 'detected' as const,
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
        source: 'detected' as const,
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
}
