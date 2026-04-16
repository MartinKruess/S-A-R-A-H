import * as fs from 'fs';

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
