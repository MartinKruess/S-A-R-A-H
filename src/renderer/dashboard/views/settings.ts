import { sarahInput } from '../../components/sarah-input.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahButton } from '../../components/sarah-button.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';

type Config = Record<string, Record<string, unknown>>;

function getSarah(): Record<string, (...args: unknown[]) => unknown> {
  return ((window as unknown) as Record<string, unknown>).__sarah as Record<string, (...args: unknown[]) => unknown>;
}

function showSaved(feedback: HTMLElement): void {
  feedback.classList.add('visible');
  setTimeout(() => feedback.classList.remove('visible'), 2000);
}

function createSectionHeader(titleText: string): { header: HTMLElement; feedback: HTMLElement } {
  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = titleText;
  const feedback = document.createElement('span');
  feedback.className = 'save-feedback';
  feedback.textContent = 'Gespeichert!';
  header.appendChild(title);
  header.appendChild(feedback);
  return { header, feedback };
}

function save(key: string, value: Record<string, unknown>): void {
  (getSarah().saveConfig as (c: Record<string, unknown>) => Promise<unknown>)({ [key]: value });
}

// ── Section: Profil ──

function createProfileSection(config: Config): HTMLElement {
  const profile = (config.profile || {}) as Record<string, string>;
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Profil');
  section.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'settings-grid';

  grid.appendChild(sarahInput({
    label: 'Anzeigename',
    value: profile.displayName || '',
    onChange: (val) => { profile.displayName = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahInput({
    label: 'Stadt',
    value: profile.city || '',
    onChange: (val) => { profile.city = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahInput({
    label: 'Beruf',
    value: profile.profession || '',
    onChange: (val) => { profile.profession = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahSelect({
    label: 'Antwort-Stil',
    options: [
      { value: 'kurz', label: 'Kurz & knapp' },
      { value: 'mittel', label: 'Ausgewogen' },
      { value: 'ausführlich', label: 'Ausführlich' },
    ],
    value: profile.responseStyle || 'mittel',
    onChange: (val) => { profile.responseStyle = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahSelect({
    label: 'Tonfall',
    options: [
      { value: 'freundlich', label: 'Freundlich' },
      { value: 'professionell', label: 'Professionell' },
      { value: 'locker', label: 'Locker' },
    ],
    value: profile.tone || 'freundlich',
    onChange: (val) => { profile.tone = val; save('profile', profile); showSaved(feedback); },
  }));

  section.appendChild(grid);
  return section;
}

// ── Section: Dateien & Ordner ──

const PDF_CATEGORY_OPTIONS = [
  { value: 'Gewerblich', label: 'Gewerblich', icon: '🏢' },
  { value: 'Steuern', label: 'Steuern', icon: '🧾' },
  { value: 'Präsentationen', label: 'Präsentationen', icon: '📊' },
  { value: 'Bewerbung', label: 'Bewerbung', icon: '📨' },
  { value: 'Zertifikate', label: 'Zertifikate', icon: '🏅' },
  { value: 'Verträge', label: 'Verträge', icon: '📝' },
  { value: 'Kontoauszüge', label: 'Kontoauszüge', icon: '🏦' },
];

const PDF_PLACEHOLDERS: Record<string, string> = {
  'Kontoauszüge': 'Bankname_MM_YY',
  'Bewerbung': 'Firmenname_Stelle',
  'Steuern': 'Jahr_Steuerart',
  'Verträge': 'Anbieter_Vertragsart',
  'Zertifikate': 'Aussteller_Thema_Jahr',
  'Gewerblich': 'Firma_Dokumenttyp',
  'Präsentationen': 'Thema_Datum',
};

interface PdfCategory {
  tag: string;
  folder: string;
  pattern: string;
  inferFromExisting: boolean;
}

function createPdfBlock(cat: PdfCategory, onUpdate: () => void): HTMLElement {
  const block = document.createElement('div');
  block.style.cssText = 'padding: var(--sarah-space-md); background: var(--sarah-bg-surface); border: 1px solid var(--sarah-border); border-radius: var(--sarah-radius-md); display: flex; flex-direction: column; gap: var(--sarah-space-sm);';
  block.dataset.pdfTag = cat.tag;

  const title = document.createElement('div');
  title.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-accent); font-weight: 500; letter-spacing: 0.03em;';
  title.textContent = cat.tag;
  block.appendChild(title);

  block.appendChild(sarahPathPicker({
    label: 'Ordner',
    placeholder: 'Ordner auswählen...',
    value: cat.folder,
    onChange: (value) => { cat.folder = value; onUpdate(); },
  }));

  block.appendChild(sarahInput({
    label: 'Benennungsschema (optional)',
    placeholder: PDF_PLACEHOLDERS[cat.tag] ?? 'Beschreibung_Datum',
    value: cat.pattern,
    onChange: (value) => { cat.pattern = value; onUpdate(); },
  }));

  block.appendChild(sarahToggle({
    label: 'An bestehenden Dateien orientieren',
    checked: cat.inferFromExisting,
    onChange: (value) => { cat.inferFromExisting = value; onUpdate(); },
  }));

  return block;
}

function createFilesSection(config: Config): HTMLElement {
  const resources = (config.resources || {}) as Record<string, unknown>;
  const skills = (config.skills || {}) as Record<string, unknown>;
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Dateien & Ordner');
  section.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'settings-grid';

  grid.appendChild(sarahPathPicker({
    label: 'Bilder-Ordner',
    placeholder: 'Bilder-Ordner...',
    value: (resources.picturesFolder as string) || '',
    onChange: (val) => { resources.picturesFolder = val; save('resources', resources); showSaved(feedback); },
  }));

  grid.appendChild(sarahPathPicker({
    label: 'Installations-Ordner',
    placeholder: 'Installations-Ordner...',
    value: (resources.installFolder as string) || '',
    onChange: (val) => { resources.installFolder = val; save('resources', resources); showSaved(feedback); },
  }));

  grid.appendChild(sarahPathPicker({
    label: 'Games-Ordner',
    placeholder: 'Games-Ordner...',
    value: (resources.gamesFolder as string) || '',
    onChange: (val) => { resources.gamesFolder = val; save('resources', resources); showSaved(feedback); },
  }));

  grid.appendChild(sarahPathPicker({
    label: 'Weitere Programme (Ordner)',
    placeholder: 'z.B. D:\\Programme...',
    value: (resources.extraProgramsFolder as string) || '',
    onChange: (val) => { resources.extraProgramsFolder = val; save('resources', resources); showSaved(feedback); },
  }));

  if (skills.programming) {
    grid.appendChild(sarahPathPicker({
      label: 'Projekte-Ordner',
      placeholder: 'Projekte-Ordner...',
      value: (skills.programmingProjectsFolder as string) || '',
      onChange: (val) => { skills.programmingProjectsFolder = val; save('skills', skills); showSaved(feedback); },
    }));
  }

  section.appendChild(grid);

  // PDF Categories
  const pdfCats: PdfCategory[] = (resources.pdfCategories as PdfCategory[]) || [];
  const pdfContainer = document.createElement('div');
  pdfContainer.style.cssText = 'display: flex; flex-direction: column; gap: var(--sarah-space-md); margin-top: var(--sarah-space-md);';

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

// ── Main export ──

export async function createSettingsView(): Promise<HTMLElement> {
  const container = document.createElement('div');

  const pageTitle = document.createElement('div');
  pageTitle.className = 'home-greeting';
  pageTitle.style.marginBottom = 'var(--sarah-space-xl)';
  pageTitle.textContent = 'Einstellungen';
  container.appendChild(pageTitle);

  const config = await (getSarah().getConfig as () => Promise<Config>)() as Config;

  container.appendChild(createProfileSection(config));
  container.appendChild(createFilesSection(config));

  // Wizard re-run button
  const wizardSection = document.createElement('div');
  wizardSection.className = 'settings-section';
  wizardSection.appendChild(sarahButton({
    label: 'Einrichtung erneut durchführen',
    variant: 'secondary',
    onClick: () => { window.location.href = 'wizard.html'; },
  }));
  container.appendChild(wizardSection);

  return container;
}

