import { sarahInput } from '../../components/sarah-input.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahButton } from '../../components/sarah-button.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';
import { applyAccentColor } from '../accent.js';

function getSarah(): any {
  return (window as any).__sarah;
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

function createProfileSection(config: Record<string, any>): HTMLElement {
  const profile = config.profile || {};
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Profil');
  section.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'settings-grid';

  grid.appendChild(sarahInput({
    label: 'Anzeigename',
    value: profile.displayName || '',
    onChange: (val) => {
      profile.displayName = val;
      getSarah().saveConfig({ profile });
      showSaved(feedback);
    },
  }));

  grid.appendChild(sarahInput({
    label: 'Stadt',
    value: profile.city || '',
    onChange: (val) => {
      profile.city = val;
      getSarah().saveConfig({ profile });
      showSaved(feedback);
    },
  }));

  grid.appendChild(sarahInput({
    label: 'Beruf',
    value: profile.profession || '',
    onChange: (val) => {
      profile.profession = val;
      getSarah().saveConfig({ profile });
      showSaved(feedback);
    },
  }));

  grid.appendChild(sarahSelect({
    label: 'Antwort-Stil',
    options: [
      { value: 'kurz', label: 'Kurz & knapp' },
      { value: 'mittel', label: 'Ausgewogen' },
      { value: 'ausführlich', label: 'Ausführlich' },
    ],
    value: profile.responseStyle || 'mittel',
    onChange: (val) => {
      profile.responseStyle = val;
      getSarah().saveConfig({ profile });
      showSaved(feedback);
    },
  }));

  grid.appendChild(sarahSelect({
    label: 'Tonfall',
    options: [
      { value: 'freundlich', label: 'Freundlich' },
      { value: 'professionell', label: 'Professionell' },
      { value: 'locker', label: 'Locker' },
    ],
    value: profile.tone || 'freundlich',
    onChange: (val) => {
      profile.tone = val;
      getSarah().saveConfig({ profile });
      showSaved(feedback);
    },
  }));

  section.appendChild(grid);
  return section;
}

function createResourcesSection(config: Record<string, any>): HTMLElement {
  const resources = config.resources || {};
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Dateien & Ordner');
  section.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'settings-grid';

  grid.appendChild(sarahPathPicker({
    label: 'PDF-Ordner',
    placeholder: 'PDF-Ordner...',
    value: resources.pdfFolder || '',
    onChange: (val) => {
      resources.pdfFolder = val;
      getSarah().saveConfig({ resources });
      showSaved(feedback);
    },
  }));

  grid.appendChild(sarahPathPicker({
    label: 'Bilder-Ordner',
    placeholder: 'Bilder-Ordner...',
    value: resources.picturesFolder || '',
    onChange: (val) => {
      resources.picturesFolder = val;
      getSarah().saveConfig({ resources });
      showSaved(feedback);
    },
  }));

  grid.appendChild(sarahPathPicker({
    label: 'Installations-Ordner',
    placeholder: 'Installations-Ordner...',
    value: resources.installFolder || '',
    onChange: (val) => {
      resources.installFolder = val;
      getSarah().saveConfig({ resources });
      showSaved(feedback);
    },
  }));

  grid.appendChild(sarahPathPicker({
    label: 'Wichtige Ordner',
    placeholder: 'Ordner auswählen...',
    value: Array.isArray(resources.importantFolders) ? resources.importantFolders[0] || '' : '',
    onChange: (val) => {
      resources.importantFolders = [val];
      getSarah().saveConfig({ resources });
      showSaved(feedback);
    },
  }));

  section.appendChild(grid);
  return section;
}

function createTrustSection(config: Record<string, any>): HTMLElement {
  const trust = config.trust || {};
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Vertrauen & Sicherheit');
  section.appendChild(header);

  section.appendChild(sarahToggle({
    label: 'Erinnerungen erlauben',
    description: 'S.A.R.A.H. darf sich Dinge aus Gesprächen merken',
    checked: trust.memoryAllowed !== false,
    onChange: (val) => {
      trust.memoryAllowed = val;
      getSarah().saveConfig({ trust });
      showSaved(feedback);
    },
  }));

  const spacer = document.createElement('div');
  spacer.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer);

  section.appendChild(sarahSelect({
    label: 'Dateizugriff',
    options: [
      { value: 'none', label: 'Kein Zugriff' },
      { value: 'specific-folders', label: 'Nur bestimmte Ordner' },
      { value: 'full', label: 'Voller Zugriff' },
    ],
    value: trust.fileAccess || 'specific-folders',
    onChange: (val) => {
      trust.fileAccess = val;
      getSarah().saveConfig({ trust });
      showSaved(feedback);
    },
  }));

  return section;
}

