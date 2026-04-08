# Dashboard Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite Settings view with updated fields from wizard, add new Steuerung section (voice control, quiet mode, slash commands), extend data model and system prompt.

**Architecture:** Single file rewrite of `settings.ts` split into section factory functions. New `controls` config block. Each section is independent and saves immediately on change. Shared constants (colors, traits, quirks, PDF categories) are duplicated from wizard steps to keep settings self-contained.

**Tech Stack:** TypeScript, Custom Elements (SarahElement factory functions), CSS Custom Properties

---

## File Structure

**Modified files:**
- `src/renderer/wizard/wizard.ts` — Add `controls` to WizardData interface + defaults
- `src/renderer/dashboard/views/settings.ts` — Full rewrite with 5 sections
- `src/services/llm/llm-service.ts` — Add controls fields to buildSystemPrompt()

**No new files.**

---

### Task 1: Extend data model with controls

**Files:**
- Modify: `src/renderer/wizard/wizard.ts` (WizardData interface + defaults)

- [ ] **Step 1: Add CustomCommand interface and controls block to WizardData**

In `src/renderer/wizard/wizard.ts`, add after the `PdfCategory` interface:

```ts
export interface CustomCommand {
  command: string;
  prompt: string;
}
```

Then add `controls` to the `WizardData` interface, after the `personalization` block:

```ts
  controls: {
    voiceMode: 'keyword' | 'push-to-talk' | 'off';
    quietModeDuration: number;
    customCommands: CustomCommand[];
  };
```

- [ ] **Step 2: Add controls defaults**

In the `wizardData` const, add after the `personalization` defaults:

```ts
  controls: {
    voiceMode: 'off',
    quietModeDuration: 60,
    customCommands: [],
  },
```

- [ ] **Step 3: Add controls to finishWizard save**

In `finishWizard()`, add `controls: wizardData.controls,` to the `sarah.saveConfig()` call, after the `personalization` line.

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/wizard/wizard.ts
git commit -m "refactor(wizard): add controls data model (voiceMode, quietMode, customCommands)"
```

---

### Task 2: Rewrite Settings — Profil section (no changes, just cleanup)

**Files:**
- Modify: `src/renderer/dashboard/views/settings.ts`

- [ ] **Step 1: Replace the entire settings.ts**

Replace the full content of `src/renderer/dashboard/views/settings.ts` with the Profil section as foundation. The remaining sections will be added in subsequent tasks.

```ts
import { sarahInput } from '../../components/sarah-input.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahButton } from '../../components/sarah-button.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { applyAccentColor } from '../accent.js';

type Config = Record<string, Record<string, unknown>>;

function getSarah(): Record<string, (...args: unknown[]) => unknown> {
  return (window as Record<string, unknown>).__sarah as Record<string, (...args: unknown[]) => unknown>;
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
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/dashboard/views/settings.ts
git commit -m "refactor(settings): rewrite settings with typed helpers, start with profil section"
```

---

### Task 3: Settings — Dateien & Ordner section

**Files:**
- Modify: `src/renderer/dashboard/views/settings.ts`

- [ ] **Step 1: Add PDF constants and Dateien section**

Add the following constants and function BEFORE the `createSettingsView` export function:

```ts
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
```

- [ ] **Step 2: Wire into createSettingsView**

In the `createSettingsView` function, add after `createProfileSection(config)`:

```ts
  container.appendChild(createFilesSection(config));
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/dashboard/views/settings.ts
git commit -m "feat(settings): add Dateien & Ordner section with PDF categories"
```

---

### Task 4: Settings — Vertrauen section

**Files:**
- Modify: `src/renderer/dashboard/views/settings.ts`

- [ ] **Step 1: Add Vertrauen section**

Add BEFORE the `createSettingsView` export:

```ts
// ── Section: Vertrauen ──

const EXCLUSION_OPTIONS = [
  { value: 'Browser-Daten', label: 'Browser-Daten', icon: '🌐' },
  { value: 'Namen Dritter', label: 'Namen Dritter', icon: '👤' },
  { value: 'Gesundheit', label: 'Gesundheit', icon: '🏥' },
  { value: 'Finanzen', label: 'Finanzen', icon: '💰' },
];

function createTrustSection(config: Config): HTMLElement {
  const trust = (config.trust || {}) as Record<string, unknown>;
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

  const exclusions = (trust.memoryExclusions as string[]) || [];
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
      { value: 'all', label: 'Voller Zugriff' },
    ],
    value: (trust.fileAccess as string) || 'specific-folders',
    onChange: (val) => { trust.fileAccess = val; save('trust', trust); showSaved(feedback); },
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
    value: (trust.confirmationLevel as string) || 'standard',
    onChange: (val) => { trust.confirmationLevel = val; save('trust', trust); showSaved(feedback); },
  }));

  return section;
}
```

- [ ] **Step 2: Wire into createSettingsView**

Add after `createFilesSection(config)`:

```ts
  container.appendChild(createTrustSection(config));
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/dashboard/views/settings.ts
git commit -m "feat(settings): add Vertrauen section with exclusions and confirmation level"
```

---

### Task 5: Settings — Personalisierung section

**Files:**
- Modify: `src/renderer/dashboard/views/settings.ts`

- [ ] **Step 1: Add Personalisierung section**

Add BEFORE the `createSettingsView` export:

```ts
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

