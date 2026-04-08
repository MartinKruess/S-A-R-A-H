const { spawnSync } = require('child_process');

const script = [
  "# Shared noise filter",
  "function Test-Noise($name) {",
  "  if ($name -match '(Uninstall|Deinstall|Help|Hilfe|Readme|Release Note|License|Documentation|Diagnos|Installer|Setup|Updater|AutoUpdate|Crash|Reporter|Migration|Repair|Proxy|entfernen|Website|FAQs|User Guide|Getting Started|Support Center|Manuals|Module Docs|Samples|im Internet|Private Brows|reset prefer|skinned|Cert Kit|Immersive Control)') { return $true }",
  "  if ($name -match '(Application Verifier|Developer |IDLE \\(|iSCSI|ODBC|Math Input|SDK Shell|SDK$|Windows Fax|Windows PowerShell|Windows Software|Windows Media|Windows App|Fairlight|Control Panel|Blackmagic RAW|Blackmagic Proxy|DaVinci Control|Neu in dieser)') { return $true }",
  "  if ($name -match '(^Magnify|^Narrator|^On-Screen Keyboard|^Steps Recorder|^Windows Speech|^Internet Explorer|Quick Assist|Remote Desktop|^WordPad|^Character Map|^XPS Viewer|^Administrative|^RecoveryDrive|^Speech Recognition|^Task Manager|^System Configuration|^System Information|^Registry Editor|^Resource Monitor|^Disk Cleanup|^Snipping Tool|^dfrgui|^Paint$|MDN Web)') { return $true }",
  "  if ($name -match '(^Notepad$|^Command Prompt|^Git (Bash|CMD|GUI)|^Filme|^Medien-|^Solitaire|Native Tools|Cross Tools)') { return $true }",
  "  return $false",
  "}",
  "",
  "# Phase 1: .lnk shortcuts",
  "$shell = New-Object -ComObject WScript.Shell",
  "$seenExe = @{}",
  "$results = @{}",
  "$userPath = [Environment]::GetFolderPath('StartMenu') + '\\Programs'",
  "$commonPath = [Environment]::GetFolderPath('CommonStartMenu') + '\\Programs'",
  "$userLnks = Get-ChildItem -Path $userPath -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue",
  "$commonLnks = Get-ChildItem -Path $commonPath -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue",
  "$allLnks = @($userLnks) + @($commonLnks)",
  "foreach ($file in $allLnks) {",
  "  if ($null -eq $file) { continue }",
  "  if (Test-Noise $file.BaseName) { continue }",
  "  try {",
  "    $lnk = $shell.CreateShortcut($file.FullName)",
  "    $target = $lnk.TargetPath",
  "    if ($target -and $target -match '\\.exe$' -and -not $seenExe[$target]) {",
  "      $seenExe[$target] = $true",
  "      $results[$file.BaseName] = $target",
  "    }",
  "  } catch {}",
  "}",
  "",
  "# Phase 2: Get-StartApps (Store/UWP apps like Spotify)",
  "try {",
  "  Get-StartApps 2>$null | ForEach-Object {",
  "    $name = $_.Name",
  "    $appId = $_.AppID",
  "    if (-not $name -or $name.Length -gt 50) { return }",
  "    if (Test-Noise $name) { return }",
  "    if ($name -match '(Settings|Store|Cortana|Microsoft Store|Command Prompt|Native Tools|Cross Tools|Tools for)') { return }",
  "    if ($appId -match '^(Microsoft\\.(Windows|Xbox|Bing|GetHelp|People|Tips|Maps|Messaging|MixedReality|3D|Print|Wallet|549981|ScreenSketch|MSPaint|YourPhone|MicrosoftEdge)|windows\\.|ms-resource:)') { return }",
  "    if ($name -match '^(Bildschirm|Aufgaben|Computer|Datentr|Dienste|Druckv|Editor|Eingabe|Ereignis|Komponenten|Kurznotizen|Laufwerke|Leistungs|Lokale Sicher|Registrier|Ressource|Schritt|Sprachausgabe|System|Task-Manager|Wiederherstell|Windows-|Zeichentabelle|Tipps|3D-Viewer)') { return }",
  "    if (-not $results.ContainsKey($name)) {",
  "      $results[$name] = \"appx:$appId\"",
  "    }",
  "  }",
  "} catch {}",
  "",
  "# Output sorted",
  "foreach ($entry in $results.GetEnumerator() | Sort-Object Key) {",
  "  \"$($entry.Key)\t$($entry.Value)\"",
  "}",
].join('\n');

const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
  encoding: 'utf-8',
  timeout: 20000,
});

const lines = (result.stdout || '').split('\n').filter(l => l.trim());
console.log(`Found ${lines.length} programs:\n`);

let lnk = 0, appx = 0;
lines.forEach(l => {
  const parts = l.trim().split('\t');
  const isAppx = (parts[1] || '').startsWith('appx:');
  if (isAppx) appx++; else lnk++;
  console.log(`  ${isAppx ? '[UWP]' : '[LNK]'} ${parts[0]}`);
});
console.log(`\n${lnk} desktop + ${appx} UWP = ${lines.length} total`);
