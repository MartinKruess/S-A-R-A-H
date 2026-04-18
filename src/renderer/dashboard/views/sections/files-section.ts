import { sarahPathPicker } from '../../../components/sarah-path-picker.js';
import { sarahTagSelect } from '../../../components/sarah-tag-select.js';
import { PDF_CATEGORY_OPTIONS } from '../../../shared/pdf-constants.js';
import { createPdfBlock } from '../../../shared/pdf-block.js';
import { showSaved, createSectionHeader, save } from '../../../shared/settings-utils.js';
import type { SarahConfig, PdfCategory } from '../../../../core/config-schema.js';

export function createFilesSection(config: SarahConfig): HTMLElement {
  const resources = { ...config.resources };
  const skills = { ...config.skills };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Dateien & Ordner');
  section.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'settings-grid';

  grid.appendChild(sarahPathPicker({
    label: 'Bilder-Ordner',
    placeholder: 'Bilder-Ordner...',
    value: resources.picturesFolder || '',
    onChange: (val) => { resources.picturesFolder = val; save('resources', resources); showSaved(feedback); },
  }));

  grid.appendChild(sarahPathPicker({
    label: 'Installations-Ordner',
    placeholder: 'Installations-Ordner...',
    value: resources.installFolder || '',
    onChange: (val) => { resources.installFolder = val; save('resources', resources); showSaved(feedback); },
  }));

  grid.appendChild(sarahPathPicker({
    label: 'Games-Ordner',
    placeholder: 'Games-Ordner...',
    value: resources.gamesFolder || '',
    onChange: (val) => { resources.gamesFolder = val; save('resources', resources); showSaved(feedback); },
  }));

  grid.appendChild(sarahPathPicker({
    label: 'Weitere Programme (Ordner)',
    placeholder: 'z.B. D:\\Programme...',
    value: resources.extraProgramsFolder || '',
    onChange: (val) => { resources.extraProgramsFolder = val; save('resources', resources); showSaved(feedback); },
  }));

  if (skills.programming) {
    grid.appendChild(sarahPathPicker({
      label: 'Projekte-Ordner',
      placeholder: 'Projekte-Ordner...',
      value: skills.programmingProjectsFolder || '',
      onChange: (val) => { skills.programmingProjectsFolder = val; save('skills', skills); showSaved(feedback); },
    }));
  }

  section.appendChild(grid);

  // PDF Categories
  const pdfCats: PdfCategory[] = resources.pdfCategories || [];
  const pdfContainer = document.createElement('div');
  pdfContainer.className = 'pdf-list';

  const onPdfUpdate = () => { resources.pdfCategories = pdfCats; save('resources', resources); showSaved(feedback); };

  for (const cat of pdfCats) {
    pdfContainer.appendChild(createPdfBlock(cat, onPdfUpdate));
  }

  section.appendChild(sarahTagSelect({
    label: 'PDF-Kategorien',
    options: PDF_CATEGORY_OPTIONS,
    selected: pdfCats.map(c => c.tag),
    allowCustom: true,
    onChange: (values) => {
      for (const tag of values) {
        if (!pdfContainer.querySelector(`[data-pdf-tag="${tag}"]`)) {
          const cat: PdfCategory = { tag, folder: '', pattern: '', inferFromExisting: true };
          pdfCats.push(cat);
          pdfContainer.appendChild(createPdfBlock(cat, onPdfUpdate));
        }
      }
      const blocks = pdfContainer.querySelectorAll<HTMLElement>('[data-pdf-tag]');
      blocks.forEach(block => {
        const blockTag = block.dataset.pdfTag!;
        if (!values.includes(blockTag)) {
          block.remove();
          const idx = pdfCats.findIndex(c => c.tag === blockTag);
          if (idx >= 0) pdfCats.splice(idx, 1);
        }
      });
      onPdfUpdate();
    },
  }));
  section.appendChild(pdfContainer);

  return section;
}
