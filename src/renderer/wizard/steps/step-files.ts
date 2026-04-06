import type { WizardData, ProgramEntry, ProgramType } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';

function getSarah(): any {
  return (window as any).__sarah;
}

interface DetectedProgram {
  path: string;
  type: ProgramType;
  verified: boolean;
  aliases: string[];
  duplicateGroup?: string;
}

/** Maps program name → detected metadata */
const detectedProgramMap = new Map<string, DetectedProgram>();

const KNOWN_ICONS: Record<string, string> = {
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

function getIcon(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(KNOWN_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '📦';
}

/** Reference to the tag-select element so folder scans can inject options */
let tagSelectEl: ReturnType<typeof sarahTagSelect> | null = null;
let currentOptions: { value: string; label: string; icon: string }[] = [];
let currentSelected: string[] = [];

function syncTagSelect(data: WizardData): void {
  if (!tagSelectEl) return;
  tagSelectEl.setOptions(currentOptions);
  tagSelectEl.setSelected(currentSelected);
}

function addScannedPrograms(
  programs: { name: string; path: string; type: ProgramType; verified: boolean; aliases: string[]; duplicateGroup?: string }[],
  data: WizardData,
): void {
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
      currentOptions.push({ value: prog.name, label: prog.name + warning, icon: getIcon(prog.name) });
    }
  }
  syncTagSelect(data);
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

export function createFilesStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const detectedFolders: Record<string, string> = (data.system.folders as unknown as Record<string, string>) || {};

  const showGames = data.profile.usagePurposes.includes('Gaming') || data.profile.hobbies.includes('Gaming');

  // Placeholder shown while programs are loading
  const programsPlaceholder = document.createElement('div');
  programsPlaceholder.style.cssText = 'padding: 8px 0; color: var(--sarah-muted, #888); font-size: 0.9em;';
  programsPlaceholder.textContent = 'Lade Programme...';

  // Folder scan status indicator
  const scanStatus = document.createElement('div');
  scanStatus.style.cssText = 'padding: 4px 0; color: var(--sarah-accent, #00d4ff); font-size: 0.85em; min-height: 1.2em;';

  const children: HTMLElement[] = [
    programsPlaceholder,
    scanStatus,
  ];

  // Extra programs folder picker
  children.push(sarahPathPicker({
    label: 'Weitere Programme (Ordner scannen)',
    placeholder: 'z.B. E:\\ oder D:\\Programme...',
    value: data.resources.extraProgramsFolder,
    onChange: (value) => {
      data.resources.extraProgramsFolder = value;
      if (value) {
        scanStatus.textContent = 'Scanne Ordner...';
        getSarah().scanFolderExes(value).then((programs: any[]) => {
          scanStatus.textContent = programs.length > 0
            ? `${programs.length} Programme gefunden in ${value}`
            : 'Keine Programme gefunden';
          addScannedPrograms(programs, data);
          setTimeout(() => { scanStatus.textContent = ''; }, 4000);
        }).catch(() => { scanStatus.textContent = ''; });
      }
    },
  }));

  // Games folder picker (only if gaming selected)
  if (showGames) {
    children.push(sarahPathPicker({
      label: 'Games-Ordner (automatisch scannen)',
      placeholder: 'z.B. D:\\Games...',
      value: data.resources.gamesFolder,
      onChange: (value) => {
        data.resources.gamesFolder = value;
        if (value) {
          scanStatus.textContent = 'Scanne Games-Ordner...';
          getSarah().scanFolderExes(value).then((programs: any[]) => {
            scanStatus.textContent = programs.length > 0
              ? `${programs.length} Games gefunden in ${value}`
              : 'Keine Games gefunden';
            addScannedPrograms(programs, data);
            setTimeout(() => { scanStatus.textContent = ''; }, 4000);
          }).catch(() => { scanStatus.textContent = ''; });
        }
      },
    }));
  }

  // Standard folder pickers
  children.push(
    sarahPathPicker({
      label: 'Wichtige Ordner',
      placeholder: 'Ordner auswählen...',
      value: data.resources.importantFolders[0] ?? '',
      onChange: (value) => { data.resources.importantFolders = [value]; },
    }),
    sarahPathPicker({
      label: 'Wo speicherst du PDFs?',
      placeholder: 'PDF-Ordner...',
      value: data.resources.pdfFolder,
      onChange: (value) => { data.resources.pdfFolder = value; },
    }),
    sarahPathPicker({
      label: 'Wo liegen deine Bilder?',
      placeholder: detectedFolders.pictures || 'Bilder-Ordner...',
      value: data.resources.picturesFolder || detectedFolders.pictures || '',
      onChange: (value) => { data.resources.picturesFolder = value; },
    }),
    sarahPathPicker({
      label: 'Wo installierst du Programme?',
      placeholder: 'Installations-Ordner...',
      value: data.resources.installFolder,
      onChange: (value) => { data.resources.installFolder = value; },
    }),
  );

  const form = sarahForm({
    title: 'Dateien & Programme',
    description: 'Damit ich dir besser helfen kann, zeig mir wo deine wichtigen Dateien liegen. Wähle einen Ordner aus um ihn nach Programmen zu durchsuchen.',
    children,
  });

  container.appendChild(form);

  // Async: detect programs and replace placeholder with tag-select
  currentSelected = data.resources.programs.map(p => p.name);

  getSarah().detectPrograms().then((programs: { name: string; path: string; type: ProgramType; verified: boolean; aliases: string[]; duplicateGroup?: string }[]) => {
    for (const prog of programs) {
      detectedProgramMap.set(prog.name, {
        path: prog.path,
        type: prog.type,
        verified: prog.verified,
        aliases: prog.aliases,
        duplicateGroup: prog.duplicateGroup,
      });
    }

    currentOptions = programs.map(prog => {
      const warning = prog.type === 'updater' ? ' ⚠️ Updater' : prog.type === 'launcher' ? ' ⚠️ Launcher' : '';
      return {
        value: prog.name,
        label: prog.name + warning,
        icon: getIcon(prog.name),
      };
    });

    tagSelectEl = sarahTagSelect({
      label: 'Welche Programme nutzt du oft?',
      options: currentOptions,
      selected: currentSelected,
      allowCustom: true,
      onChange: (values) => {
        currentSelected = values;
        data.resources.programs = values.map(buildProgramEntry);
      },
    });

    programsPlaceholder.replaceWith(tagSelectEl);
  }).catch(() => {
    currentOptions = [];
    tagSelectEl = sarahTagSelect({
      label: 'Welche Programme nutzt du oft?',
      options: [],
      selected: currentSelected,
      allowCustom: true,
      onChange: (values) => {
        currentSelected = values;
        data.resources.programs = values.map(buildProgramEntry);
      },
    });
    programsPlaceholder.replaceWith(tagSelectEl);
  });

  return container;
}