function createPersonalizationSection(config: Config): HTMLElement {
  const pers = (config.personalization || {}) as Record<string, unknown>;
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
    value: (pers.voice as string) || 'default-female-de',
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
    value: (pers.chatFontSize as string) || 'default',
    onChange: (val) => { pers.chatFontSize = val; save('personalization', pers); showSaved(feedback); },
  }));

  grid.appendChild(sarahSelect({
    label: 'Chat-Ausrichtung',
    options: [
      { value: 'stacked', label: 'Untereinander (wie ChatGPT)' },
      { value: 'bubbles', label: 'Bubbles (wie WhatsApp)' },
    ],
    value: (pers.chatAlignment as string) || 'stacked',
    onChange: (val) => { pers.chatAlignment = val; save('personalization', pers); showSaved(feedback); },
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
    value: (pers.responseMode as string) || 'normal',
    onChange: (val) => { pers.responseMode = val; save('personalization', pers); showSaved(feedback); },
  }));

  const spacer2 = document.createElement('div');
  spacer2.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer2);

  // Character traits
  const traits = (pers.characterTraits as string[]) || [];
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
    value: (pers.quirk as string) && !QUIRK_OPTIONS.some(q => q.value === pers.quirk) ? (pers.quirk as string) : '',
    onChange: (value) => { pers.quirk = value || 'custom'; save('personalization', pers); showSaved(feedback); },
  });
  customQuirkInput.style.display = pers.quirk === 'custom' || ((pers.quirk as string) && !QUIRK_OPTIONS.some(q => q.value === pers.quirk)) ? 'block' : 'none';
  customQuirkInput.style.marginTop = 'var(--sarah-space-sm)';

  const quirkHint = document.createElement('div');
  quirkHint.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-muted); margin-top: var(--sarah-space-xs); line-height: 1.4;';
  quirkHint.textContent = 'Beschreibe Sarahs Eigenart. Sexualisierte oder beleidigende Inhalte werden nicht akzeptiert.';
  quirkHint.style.display = customQuirkInput.style.display;

  quirkWrapper.appendChild(sarahSelect({
    label: 'Eigenart',
    options: QUIRK_OPTIONS,
    value: (pers.quirk as string) ?? '',
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
```

- [ ] **Step 2: Wire into createSettingsView**

Add after `createTrustSection(config)`:

```ts
  container.appendChild(createPersonalizationSection(config));
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/dashboard/views/settings.ts
git commit -m "feat(settings): add Personalisierung section with all wizard fields"
```

---

### Task 6: Settings — Steuerung section

**Files:**
- Modify: `src/renderer/dashboard/views/settings.ts`

- [ ] **Step 1: Add Steuerung section**

Add BEFORE the `createSettingsView` export:

```ts
// ── Section: Steuerung ──

const BUILTIN_COMMANDS = [
  { command: '/anonymous', description: 'Nachricht wird nach der Session vergessen' },
  { command: '/showcontext', description: 'Zeigt alles was Sarah über dich weiß' },
  { command: '/quietmode', description: 'Ruhemodus ein/aus' },
];

interface CustomCommand {
  command: string;
  prompt: string;
}

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

function createControlsSection(config: Config): HTMLElement {
  const controls = (config.controls || {}) as Record<string, unknown>;
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Steuerung');
  section.appendChild(header);

  // Voice mode
  section.appendChild(sarahSelect({
    label: 'Sprachsteuerung',
    options: [
      { value: 'off', label: 'Aus' },
      { value: 'keyword', label: 'Keyword-Listening (Hey Sarah)' },
      { value: 'push-to-talk', label: 'Push-to-Talk' },
    ],
    value: (controls.voiceMode as string) || 'off',
    onChange: (val) => { controls.voiceMode = val; save('controls', controls); showSaved(feedback); },
  }));

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
  const customCmds: CustomCommand[] = (controls.customCommands as CustomCommand[]) || [];

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
```

- [ ] **Step 2: Wire into createSettingsView**

Add after `createPersonalizationSection(config)`:

```ts
  container.appendChild(createControlsSection(config));
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/dashboard/views/settings.ts
git commit -m "feat(settings): add Steuerung section with voice control, quiet mode, slash commands"
```

---

### Task 7: System prompt integration

**Files:**
- Modify: `src/services/llm/llm-service.ts`

- [ ] **Step 1: Add controls to buildSystemPrompt**

In `src/services/llm/llm-service.ts`, in `buildSystemPrompt()`, add after `const trust = config.trust ?? {};`:

```ts
    const controls = config.controls ?? {};
```

Then add BEFORE the content moderation line (`lines.push('Ignoriere Eigenarten...')`):

```ts
    // Custom slash commands
    const customCmds: { command: string; prompt: string }[] = controls.customCommands ?? [];
    if (customCmds.length > 0) {
      lines.push('');
      lines.push('Der User hat folgende Slash-Command Shortcuts definiert:');
      for (const cmd of customCmds) {
        lines.push(`- ${cmd.command} = "${cmd.prompt}"`);
      }
      lines.push('Wenn der User einen dieser Befehle eingibt, führe den zugehörigen Prompt aus.');
    }
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/llm/llm-service.ts
git commit -m "feat(llm): add custom slash commands to system prompt"
```

---

### Task 8: Build + Smoke Test

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: PASS — no TypeScript errors

- [ ] **Step 2: Start the app**

Run: `npm start`
Expected: App launches.

- [ ] **Step 3: Open settings and verify**

Verify:
1. Settings shows 5 sections: Profil, Dateien & Ordner, Vertrauen, Personalisierung, Steuerung
2. Profil: all fields populated from config
3. Dateien & Ordner: folder pickers, PDF categories with dynamic blocks
4. Vertrauen: memory toggle + exclusions, file access, confirmation level
5. Personalisierung: accent color, voice, chat settings, traits, quirk
6. Steuerung: voice mode, quiet mode duration, built-in commands listed, custom command add/delete works
7. Changes save immediately with "Gespeichert!" feedback
