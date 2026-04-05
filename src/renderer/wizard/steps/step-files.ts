import type { WizardData, ProgramEntry } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';

function getSarah(): any {
  return (window as any).__sarah;
}

/** Maps program name → detected metadata (path, verified, aliases) */
const detectedProgramMap = new Map<string, { path: string; verified: boolean; aliases: string[] }>();

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
};

function getIcon(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(KNOWN_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '📦';
}

export function createFilesStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  let detectedFolders: Record<string, string> = {};
  try {
    if (data.system.folders) {
      detectedFolders = JSON.parse(data.system.folders);
    }
  } catch {}

  // Placeholder shown while programs are loading
  const programsPlaceholder = document.createElement('div');
  programsPlaceholder.style.cssText = 'padding: 8px 0; color: var(--sarah-muted, #888); font-size: 0.9em;';
  programsPlaceholder.textContent = 'Lade Programme...';

  const form = sarahForm({
    title: 'Dateien & Programme',
    description: 'Damit ich dir besser helfen kann, zeig mir wo deine wichtigen Dateien liegen. Du kannst das auch später einstellen.',
    children: [
      programsPlaceholder,
      sarahPathPicker({
        label: 'Wichtige Ordner',
        placeholder: 'Ordner auswählen...',
        value: data.files.importantFolders[0] ?? '',
        onChange: (value) => { data.files.importantFolders = [value]; },
      }),
      sarahPathPicker({
        label: 'Wo speicherst du PDFs?',
        placeholder: 'PDF-Ordner...',
        value: data.files.pdfFolder,
        onChange: (value) => { data.files.pdfFolder = value; },
      }),
      sarahPathPicker({
        label: 'Wo liegen deine Bilder?',
        placeholder: detectedFolders.pictures || 'Bilder-Ordner...',
        value: data.files.picturesFolder || detectedFolders.pictures || '',
        onChange: (value) => { data.files.picturesFolder = value; },
      }),
      sarahPathPicker({
        label: 'Wo installierst du Programme?',
        placeholder: 'Installations-Ordner...',
        value: data.files.installFolder,
        onChange: (value) => { data.files.installFolder = value; },
      }),
    ],
  });

  container.appendChild(form);

  // Async: detect programs and replace placeholder with tag-select
  const alreadySelected = data.files.importantPrograms.map(p => p.name);

  function buildProgramEntry(name: string): ProgramEntry {
    const detected = detectedProgramMap.get(name);
    if (detected) {
      return { name, path: detected.path, source: 'detected', verified: detected.verified, aliases: detected.aliases };
    }
    return { name, path: '', source: 'manual', verified: false, aliases: [] };
  }

  getSarah().detectPrograms().then((programs: { name: string; path: string; verified: boolean; aliases: string[] }[]) => {
    for (const prog of programs) {
      detectedProgramMap.set(prog.name, { path: prog.path, verified: prog.verified, aliases: prog.aliases });
    }

    const options = programs.map(prog => ({
      value: prog.name,
      label: prog.name,
      icon: getIcon(prog.name),
    }));

    const tagSelect = sarahTagSelect({
      label: 'Welche Programme nutzt du oft?',
      options,
      selected: alreadySelected,
      allowCustom: true,
      onChange: (values) => { data.files.importantPrograms = values.map(buildProgramEntry); },
    });

    programsPlaceholder.replaceWith(tagSelect);
  }).catch(() => {
    const tagSelect = sarahTagSelect({
      label: 'Welche Programme nutzt du oft?',
      options: [],
      selected: alreadySelected,
      allowCustom: true,
      onChange: (values) => { data.files.importantPrograms = values.map(buildProgramEntry); },
    });
    programsPlaceholder.replaceWith(tagSelect);
  });

  return container;
}
