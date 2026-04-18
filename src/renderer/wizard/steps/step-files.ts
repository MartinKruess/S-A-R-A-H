import type { WizardData, PdfCategory } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';
import { PDF_CATEGORY_OPTIONS } from '../../shared/pdf-constants.js';
import { createPdfBlock } from '../../shared/pdf-block.js';
import { createProgramDetector } from '../program-detection.js';
import type { ProgramOption } from '../program-detection.js';
import { getSarah } from '../../shared/settings-utils.js';
import type { ProgramEntry } from '../../../core/config-schema.js';

const GRID_CSS = `
  .folder-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--sarah-space-md);
  }

  @media (min-width: 600px) {
    .folder-grid {
      grid-template-columns: 1fr 1fr;
    }
  }

  .pdf-block {
    padding: var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-sm);
  }

  .pdf-block-title {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-accent);
    font-weight: 500;
    letter-spacing: 0.03em;
  }

  .files-placeholder {
    padding: 8px 0;
    color: var(--sarah-text-muted);
    font-size: var(--sarah-font-size-sm);
  }

  .files-scan-status {
    padding: 4px 0;
    color: var(--sarah-accent);
    font-size: var(--sarah-font-size-sm);
    min-height: 1.2em;
  }

  .pdf-blocks {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-md);
  }
`;

type Detector = ReturnType<typeof createProgramDetector>;

interface ScanBinding {
  status: HTMLElement;
  detector: Detector;
  currentOptions: ProgramOption[];
  syncTagSelect: () => void;
}

function findCategory(data: WizardData, tag: string): PdfCategory {
  let cat = data.resources.pdfCategories.find(c => c.tag === tag);
  if (!cat) {
    cat = { tag, folder: '', pattern: '', inferFromExisting: true };
    data.resources.pdfCategories.push(cat);
  }
  return cat;
}

function runScan(binding: ScanBinding, folderPath: string, label: string): void {
  binding.status.textContent = `Scanne ${label}...`;
  getSarah().scanFolderExes(folderPath).then((programs: ProgramEntry[]) => {
    binding.status.textContent = programs.length > 0
      ? `${programs.length} ${label} gefunden in ${folderPath}`
      : `Keine ${label} gefunden`;
    binding.detector.addScannedPrograms(programs, binding.currentOptions);
    binding.syncTagSelect();
    setTimeout(() => { binding.status.textContent = ''; }, 4000);
  }).catch(() => { binding.status.textContent = ''; });
}

function createFolderGrid(data: WizardData, binding: ScanBinding): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'folder-grid';
  const showGames = data.profile.usagePurposes.includes('Gaming') || data.profile.hobbies.includes('Gaming');

  grid.appendChild(sarahPathPicker({
    label: 'Weitere Programme (Ordner scannen)',
    placeholder: 'z.B. E:\\ oder D:\\Programme...',
    value: data.resources.extraProgramsFolder,
    onChange: (value) => {
      data.resources.extraProgramsFolder = value;
      if (value) runScan(binding, value, 'Programme');
    },
  }));

  if (showGames) {
    grid.appendChild(sarahPathPicker({
      label: 'Games-Ordner (automatisch scannen)',
      placeholder: 'z.B. D:\\Games...',
      value: data.resources.gamesFolder,
      onChange: (value) => {
        data.resources.gamesFolder = value;
        if (value) runScan(binding, value, 'Games');
      },
    }));
  }

  grid.appendChild(sarahPathPicker({
    label: 'Wo liegen deine Bilder?',
    placeholder: data.system.folders.pictures || 'Bilder-Ordner...',
    value: data.resources.picturesFolder || data.system.folders.pictures || '',
    onChange: (value) => { data.resources.picturesFolder = value; },
  }));

  grid.appendChild(sarahPathPicker({
    label: 'Wo installierst du Programme?',
    placeholder: 'Installations-Ordner...',
    value: data.resources.installFolder,
    onChange: (value) => { data.resources.installFolder = value; },
  }));

  return grid;
}

function createPdfSection(data: WizardData): HTMLElement[] {
  const blocks = document.createElement('div');
  blocks.className = 'pdf-blocks';

  for (const cat of data.resources.pdfCategories) {
    blocks.appendChild(createPdfBlock(findCategory(data, cat.tag)));
  }

  const tagSelect = sarahTagSelect({
    label: 'Welche Arten von PDFs hast du?',
    options: PDF_CATEGORY_OPTIONS,
    selected: data.resources.pdfCategories.map(c => c.tag),
    allowCustom: true,
    onChange: (values) => {
      for (const tag of values) {
        if (!blocks.querySelector(`[data-pdf-tag="${tag}"]`)) {
          blocks.appendChild(createPdfBlock(findCategory(data, tag)));
        }
      }
      blocks.querySelectorAll<HTMLElement>('[data-pdf-tag]').forEach(block => {
        const blockTag = block.dataset.pdfTag!;
        if (!values.includes(blockTag)) {
          block.remove();
          data.resources.pdfCategories = data.resources.pdfCategories.filter(c => c.tag !== blockTag);
        }
      });
    },
  });

  return [tagSelect, blocks];
}

export function createFilesStep(data: WizardData): HTMLElement {
  const detector = createProgramDetector();
  let tagSelectEl: ReturnType<typeof sarahTagSelect> | null = null;
  let currentOptions: ProgramOption[] = [];
  let currentSelected: string[] = data.resources.programs.map(p => p.name);

  const syncTagSelect = (): void => {
    if (!tagSelectEl) return;
    tagSelectEl.setOptions(currentOptions);
    tagSelectEl.setSelected(currentSelected);
  };

  const container = document.createElement('div');
  const style = document.createElement('style');
  style.textContent = GRID_CSS;
  container.appendChild(style);

  const programsPlaceholder = document.createElement('div');
  programsPlaceholder.className = 'files-placeholder';
  programsPlaceholder.textContent = 'Lade Programme...';

  const scanStatus = document.createElement('div');
  scanStatus.className = 'files-scan-status';

  const binding: ScanBinding = {
    status: scanStatus,
    detector,
    currentOptions,
    syncTagSelect,
  };

  const pdfChildren = createPdfSection(data);

  const form = sarahForm({
    title: 'Dateien & Programme',
    description: 'Damit ich dir besser helfen kann, zeig mir wo deine wichtigen Dateien liegen. Wähle einen Ordner aus um ihn nach Programmen zu durchsuchen.',
    children: [
      programsPlaceholder,
      scanStatus,
      createFolderGrid(data, binding),
      ...pdfChildren,
    ],
  });

  container.appendChild(form);

  const makeProgramsSelect = (options: ProgramOption[]): HTMLElement => sarahTagSelect({
    label: 'Welche Programme nutzt du oft?',
    options,
    selected: currentSelected,
    allowCustom: true,
    onChange: (values) => {
      currentSelected = values;
      data.resources.programs = values.map(detector.buildProgramEntry);
    },
  });

  getSarah().detectPrograms().then((programs: ProgramEntry[]) => {
    detector.registerDetected(programs);
    currentOptions = detector.buildOptions(programs);
    binding.currentOptions = currentOptions;
    tagSelectEl = makeProgramsSelect(currentOptions);
    programsPlaceholder.replaceWith(tagSelectEl);
  }).catch(() => {
    currentOptions = [];
    binding.currentOptions = currentOptions;
    tagSelectEl = makeProgramsSelect([]);
    programsPlaceholder.replaceWith(tagSelectEl);
  });

  return container;
}
