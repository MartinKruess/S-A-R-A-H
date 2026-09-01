import { sarahPathPicker } from '../../../components/sarah-path-picker.js';
import { sarahTagSelect } from '../../../components/sarah-tag-select.js';
import { PDF_CATEGORY_OPTIONS } from '../../../shared/pdf-constants.js';
import { createPdfBlock } from '../../../shared/pdf-block.js';
import { showSaved, createSectionHeader, createHint, save } from '../../../shared/settings-utils.js';
import { createProgramPicker } from '../../../shared/program-picker.js';
import { createSettingsSubtabs } from '../../../shared/settings-subtabs.js';
import { createContextManagementPanel } from './context-management-section.js';
import type { SarahConfig, PdfCategory } from '../../../../core/config-schema.js';

export function createFilesSection(config: SarahConfig): HTMLElement {
  const resources = {
    ...config.resources,
    importantFolders: [...config.resources.importantFolders],
  };
  const skills = { ...config.skills };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Verwaltung');
  section.appendChild(header);

  const notifyResources = (): void => {
    save('resources', resources);
    showSaved(feedback);
  };

  const programsPanel = document.createElement('div');
  programsPanel.appendChild(createProgramPicker({
    initialSelected: resources.programs,
    onChange: (entries) => {
      resources.programs = entries;
      notifyResources();
    },
    includeFolderScanners: false,
  }));

  const programPickerHint = document.createElement('div');
  programPickerHint.className = 'program-picker-hint';
  programPickerHint.textContent = 'Nach Ordner-Änderung App neu starten, um neue Programme zu erfassen.';
  programsPanel.appendChild(programPickerHint);

  const programFolders = document.createElement('div');
  programFolders.className = 'settings-grid settings-subtab-grid';
  programFolders.appendChild(sarahPathPicker({
    label: 'Installations-Ordner',
    placeholder: 'Installations-Ordner...',
    value: resources.installFolder || '',
    onChange: (val) => { resources.installFolder = val; notifyResources(); },
  }));
  programFolders.appendChild(sarahPathPicker({
    label: 'Games-Ordner',
    placeholder: 'Games-Ordner...',
    value: resources.gamesFolder || '',
    onChange: (val) => { resources.gamesFolder = val; notifyResources(); },
  }));
  programFolders.appendChild(sarahPathPicker({
    label: 'Weitere Programme (Ordner)',
    placeholder: 'z.B. D:\\Programme...',
    value: resources.extraProgramsFolder || '',
    onChange: (val) => { resources.extraProgramsFolder = val; notifyResources(); },
  }));
  programsPanel.appendChild(programFolders);

  const foldersPanel = document.createElement('div');
  const folderGrid = document.createElement('div');
  folderGrid.className = 'settings-grid';
  folderGrid.appendChild(sarahPathPicker({
    label: 'Bilder-Ordner',
    placeholder: 'Bilder-Ordner...',
    value: resources.picturesFolder || '',
    onChange: (val) => { resources.picturesFolder = val; notifyResources(); },
  }));
  if (skills.programming) {
    folderGrid.appendChild(sarahPathPicker({
      label: 'Projekte-Ordner',
      placeholder: 'Projekte-Ordner...',
      value: skills.programmingProjectsFolder || '',
      onChange: (val) => {
        skills.programmingProjectsFolder = val;
        save('skills', skills);
        showSaved(feedback);
      },
    }));
  }
  foldersPanel.appendChild(folderGrid);

  const additionalHeading = document.createElement('div');
  additionalHeading.className = 'settings-secondary-heading';
  additionalHeading.textContent = 'Weitere Ordner';
  foldersPanel.appendChild(additionalHeading);
  foldersPanel.appendChild(createHint('Ergänze Verzeichnisse, auf die Sarah bei lokalen Dateiaktionen zugreifen darf.'));

  const importantFolderList = document.createElement('div');
  importantFolderList.className = 'important-folder-list';
  foldersPanel.appendChild(importantFolderList);

  const renderImportantFolders = (): void => {
    importantFolderList.replaceChildren();
    resources.importantFolders.forEach((folder, index) => {
      const row = document.createElement('div');
      row.className = 'important-folder-row';
      row.appendChild(sarahPathPicker({
        label: `Weiterer Ordner ${index + 1}`,
        placeholder: 'Ordner auswählen...',
        value: folder,
        onChange: (val) => {
          resources.importantFolders[index] = val;
          notifyResources();
        },
      }));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'settings-links-remove';
      remove.textContent = '✕';
      remove.setAttribute('aria-label', `Weiteren Ordner ${index + 1} entfernen`);
      remove.addEventListener('click', () => {
        resources.importantFolders.splice(index, 1);
        notifyResources();
        renderImportantFolders();
      });
      row.appendChild(remove);
      importantFolderList.appendChild(row);
    });
  };
  renderImportantFolders();

  const addFolder = document.createElement('button');
  addFolder.type = 'button';
  addFolder.className = 'settings-links-add important-folder-add';
  addFolder.textContent = '+ Ordner hinzufügen';
  addFolder.addEventListener('click', () => {
    resources.importantFolders.push('');
    renderImportantFolders();
  });
  foldersPanel.appendChild(addFolder);

  const organizationPanel = document.createElement('div');
  organizationPanel.appendChild(createHint('Lege Bereiche, Ablageorte und Benennungsregeln fest. Aktuell werden PDF-Dokumente unterstützt; weitere Dateitypen können später dieselbe Struktur nutzen.'));

  const pdfCats: PdfCategory[] = resources.pdfCategories || [];
  const pdfContainer = document.createElement('div');
  pdfContainer.className = 'pdf-list';
  const onPdfUpdate = (): void => {
    resources.pdfCategories = pdfCats;
    notifyResources();
  };
  for (const cat of pdfCats) pdfContainer.appendChild(createPdfBlock(cat, onPdfUpdate));

  organizationPanel.appendChild(sarahTagSelect({
    label: 'Organisationsbereiche',
    options: [
      ...PDF_CATEGORY_OPTIONS,
      ...pdfCats
        .filter(({ tag }) => !PDF_CATEGORY_OPTIONS.some(({ value }) => value === tag))
        .map(({ tag }) => ({ value: tag, label: tag })),
    ],
    selected: pdfCats.map(c => c.tag),
    allowCustom: true,
    onChange: (values) => {
      for (const tag of values) {
        if (!pdfCats.some((category) => category.tag === tag)) {
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
  organizationPanel.appendChild(pdfContainer);

  section.appendChild(createSettingsSubtabs([
    { id: 'programs', label: 'Programme', content: programsPanel },
    { id: 'folders', label: 'Ordner & Verzeichnisse', content: foldersPanel },
    { id: 'organization', label: 'Organisation', content: organizationPanel },
    { id: 'context', label: 'Kontext', content: createContextManagementPanel(config) },
  ]));

  return section;
}