const ACCENT_COLORS = [
  { value: '#00d4ff', label: 'Cyan' },
  { value: '#4466ff', label: 'Blau' },
  { value: '#8855ff', label: 'Violett' },
  { value: '#ff8844', label: 'Orange' },
  { value: '#44ff88', label: 'Grün' },
  { value: '#ff4488', label: 'Pink' },
  { value: '#ffcc00', label: 'Gold' },
  { value: '#ff5555', label: 'Rot' },
];

function createPersonalizationSection(config: Record<string, any>): HTMLElement {
  const personalization = config.personalization || {};
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Personalisierung');
  section.appendChild(header);

  // Accent color picker
  const colorLabel = document.createElement('div');
  colorLabel.className = 'settings-section-title';
  colorLabel.style.fontSize = 'var(--sarah-font-size-sm)';
  colorLabel.style.color = 'var(--sarah-text-secondary)';
  colorLabel.style.marginBottom = 'var(--sarah-space-xs)';
  colorLabel.textContent = 'Akzentfarbe';
  section.appendChild(colorLabel);

  const colorGrid = document.createElement('div');
  colorGrid.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: var(--sarah-space-lg);';

  for (const color of ACCENT_COLORS) {
    const swatch = document.createElement('div');
    swatch.style.cssText = `width: 40px; height: 40px; border-radius: var(--sarah-radius-md); border: 2px solid transparent; cursor: pointer; transition: all var(--sarah-transition-fast); background-color: ${color.value};`;
    if (personalization.accentColor === color.value) {
      swatch.style.borderColor = 'var(--sarah-text-primary)';
      swatch.style.boxShadow = `0 0 12px ${color.value}`;
    }
    swatch.title = color.label;
    swatch.addEventListener('click', () => {
      personalization.accentColor = color.value;
      applyAccentColor(color.value);
      colorGrid.querySelectorAll('div').forEach(s => {
        (s as HTMLElement).style.borderColor = 'transparent';
        (s as HTMLElement).style.boxShadow = 'none';
      });
      swatch.style.borderColor = 'var(--sarah-text-primary)';
      swatch.style.boxShadow = `0 0 12px ${color.value}`;
      getSarah().saveConfig({ personalization });
      showSaved(feedback);
    });
    colorGrid.appendChild(swatch);
  }
  section.appendChild(colorGrid);

  const grid = document.createElement('div');
  grid.className = 'settings-grid';

  grid.appendChild(sarahSelect({
    label: 'Stimme',
    options: [
      { value: 'default-female-de', label: 'Weiblich (Deutsch)' },
      { value: 'default-male-de', label: 'Männlich (Deutsch)' },
      { value: 'default-female-en', label: 'Female (English)' },
      { value: 'default-male-en', label: 'Male (English)' },
    ],
    value: personalization.voice || 'default-female-de',
    onChange: (val) => {
      personalization.voice = val;
      getSarah().saveConfig({ personalization });
      showSaved(feedback);
    },
  }));

  grid.appendChild(sarahSelect({
    label: 'Sprechgeschwindigkeit',
    options: [
      { value: '0.8', label: 'Langsam' },
      { value: '1', label: 'Normal' },
      { value: '1.2', label: 'Schnell' },
    ],
    value: String(personalization.speechRate ?? 1),
    onChange: (val) => {
      personalization.speechRate = parseFloat(val);
      getSarah().saveConfig({ personalization });
      showSaved(feedback);
    },
  }));

  section.appendChild(grid);
  return section;
}

export async function createSettingsView(): Promise<HTMLElement> {
  const container = document.createElement('div');

  const pageTitle = document.createElement('div');
  pageTitle.className = 'home-greeting';
  pageTitle.style.marginBottom = 'var(--sarah-space-xl)';
  pageTitle.textContent = 'Einstellungen';
  container.appendChild(pageTitle);

  const config = await getSarah().getConfig();

  container.appendChild(createProfileSection(config));
  container.appendChild(createResourcesSection(config));
  container.appendChild(createTrustSection(config));
  container.appendChild(createPersonalizationSection(config));

  // Wizard re-run button
  const wizardSection = document.createElement('div');
  wizardSection.className = 'settings-section';
  wizardSection.appendChild(sarahButton({
    label: 'Einrichtung erneut durchführen',
    variant: 'secondary',
    onClick: () => {
      window.location.href = 'wizard.html';
    },
  }));
  container.appendChild(wizardSection);

  return container;
}
