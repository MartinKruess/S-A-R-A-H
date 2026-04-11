import { sarahInput } from '../../components/sarah-input.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahButton } from '../../components/sarah-button.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { applyAccentColor } from '../accent.js';
import type { SarahApi } from '../../../core/sarah-api.js';
import type { SarahConfig, PdfCategory, CustomCommand } from '../../../core/config-schema.js';

function getSarah(): SarahApi {
  return (window as any).__sarah as SarahApi;
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

function save(key: string, value: Partial<SarahConfig>[keyof SarahConfig]): void {
  getSarah().saveConfig({ [key]: value } as Partial<SarahConfig>);
}

// ── Section: Profil ──

function createProfileSection(config: SarahConfig): HTMLElement {
  const profile = { ...config.profile };
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
    onChange: (val) => { profile.responseStyle = val as typeof profile.responseStyle; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahSelect({
    label: 'Tonfall',
    options: [
      { value: 'freundlich', label: 'Freundlich' },
      { value: 'professionell', label: 'Professionell' },
      { value: 'locker', label: 'Locker' },
    ],
    value: profile.tone || 'freundlich',
    onChange: (val) => { profile.tone = val as typeof profile.tone; save('profile', profile); showSaved(feedback); },
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

function createFilesSection(config: SarahConfig): HTMLElement {
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

// ── Section: Vertrauen ──

const EXCLUSION_OPTIONS = [
  { value: 'Browser-Daten', label: 'Browser-Daten', icon: '🌐' },
  { value: 'Namen Dritter', label: 'Namen Dritter', icon: '👤' },
  { value: 'Gesundheit', label: 'Gesundheit', icon: '🏥' },
  { value: 'Finanzen', label: 'Finanzen', icon: '💰' },
];

function createTrustSection(config: SarahConfig): HTMLElement {
  const trust = { ...config.trust };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Vertrauen & Sicherheit');
  section.appendChild(header);

  const exclusionsWrapper = document.createElement('div');
  exclusionsWrapper.style.display = (trust.memoryAllowed !== false) ? 'block' : 'none';

  section.appendChild(sarahToggle({
    label: 'Erinnerungen erlauben',
    description: 'S.A.R.A.H. darf sich Dinge aus Gesprächen merken',
    checked: trust.memoryAllowed !== false,
    onChange: (val) => {
      trust.memoryAllowed = val;
      exclusionsWrapper.style.display = val ? 'block' : 'none';
      save('trust', trust);
      showSaved(feedback);
    },
  }));

  const memoryHint = document.createElement('div');
  memoryHint.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-muted); line-height: 1.4; padding: var(--sarah-space-xs) 0;';
  memoryHint.textContent = 'Sarah merkt sich dein Verhalten und Muster, aber niemals Passwörter, Bank- oder Versicherungsdaten.';
  section.appendChild(memoryHint);

  const exclusions = trust.memoryExclusions || [];
  exclusionsWrapper.appendChild(sarahTagSelect({
    label: 'Was soll Sarah sich nicht merken?',
    options: EXCLUSION_OPTIONS,
    selected: exclusions,
    allowCustom: true,
    onChange: (values) => { trust.memoryExclusions = values; save('trust', trust); showSaved(feedback); },
  }));
  section.appendChild(exclusionsWrapper);

  const spacer = document.createElement('div');
  spacer.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer);

  section.appendChild(sarahSelect({
    label: 'Dateizugriff',
    options: [
      { value: 'none', label: 'Kein Zugriff' },
      { value: 'specific-folders', label: 'Nur bestimmte Ordner' },
      { value: 'all', label: 'Alle Dateien' },
    ],
    value: trust.fileAccess || 'specific-folders',
    onChange: (val) => { trust.fileAccess = val as typeof trust.fileAccess; save('trust', trust); showSaved(feedback); },
  }));

  const spacer2 = document.createElement('div');
  spacer2.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer2);

  section.appendChild(sarahSelect({
    label: 'Bestätigungen',
    options: [
      { value: 'minimal', label: 'Minimal — nur bei kritischen Aktionen' },
      { value: 'standard', label: 'Standard — Sarah fragt wenn sinnvoll' },
      { value: 'maximal', label: 'Maximal — bei jeder verändernden Aktion' },
    ],
    value: trust.confirmationLevel || 'standard',
    onChange: (val) => { trust.confirmationLevel = val as typeof trust.confirmationLevel; save('trust', trust); showSaved(feedback); },
  }));

  return section;
}

// ── Section: Personalisierung ──

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

const TRAIT_OPTIONS = [
  { value: 'Humorvoll', label: 'Humorvoll', icon: '😄' },
  { value: 'Sarkastisch', label: 'Sarkastisch', icon: '😏' },
  { value: 'Schnippisch', label: 'Schnippisch', icon: '💅' },
  { value: 'Eifersüchtig', label: 'Eifersüchtig (auf andere KIs)', icon: '😤' },
  { value: 'Selbstsicher', label: 'Selbstsicher', icon: '💪' },
  { value: 'Unsicher', label: 'Unsicher/Schüchtern', icon: '🥺' },
];

const QUIRK_OPTIONS = [
  { value: '', label: 'Keine Eigenart' },
  { value: 'miauz', label: 'Miauz Genau!' },
  { value: 'gamertalk', label: 'Gamertalk' },
  { value: 'nerd', label: 'Prof. Dr. Dr.' },
  { value: 'oldschool', label: 'Oldschool' },
  { value: 'altertum', label: 'Altertum' },
  { value: 'pirat', label: 'Pirat' },
  { value: 'custom', label: 'Eigene...' },
];

function createPersonalizationSection(config: SarahConfig): HTMLElement {
  const pers = { ...config.personalization };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Personalisierung');
  section.appendChild(header);

  // Accent color picker
  const colorLabel = document.createElement('div');
  colorLabel.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-secondary); margin-bottom: var(--sarah-space-xs);';
  colorLabel.textContent = 'Akzentfarbe';
  section.appendChild(colorLabel);

  const colorGrid = document.createElement('div');
  colorGrid.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: var(--sarah-space-lg);';

  for (const color of ACCENT_COLORS) {
    const swatch = document.createElement('div');
    swatch.style.cssText = `width: 40px; height: 40px; border-radius: var(--sarah-radius-md); border: 2px solid transparent; cursor: pointer; transition: all var(--sarah-transition-fast); background-color: ${color.value};`;
    if (pers.accentColor === color.value) {
      swatch.style.borderColor = 'var(--sarah-text-primary)';
      swatch.style.boxShadow = `0 0 12px ${color.value}`;
    }
    swatch.title = color.label;
    swatch.addEventListener('click', () => {
      pers.accentColor = color.value;
      applyAccentColor(color.value);
      colorGrid.querySelectorAll('div').forEach(s => {
        (s as HTMLElement).style.borderColor = 'transparent';
        (s as HTMLElement).style.boxShadow = 'none';
      });
      swatch.style.borderColor = 'var(--sarah-text-primary)';
      swatch.style.boxShadow = `0 0 12px ${color.value}`;
      save('personalization', pers);
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
      { value: 'default-female-de', label: 'Standard (Deutsch, weiblich)' },
      { value: 'default-female-en', label: 'Standard (English, female)' },
      { value: 'warm-female-de', label: 'Warm (Deutsch, weiblich)' },
    ],
    value: pers.voice || 'default-female-de',
    onChange: (val) => { pers.voice = val; save('personalization', pers); showSaved(feedback); },
  }));

  grid.appendChild(sarahSelect({
    label: 'Sprechgeschwindigkeit',
    options: [
      { value: '0.8', label: 'Langsam' },
      { value: '1', label: 'Normal' },
      { value: '1.2', label: 'Schnell' },
    ],
    value: String(pers.speechRate ?? 1),
    onChange: (val) => { pers.speechRate = parseFloat(val); save('personalization', pers); showSaved(feedback); },
  }));

  grid.appendChild(sarahSelect({
    label: 'Chat-Schriftgröße',
    options: [
      { value: 'small', label: 'Klein' },
      { value: 'default', label: 'Standard' },
      { value: 'large', label: 'Groß' },
    ],
    value: pers.chatFontSize || 'default',
    onChange: (val) => { pers.chatFontSize = val as typeof pers.chatFontSize; save('personalization', pers); showSaved(feedback); },
  }));

  grid.appendChild(sarahSelect({
    label: 'Chat-Ausrichtung',
    options: [
      { value: 'stacked', label: 'Untereinander (wie ChatGPT)' },
      { value: 'bubbles', label: 'Bubbles (wie WhatsApp)' },
    ],
    value: pers.chatAlignment || 'stacked',
    onChange: (val) => { pers.chatAlignment = val as typeof pers.chatAlignment; save('personalization', pers); showSaved(feedback); },
  }));

  section.appendChild(grid);

  section.appendChild(sarahToggle({
    label: 'Smileys & Icons',
    description: 'Sarah darf Emojis in Antworten verwenden',
    checked: pers.emojisEnabled !== false,
    onChange: (val) => { pers.emojisEnabled = val; save('personalization', pers); showSaved(feedback); },
  }));

  const spacer = document.createElement('div');
  spacer.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer);

  section.appendChild(sarahSelect({
    label: 'Antwortmodus',
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'spontaneous', label: 'Spontan — kurz und direkt' },
      { value: 'thoughtful', label: 'Nachdenklich — gründlich und ausführlich' },
    ],
    value: pers.responseMode || 'normal',
    onChange: (val) => { pers.responseMode = val as typeof pers.responseMode; save('personalization', pers); showSaved(feedback); },
  }));

  const spacer2 = document.createElement('div');
  spacer2.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer2);

  // Character traits
  const traits = pers.characterTraits || [];
  const traitsSelect = sarahTagSelect({
    label: 'Charakter-Eigenschaften (max. 2)',
    options: TRAIT_OPTIONS,
    selected: traits,
    allowCustom: true,
    onChange: (values) => {
      if (values.length <= 2) {
        pers.characterTraits = values;
      } else {
        const trimmed = values.slice(-2);
        pers.characterTraits = trimmed;
        traitsSelect.setSelected(trimmed);
      }
      save('personalization', pers);
      showSaved(feedback);
    },
  });
  section.appendChild(traitsSelect);

  const spacer3 = document.createElement('div');
  spacer3.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer3);

  // Quirk
  const quirkWrapper = document.createElement('div');
  const customQuirkInput = sarahInput({
    label: 'Deine Eigenart',
    placeholder: 'z.B. Sage ab und zu "Wunderbar!" wenn etwas klappt',
    value: pers.quirk && !QUIRK_OPTIONS.some(q => q.value === pers.quirk) ? pers.quirk : '',
    onChange: (value) => { pers.quirk = value || 'custom'; save('personalization', pers); showSaved(feedback); },
  });
  customQuirkInput.style.display = pers.quirk === 'custom' || (pers.quirk && !QUIRK_OPTIONS.some(q => q.value === pers.quirk)) ? 'block' : 'none';
  customQuirkInput.style.marginTop = 'var(--sarah-space-sm)';

  const quirkHint = document.createElement('div');
  quirkHint.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-muted); margin-top: var(--sarah-space-xs); line-height: 1.4;';
  quirkHint.textContent = 'Beschreibe Sarahs Eigenart. Sexualisierte oder beleidigende Inhalte werden nicht akzeptiert.';
  quirkHint.style.display = customQuirkInput.style.display;

  quirkWrapper.appendChild(sarahSelect({
    label: 'Eigenart',
    options: QUIRK_OPTIONS,
    value: pers.quirk ?? '',
    onChange: (value) => {
      if (value === 'custom') {
        customQuirkInput.style.display = 'block';
        quirkHint.style.display = 'block';
        pers.quirk = 'custom';
      } else {
        customQuirkInput.style.display = 'none';
        quirkHint.style.display = 'none';
        pers.quirk = value || null;
      }
      save('personalization', pers);
      showSaved(feedback);
    },
  }));
  quirkWrapper.appendChild(customQuirkInput);
  quirkWrapper.appendChild(quirkHint);
  section.appendChild(quirkWrapper);

  return section;
}

