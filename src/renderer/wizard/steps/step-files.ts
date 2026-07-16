import type { WizardData, PdfCategory } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';
import { PDF_CATEGORY_OPTIONS } from '../../shared/pdf-constants.js';
import { createPdfBlock } from '../../shared/pdf-block.js';
import { createProgramPicker } from '../../shared/program-picker.js';

const GRID_CSS = `
  .step-files-misc-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--sarah-space-md);
    margin-top: var(--sarah-space-md);
  }
  @media (min-width: 600px) {
    .step-files-misc-grid {
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

  .pdf-blocks {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-md);
  }
`;

function findCategory(data: WizardData, tag: string): PdfCategory {
  let cat = data.resources.pdfCategories.find(c => c.tag === tag);
  if (!cat) {
    cat = { tag, folder: '', pattern: '', inferFromExisting: true };
    data.resources.pdfCategories.push(cat);
  }
  return cat;
}

function createMiscFolders(data: WizardData): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'step-files-misc-grid';

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
  const container = document.createElement('div');
  const style = document.createElement('style');
  style.textContent = GRID_CSS;
  container.appendChild(style);

  const showGames = data.profile.usagePurposes.includes('Gaming') || data.profile.hobbies.includes('Gaming');

  const picker = createProgramPicker({
    initialSelected: data.resources.programs,
    onChange: (entries) => { data.resources.programs = entries; },
    includeFolderScanners: true,
    initialExtraFolder: data.resources.extraProgramsFolder,
    initialGamesFolder: data.resources.gamesFolder,
    showGamesFolder: showGames,
    onFolderChange: (kind, path) => {
      if (kind === 'extra') data.resources.extraProgramsFolder = path;
      if (kind === 'games') data.resources.gamesFolder = path;
    },
  });

  const miscFolders = createMiscFolders(data);
  const pdfChildren = createPdfSection(data);

  const form = sarahForm({
    title: 'Dateien & Programme',
    description: 'Damit ich dir besser helfen kann, zeig mir wo deine wichtigen Dateien liegen. Wähle einen Ordner aus um ihn nach Programmen zu durchsuchen.',
    children: [
      picker,
      miscFolders,
      ...pdfChildren,
    ],
  });

  container.appendChild(form);
  return container;
}
