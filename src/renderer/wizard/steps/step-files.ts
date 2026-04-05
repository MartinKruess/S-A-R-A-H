import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';

function getSarah(): any {
  return (window as any).__sarah;
}

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
  getSarah().detectPrograms().then((programs: string[]) => {
    const top10 = programs.slice(0, 10);
    const options = top10.map((name: string) => ({
      value: name,
      label: name,
      icon: getIcon(name),
    }));

    const tagSelect = sarahTagSelect({
      label: 'Welche Programme nutzt du oft?',
      options,
      selected: data.files.importantPrograms,
      allowCustom: true,
      onChange: (values) => { data.files.importantPrograms = values; },
    });

    programsPlaceholder.replaceWith(tagSelect);
  }).catch(() => {
    // On failure, show a basic empty tag-select with allowCustom
    const tagSelect = sarahTagSelect({
      label: 'Welche Programme nutzt du oft?',
      options: [],
      selected: data.files.importantPrograms,
      allowCustom: true,
      onChange: (values) => { data.files.importantPrograms = values; },
    });
    programsPlaceholder.replaceWith(tagSelect);
  });

  return container;
}