// ── Section: Steuerung ──

const BUILTIN_COMMANDS = [
  { command: '/anonymous', description: 'Nachricht wird nach der Session vergessen' },
  { command: '/showcontext', description: 'Zeigt alles was Sarah über dich weiß' },
  { command: '/quietmode', description: 'Ruhemodus ein/aus' },
];

function createCommandRow(cmd: { command: string; description: string }, deletable: boolean, onDelete?: () => void): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display: flex; align-items: center; gap: var(--sarah-space-sm); padding: var(--sarah-space-xs) var(--sarah-space-sm); background: var(--sarah-bg-surface); border: 1px solid var(--sarah-border); border-radius: var(--sarah-radius-md);';

  const cmdLabel = document.createElement('span');
  cmdLabel.style.cssText = 'color: var(--sarah-accent); font-family: monospace; font-size: var(--sarah-font-size-sm); min-width: 120px;';
  cmdLabel.textContent = cmd.command;
  row.appendChild(cmdLabel);

  const desc = document.createElement('span');
  desc.style.cssText = 'flex: 1; font-size: var(--sarah-font-size-sm); color: var(--sarah-text-secondary);';
  desc.textContent = cmd.description;
  row.appendChild(desc);

  if (deletable && onDelete) {
    const delBtn = document.createElement('button');
    delBtn.style.cssText = 'background: none; border: none; color: var(--sarah-text-muted); cursor: pointer; font-size: var(--sarah-font-size-sm); padding: 2px 6px;';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', onDelete);
    row.appendChild(delBtn);
  }

  return row;
}

