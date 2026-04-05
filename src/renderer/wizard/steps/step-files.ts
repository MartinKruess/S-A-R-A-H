import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';

const PROGRAM_OPTIONS = [
  { value: 'VS Code', label: 'VS Code', icon: '💻' },
  { value: 'Chrome', label: 'Chrome', icon: '🌐' },
  { value: 'Firefox', label: 'Firefox', icon: '🦊' },
  { value: 'Word', label: 'Word', icon: '📝' },
  { value: 'Excel', label: 'Excel', icon: '📊' },
  { value: 'Outlook', label: 'Outlook', icon: '📧' },
  { value: 'Slack', label: 'Slack', icon: '💬' },
  { value: 'Discord', label: 'Discord', icon: '🎮' },
  { value: 'Spotify', label: 'Spotify', icon: '🎵' },
  { value: 'Photoshop', label: 'Photoshop', icon: '🎨' },
];

export function createFilesStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  let detectedFolders: Record<string, string> = {};
  try {
    if (data.system.folders) {
      detectedFolders = JSON.parse(data.system.folders);
    }
  } catch {}

  const form = sarahForm({
    title: 'Dateien & Programme',
    description: 'Damit ich dir besser helfen kann, zeig mir wo deine wichtigen Dateien liegen. Du kannst das auch später einstellen.',
    children: [
      sarahTagSelect({
        label: 'Welche Programme nutzt du oft?',
        options: PROGRAM_OPTIONS,
        selected: data.files.importantPrograms,
        allowCustom: true,
        onChange: (values) => { data.files.importantPrograms = values; },
      }),
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
  return container;
}
