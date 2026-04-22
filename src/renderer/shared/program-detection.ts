import type { ProgramEntry } from '../../core/config-schema.js';
type ProgramType = ProgramEntry['type'];

export interface DetectedProgram {
  path: string;
  type: ProgramType;
  verified: boolean;
  aliases: string[];
  duplicateGroup?: string;
}

export const KNOWN_ICONS: Record<string, string> = {
  'visual studio code': '💻',
  'vs code': '💻',
  'google chrome': '🌐',
  'chrome': '🌐',
  'mozilla firefox': '🦊',
  'firefox': '🦊',
  'microsoft word': '📝',
  'word': '📝',
  'microsoft excel': '📊',
  'excel': '📊',
  'microsoft outlook': '📧',
  'outlook': '📧',
  'slack': '💬',
  'discord': '🎮',
  'spotify': '🎵',
  'adobe photoshop': '🎨',
  'photoshop': '🎨',
  'steam': '🎮',
  'notepad++': '📝',
  'git': '🔧',
  '7-zip': '📦',
  'vlc': '🎬',
  'obs studio': '🎥',
  'telegram': '💬',
  'whatsapp': '💬',
  'zoom': '📹',
  'microsoft teams': '📹',
  'davinci': '🎬',
  'resolve': '🎬',
  'blender': '🎨',
  'gimp': '🎨',
  'audacity': '🎵',
  'opera': '🌐',
  'brave': '🌐',
  'edge': '🌐',
  'filezilla': '📂',
  'postman': '🔧',
  'docker': '🐳',
  'after effects': '🎬',
  'premiere': '🎬',
  'illustrator': '🎨',
  'lightroom': '📷',
  'acrobat': '📄',
};

export function getIcon(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(KNOWN_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '📦';
}

export interface ProgramOption {
  value: string;
  label: string;
  icon: string;
}

/**
 * Per-instance program detection state.
 * Instantiate once per createFilesStep() call to avoid shared module-level state.
 */
export function createProgramDetector() {
  const detectedProgramMap = new Map<string, DetectedProgram>();

  /**
   * Registers newly-scanned programs and returns the ProgramOption[] entries
   * for programs that weren't already in the detected map. Does not mutate caller state.
   */
  function addScannedPrograms(programs: ProgramEntry[]): ProgramOption[] {
    const newOptions: ProgramOption[] = [];
    for (const prog of programs) {
      if (!detectedProgramMap.has(prog.name)) {
        detectedProgramMap.set(prog.name, {
          path: prog.path,
          type: prog.type,
          verified: prog.verified,
          aliases: prog.aliases,
          duplicateGroup: prog.duplicateGroup,
        });
        const warning = prog.type === 'updater' ? ' ⚠️ Updater' : prog.type === 'launcher' ? ' ⚠️ Launcher' : '';
        newOptions.push({ value: prog.name, label: prog.name + warning, icon: getIcon(prog.name) });
      }
    }
    return newOptions;
  }

  function getScannedExtras(excludeFromIpc: ProgramEntry[]): ProgramOption[] {
    const excludedNames = new Set(excludeFromIpc.map(p => p.name));
    const extras: ProgramOption[] = [];
    for (const [name, detected] of detectedProgramMap.entries()) {
      if (excludedNames.has(name)) continue;
      const warning = detected.type === 'updater' ? ' ⚠️ Updater' : detected.type === 'launcher' ? ' ⚠️ Launcher' : '';
      extras.push({ value: name, label: name + warning, icon: getIcon(name) });
    }
    return extras;
  }

  function registerDetected(programs: ProgramEntry[]): void {
    for (const prog of programs) {
      detectedProgramMap.set(prog.name, {
        path: prog.path,
        type: prog.type,
        verified: prog.verified,
        aliases: prog.aliases,
        duplicateGroup: prog.duplicateGroup,
      });
    }
  }

  function buildOptions(programs: ProgramEntry[]): ProgramOption[] {
    return programs.map(prog => {
      const warning = prog.type === 'updater' ? ' ⚠️ Updater' : prog.type === 'launcher' ? ' ⚠️ Launcher' : '';
      return {
        value: prog.name,
        label: prog.name + warning,
        icon: getIcon(prog.name),
      };
    });
  }

  function buildProgramEntry(name: string): ProgramEntry {
    const detected = detectedProgramMap.get(name);
    if (detected) {
      return {
        name,
        path: detected.path,
        type: detected.type,
        source: 'detected',
        verified: detected.verified,
        aliases: detected.aliases,
        duplicateGroup: detected.duplicateGroup,
      };
    }
    return { name, path: '', type: 'exe', source: 'manual', verified: false, aliases: [] };
  }

  return { addScannedPrograms, getScannedExtras, registerDetected, buildOptions, buildProgramEntry };
}