function createControlsSection(config: SarahConfig): HTMLElement {
  const controls = { ...config.controls };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Steuerung');
  section.appendChild(header);

  // Voice mode
  const voiceModeSelect = sarahSelect({
    label: 'Sprachsteuerung',
    options: [
      { value: 'off', label: 'Aus' },
      { value: 'push-to-talk', label: 'Push-to-Talk' },
    ],
    value: controls.voiceMode || 'off',
    onChange: (val) => {
      controls.voiceMode = val as typeof controls.voiceMode;
      hotkeyWrapper.style.display = (val === 'push-to-talk') ? '' : 'none';
      save('controls', controls);
      showSaved(feedback);
    },
  });
  section.appendChild(voiceModeSelect);

  // Push-to-Talk Taste (only visible in push-to-talk mode)
  const hotkeyWrapper = sarahInput({
    label: 'Push-to-Talk Taste',
    value: controls.pushToTalkKey || 'F9',
    placeholder: 'Taste drücken...',
  });
  hotkeyWrapper.style.display = (controls.voiceMode === 'push-to-talk') ? '' : 'none';

  // Configure hotkey capture via public API
  hotkeyWrapper.setReadOnly(true);
  const ALLOWED_KEYS = ['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'];
  hotkeyWrapper.onKeydown((e: KeyboardEvent) => {
    e.preventDefault();
    const key = e.key;
    if (!ALLOWED_KEYS.includes(key)) return;
    hotkeyWrapper.value = key;
    save('controls', { ...controls, pushToTalkKey: key });
    showSaved(feedback);
  });
  section.appendChild(hotkeyWrapper);

  const spacer = document.createElement('div');
  spacer.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer);

  // Quiet mode duration
  section.appendChild(sarahSelect({
    label: 'Ruhemodus-Dauer',
    options: [
      { value: '15', label: '15 Minuten' },
      { value: '30', label: '30 Minuten' },
      { value: '60', label: '60 Minuten' },
      { value: '120', label: '2 Stunden' },
    ],
    value: String(controls.quietModeDuration ?? 60),
    onChange: (val) => { controls.quietModeDuration = parseInt(val, 10); save('controls', controls); showSaved(feedback); },
  }));
  const quietHint = document.createElement('div');
  quietHint.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-muted); line-height: 1.4; padding: var(--sarah-space-xs) 0;';
  quietHint.textContent = 'Mit /quietmode aktivierst du den Ruhemodus. Sarah hört nicht zu und reagiert nicht, bis die Zeit abläuft oder du erneut /quietmode eingibst.';
  section.appendChild(quietHint);

  const spacer2 = document.createElement('div');
  spacer2.style.height = 'var(--sarah-space-lg)';
  section.appendChild(spacer2);

  // Slash Commands header
  const cmdTitle = document.createElement('div');
  cmdTitle.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-accent); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--sarah-space-sm);';
  cmdTitle.textContent = 'Slash-Commands';
  section.appendChild(cmdTitle);

  const cmdList = document.createElement('div');
  cmdList.style.cssText = 'display: flex; flex-direction: column; gap: var(--sarah-space-xs);';

  // Built-in commands
  for (const cmd of BUILTIN_COMMANDS) {
    cmdList.appendChild(createCommandRow(cmd, false));
  }

  // Custom commands
  const customCmds: CustomCommand[] = controls.customCommands || [];

  function renderCustomCommands(): void {
    cmdList.querySelectorAll('[data-custom-cmd]').forEach(el => el.remove());
    for (let i = 0; i < customCmds.length; i++) {
      const cmd = customCmds[i];
      const row = createCommandRow({ command: cmd.command, description: cmd.prompt }, true, () => {
        customCmds.splice(i, 1);
        controls.customCommands = customCmds;
        save('controls', controls);
        showSaved(feedback);
        renderCustomCommands();
      });
      row.dataset.customCmd = 'true';
      cmdList.appendChild(row);
    }
  }

  renderCustomCommands();
  section.appendChild(cmdList);

  // Add custom command
  const addArea = document.createElement('div');
  addArea.style.cssText = 'display: flex; gap: var(--sarah-space-sm); align-items: flex-end; margin-top: var(--sarah-space-md);';

  const cmdInput = sarahInput({
    label: 'Command',
    placeholder: '/meincommand',
  });
  cmdInput.style.flex = '0 0 140px';

  const promptInput = sarahInput({
    label: 'Prompt',
    placeholder: 'Was soll Sarah tun?',
  });
  promptInput.style.flex = '1';

  const addBtn = sarahButton({
    label: 'Hinzufügen',
    variant: 'secondary',
    onClick: () => {
      let cmd = cmdInput.value.trim();
      const prompt = promptInput.value.trim();
      if (!cmd || !prompt) return;
      if (!cmd.startsWith('/')) cmd = '/' + cmd;
      if (BUILTIN_COMMANDS.some(b => b.command === cmd)) return;
      if (customCmds.some(c => c.command === cmd)) return;
      customCmds.push({ command: cmd, prompt });
      controls.customCommands = customCmds;
      save('controls', controls);
      showSaved(feedback);
      cmdInput.value = '';
      promptInput.value = '';
      renderCustomCommands();
    },
  });

  addArea.appendChild(cmdInput);
  addArea.appendChild(promptInput);
  addArea.appendChild(addBtn);
  section.appendChild(addArea);

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

  const config = await getSarah().getConfig();

  container.appendChild(createProfileSection(config));
  container.appendChild(createFilesSection(config));
  container.appendChild(createTrustSection(config));
  container.appendChild(createPersonalizationSection(config));
  container.appendChild(createControlsSection(config));

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

