import * as fs from 'fs';
import * as path from 'path';

export interface ResolveFs {
  readdirSync(dir: string): string[];
  existsSync(p: string): boolean;
}

const realFs: ResolveFs = {
  readdirSync: (dir) => fs.readdirSync(dir),
  existsSync: (p) => fs.existsSync(p),
};

export const KNOWN_ALIASES: Record<string, string[]> = {
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

export function generateAliases(displayName: string): string[] {
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
export const UPDATER_PATTERNS = /[/\\](update|updater|auto-?update)\.exe$/i;
export const LAUNCHER_PATTERNS = /[/\\](launcher|pdflauncher|.*launcher)\.exe$/i;

export function classifyProgramPath(
  programPath: string,
): 'exe' | 'launcher' | 'appx' | 'updater' {
  if (!programPath) return 'exe';
  if (programPath.startsWith('appx:')) return 'appx';
  if (UPDATER_PATTERNS.test(programPath)) return 'updater';
  if (LAUNCHER_PATTERNS.test(programPath)) return 'launcher';
  return 'exe';
}

export function verifyProgramPath(programPath: string): boolean {
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
export function markDuplicateGroups(
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

/**
 * Parse version string like "1.0.10" into [1, 0, 10] for comparison.
 */
function parseVersion(version: string): number[] {
  return version.split('.').map((v) => parseInt(v, 10));
}

/**
 * Compare two versions [1, 0, 10] vs [1, 0, 9]; returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const aPart = a[i] ?? 0;
    const bPart = b[i] ?? 0;
    if (aPart > bPart) return 1;
    if (aPart < bPart) return -1;
  }
  return 0;
}

/**
 * Resolve an updater/launcher path to the real executable, or null if not
 * confidently found (caller then keeps the original path + warning).
 * - updater (Squirrel): <dir>/Update.exe -> <dir>/app-<highest version>/<FolderName>.exe
 * - launcher (best effort): a sibling .exe in the same dir whose name matches the parent folder
 */
export function resolveRealExe(
  programPath: string,
  type: 'exe' | 'launcher' | 'appx' | 'updater',
  fsImpl: ResolveFs = realFs,
): string | null {
  // Only attempt resolution for updater and launcher
  if (type === 'exe' || type === 'appx') {
    return null;
  }

  const dir = path.dirname(programPath);
  const folder = path.basename(dir);

  if (type === 'updater') {
    // Squirrel pattern: find app-<version> dirs, pick highest version
    let entries: string[];
    try {
      entries = fsImpl.readdirSync(dir);
    } catch {
      return null;
    }

    // Filter for app-<version> dirs
    const appDirs = entries.filter((e) => /^app-\d/i.test(e));
    if (appDirs.length === 0) {
      return null;
    }

    // Sort by version descending
    appDirs.sort((a, b) => {
      const aVersion = a.replace(/^app-/i, '');
      const bVersion = b.replace(/^app-/i, '');
      return compareVersions(parseVersion(bVersion), parseVersion(aVersion));
    });

    // Try highest version first
    for (const appDir of appDirs) {
      const candidate = path.join(dir, appDir, folder + '.exe');
      if (fsImpl.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  if (type === 'launcher') {
    // Launcher: find a sibling .exe whose name matches the folder
    let entries: string[];
    try {
      entries = fsImpl.readdirSync(dir);
    } catch {
      return null;
    }

    const normFolder = folder.toLowerCase().replace(/[\s\-.]/g, '');
    const selfName = path.basename(programPath).toLowerCase();

    for (const entry of entries) {
      const entryLower = entry.toLowerCase();
      if (!entryLower.endsWith('.exe')) {
        continue;
      }
      if (entryLower === selfName) {
        continue;
      }

      const entryBase = entryLower.replace(/\.exe$/, '');
      const normEntry = entryBase.replace(/[\s\-.]/g, '');

      // Match if names are equal or contain each other
      if (normEntry === normFolder || normFolder.includes(normEntry) || normEntry.includes(normFolder)) {
        const candidate = path.join(dir, entry);
        if (fsImpl.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  return null;
}
