import type { WizardData, PdfCategory } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';
import { PDF_CATEGORY_OPTIONS } from '../../shared/pdf-constants.js';
import { createPdfBlock } from '../../shared/pdf-block.js';
import { createProgramDetector } from '../program-detection.js';
import type { ScannedProgram, ProgramOption } from '../program-detection.js';

function getSarah(): any {
  return (window as any).__sarah;
}

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
`;

function findCategory(data: WizardData, tag: string): PdfCategory {
  let cat = data.resources.pdfCategories.find(c => c.tag === tag);
  if (!cat) {
    cat = { tag, folder: '', pattern: '', inferFromExisting: true };
    data.resources.pdfCategories.push(cat);
  }
  return cat;
}

export function createFilesStep(data: WizardData): HTMLElement {
  // Per-instance state — no module-level singletons
  const detector = createProgramDetector();
  let tagSelectEl: ReturnType<typeof sarahTagSelect> | null = null;
  let currentOptions: ProgramOption[] = [];
  let currentSelected: string[] = data.resources.programs.map(p => p.name);

  function syncTagSelect(): void {
    if (!tagSelectEl) return;
    tagSelectEl.setOptions(currentOptions);
    tagSelectEl.setSelected(currentSelected);
  }

  function addScannedPrograms(programs: ScannedProgram[]): void {
    detector.addScannedPrograms(programs, currentOptions);
    syncTagSelect();
  }

  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = GRID_CSS;
  container.appendChild(style);

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

  // --- Folder grid (2-col on desktop) ---
  const folderGrid = document.createElement('div');
  folderGrid.className = 'folder-grid';

  // Extra programs folder picker
  folderGrid.appendChild(sarahPathPicker({
    label: 'Weitere Programme (Ordner scannen)',
    placeholder: 'z.B. E:\\ oder D:\\Programme...',
    value: data.resources.extraProgramsFolder,
    onChange: (value) => {
      data.resources.extraProgramsFolder = value;
      if (value) {
        scanStatus.textContent = 'Scanne Ordner...';
        getSarah().scanFolderExes(value).then((programs: ScannedProgram[]) => {
          scanStatus.textContent = programs.length > 0
            ? `${programs.length} Programme gefunden in ${value}`
            : 'Keine Programme gefunden';
          addScannedPrograms(programs);
          setTimeout(() => { scanStatus.textContent = ''; }, 4000);
        }).catch(() => { scanStatus.textContent = ''; });
      }
    },
  }));

  // Games folder picker (only if gaming selected)
  if (showGames) {
    folderGrid.appendChild(sarahPathPicker({
      label: 'Games-Ordner (automatisch scannen)',
      placeholder: 'z.B. D:\\Games...',
      value: data.resources.gamesFolder,
      onChange: (value) => {
        data.resources.gamesFolder = value;
        if (value) {
          scanStatus.textContent = 'Scanne Games-Ordner...';
          getSarah().scanFolderExes(value).then((programs: ScannedProgram[]) => {
            scanStatus.textContent = programs.length > 0
              ? `${programs.length} Games gefunden in ${value}`
              : 'Keine Games gefunden';
            addScannedPrograms(programs);
            setTimeout(() => { scanStatus.textContent = ''; }, 4000);
          }).catch(() => { scanStatus.textContent = ''; });
        }
      },
    }));
  }

  // Standard folder pickers
  folderGrid.appendChild(sarahPathPicker({
    label: 'Wo liegen deine Bilder?',
    placeholder: detectedFolders.pictures || 'Bilder-Ordner...',
    value: data.resources.picturesFolder || detectedFolders.pictures || '',
    onChange: (value) => { data.resources.picturesFolder = value; },
  }));

  folderGrid.appendChild(sarahPathPicker({
    label: 'Wo installierst du Programme?',
    placeholder: 'Installations-Ordner...',
    value: data.resources.installFolder,
    onChange: (value) => { data.resources.installFolder = value; },
  }));

  children.push(folderGrid);

  // --- PDF Categories ---
  const pdfBlocksContainer = document.createElement('div');
  pdfBlocksContainer.style.cssText = 'display: flex; flex-direction: column; gap: var(--sarah-space-md);';

  // Restore existing category blocks
  for (const cat of data.resources.pdfCategories) {
    pdfBlocksContainer.appendChild(createPdfBlock(findCategory(data, cat.tag)));
  }

  children.push(
    sarahTagSelect({
      label: 'Welche Arten von PDFs hast du?',
      options: PDF_CATEGORY_OPTIONS,
      selected: data.resources.pdfCategories.map(c => c.tag),
      allowCustom: true,
      onChange: (values) => {
        // Add new blocks
        for (const tag of values) {
          if (!pdfBlocksContainer.querySelector(`[data-pdf-tag="${tag}"]`)) {
            pdfBlocksContainer.appendChild(createPdfBlock(findCategory(data, tag)));
          }
        }
        // Remove deselected blocks
        const blocks = pdfBlocksContainer.querySelectorAll<HTMLElement>('[data-pdf-tag]');
        blocks.forEach(block => {
          const blockTag = block.dataset.pdfTag!;
          if (!values.includes(blockTag)) {
            block.remove();
            data.resources.pdfCategories = data.resources.pdfCategories.filter(c => c.tag !== blockTag);
          }
        });
      },
    }),
    pdfBlocksContainer,
  );

  const form = sarahForm({
    title: 'Dateien & Programme',
    description: 'Damit ich dir besser helfen kann, zeig mir wo deine wichtigen Dateien liegen. Wähle einen Ordner aus um ihn nach Programmen zu durchsuchen.',
    children,
  });

  container.appendChild(form);

  // Async: detect programs and replace placeholder with tag-select
  getSarah().detectPrograms().then((programs: ScannedProgram[]) => {
    detector.registerDetected(programs);
    currentOptions = detector.buildOptions(programs);

    tagSelectEl = sarahTagSelect({
      label: 'Welche Programme nutzt du oft?',
      options: currentOptions,
      selected: currentSelected,
      allowCustom: true,
      onChange: (values) => {
        currentSelected = values;
        data.resources.programs = values.map(detector.buildProgramEntry);
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
        data.resources.programs = values.map(detector.buildProgramEntry);
      },
    });
    programsPlaceholder.replaceWith(tagSelectEl);
  });

  return container;
}
