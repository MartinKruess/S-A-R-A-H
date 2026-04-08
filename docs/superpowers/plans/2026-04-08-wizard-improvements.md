# Wizard Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wizard bekommt erweiterte Programmier-Vertiefung (Techstack, Anlaufstellen, Projekte-Ordner), tag-basierte PDF-Kategorisierung mit dynamischen Blöcken, und ein responsive Desktop-Layout (80% Breite, 2-spaltig ab 600px).

**Architecture:** Datenmodell-Erweiterungen in `wizard.ts`, neue UI-Felder in bestehenden Steps, responsive CSS in `sarah-form`. Kein neuer Step, keine neuen Dateien — alles Erweiterungen bestehender Dateien.

**Tech Stack:** TypeScript, Custom Elements (SarahElement), CSS Custom Properties

---

## File Structure

**Modified files:**
- `src/renderer/wizard/wizard.ts` — WizardData-Interface + Defaults + finishWizard
- `src/renderer/wizard/steps/step-dynamic.ts` — Techstack, Resources, Projekte-Ordner
- `src/renderer/wizard/steps/step-files.ts` — PDF-Kategorisierung, Ordner-Grid, entferne importantFolders
- `src/renderer/wizard/steps/step-finish.ts` — Zusammenfassung anpassen
- `src/renderer/components/sarah-form.ts` — Responsive 80% max-width

**No new files.**

---

### Task 1: Datenmodell-Erweiterungen in wizard.ts

**Files:**
- Modify: `src/renderer/wizard/wizard.ts:22-35` (ProgramEntry + declare)
- Modify: `src/renderer/wizard/wizard.ts:42-82` (WizardData interface)
- Modify: `src/renderer/wizard/wizard.ts:84-115` (wizardData defaults)

- [ ] **Step 1: Add PdfCategory type and extend WizardData interface**

In `src/renderer/wizard/wizard.ts`, add the exported `PdfCategory` interface after `ProgramEntry`, extend `skills` with new fields, replace `pdfFolder` + `importantFolders` with `pdfCategories` in `resources`:

```ts
// After the ProgramEntry interface, add:
export interface PdfCategory {
  tag: string;
  folder: string;
  pattern: string;
  inferFromExisting: boolean;
}
```

In the `WizardData` interface, update `skills`:

```ts
skills: {
  programming: string | null;
  programmingStack: string[];
  programmingResources: string[];
  programmingProjectsFolder: string;
  design: string | null;
  office: string | null;
};
```

In the `WizardData` interface, update `resources` — remove `pdfFolder`, `importantFolders`, add `pdfCategories`:

```ts
resources: {
  emails: string[];
  programs: ProgramEntry[];
  favoriteLinks: string[];
  pdfCategories: PdfCategory[];
  picturesFolder: string;
  installFolder: string;
  gamesFolder: string;
  extraProgramsFolder: string;
};
```

- [ ] **Step 2: Update wizardData defaults**

Update the `wizardData` const to match the new interface:

```ts
skills: {
  programming: null,
  programmingStack: [],
  programmingResources: ['Stack Overflow', 'GitHub', 'MDN'],
  programmingProjectsFolder: '',
  design: null,
  office: null,
},
resources: {
  emails: [],
  programs: [],
  favoriteLinks: [],
  pdfCategories: [],
  picturesFolder: '',
  installFolder: '',
  gamesFolder: '',
  extraProgramsFolder: '',
},
```

- [ ] **Step 3: Update finishWizard config mapping**

In `finishWizard()`, add `context7: true` when Programmieren is selected:

```ts
async function finishWizard(): Promise<void> {
  const useContext7 = wizardData.profile.usagePurposes.includes('Programmieren');

  await sarah.saveConfig({
    onboarding: {
      setupComplete: true,
    },
    system: wizardData.system,
    profile: {
      ...wizardData.profile,
      usagePurposes: wizardData.profile.usagePurposes,
      hobbies: wizardData.profile.hobbies,
    },
    skills: wizardData.skills,
    resources: wizardData.resources,
    trust: wizardData.trust,
    personalization: wizardData.personalization,
    integrations: {
      context7: useContext7,
    },
  });

  window.location.href = 'dashboard.html';
}
```

- [ ] **Step 4: Build and verify no compile errors**

Run: `npm run build`
Expected: No TypeScript errors (step-files.ts and step-finish.ts will error — that's expected, we fix them in later tasks)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/wizard/wizard.ts
git commit -m "refactor(wizard): extend data model with programmingStack, pdfCategories, context7"
```

---

### Task 2: Responsive Layout in sarah-form

**Files:**
- Modify: `src/renderer/components/sarah-form.ts:2-30` (CSS)

- [ ] **Step 1: Update sarah-form CSS for responsive layout**

Replace the CSS const in `src/renderer/components/sarah-form.ts`:

```ts
const CSS = `
  .form-wrapper {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-lg);
    width: 100%;
    max-width: 720px;
  }

  @media (min-width: 600px) {
    .form-wrapper {
      max-width: 80%;
      margin: 0 auto;
    }
  }

  .form-title {
    font-size: var(--sarah-font-size-lg);
    color: var(--sarah-text-primary);
    font-weight: 400;
    letter-spacing: 0.02em;
  }

  .form-description {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-secondary);
    line-height: 1.5;
  }

  .form-fields {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--sarah-space-md);
  }
`;
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS — no errors, forms now use 80% width on desktop

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/sarah-form.ts
git commit -m "style(form): responsive 80% max-width on desktop (≥600px)"
```

---

### Task 3: Dynamic-Step — Programmier-Vertiefung

**Files:**
- Modify: `src/renderer/wizard/steps/step-dynamic.ts` (entire file)

- [ ] **Step 1: Rewrite step-dynamic.ts with Techstack, Resources, and Projects folder**

Replace the entire content of `src/renderer/wizard/steps/step-dynamic.ts`:

```ts
import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';

const SKILL_LEVELS = [
  { value: 'Anfänger', label: 'Anfänger' },
  { value: 'Mittel', label: 'Mittel' },
  { value: 'Fortgeschritten', label: 'Fortgeschritten' },
  { value: 'Profi', label: 'Profi' },
];

const TECHSTACK_OPTIONS = [
  { value: 'JavaScript', label: 'JavaScript', icon: '🟨' },
  { value: 'TypeScript', label: 'TypeScript', icon: '🔷' },
  { value: 'Python', label: 'Python', icon: '🐍' },
  { value: 'C#', label: 'C#', icon: '🟪' },
  { value: 'Java', label: 'Java', icon: '☕' },
  { value: 'Rust', label: 'Rust', icon: '🦀' },
  { value: 'Go', label: 'Go', icon: '🔵' },
  { value: 'PHP', label: 'PHP', icon: '🐘' },
  { value: 'C++', label: 'C++', icon: '⚙️' },
  { value: 'Swift', label: 'Swift', icon: '🍎' },
  { value: 'Kotlin', label: 'Kotlin', icon: '🟣' },
  { value: 'Ruby', label: 'Ruby', icon: '💎' },
  { value: 'HTML/CSS', label: 'HTML/CSS', icon: '🌐' },
  { value: 'SQL', label: 'SQL', icon: '🗄️' },
  { value: 'React', label: 'React', icon: '⚛️' },
  { value: 'Angular', label: 'Angular', icon: '🅰️' },
  { value: 'Vue', label: 'Vue', icon: '🟢' },
  { value: 'Node.js', label: 'Node.js', icon: '🟩' },
  { value: '.NET', label: '.NET', icon: '🟦' },
  { value: 'Django', label: 'Django', icon: '🎸' },
  { value: 'Spring', label: 'Spring', icon: '🌱' },
];

const RESOURCE_OPTIONS = [
  { value: 'Stack Overflow', label: 'Stack Overflow', icon: '📋' },
  { value: 'GitHub', label: 'GitHub', icon: '🐙' },
  { value: 'MDN', label: 'MDN', icon: '📖' },
  { value: 'Reddit', label: 'Reddit', icon: '🤖' },
  { value: 'Dev.to', label: 'Dev.to', icon: '✍️' },
  { value: 'W3Schools', label: 'W3Schools', icon: '🏫' },
  { value: 'Medium', label: 'Medium', icon: '📰' },
];

interface DynamicQuestion {
  purposeKey: string;
  skillKey: keyof WizardData['skills'];
  question: string;
}

const DYNAMIC_QUESTIONS: DynamicQuestion[] = [
  { purposeKey: 'Programmieren', skillKey: 'programming', question: 'Wie ist dein Level im Programmieren?' },
  { purposeKey: 'Design', skillKey: 'design', question: 'Wie gut kennst du dich mit Design / Bildbearbeitung aus?' },
  { purposeKey: 'Office', skillKey: 'office', question: 'Wie sicher bist du mit Office?' },
];

export function hasDynamicQuestions(data: WizardData): boolean {
  return DYNAMIC_QUESTIONS.some(q => data.profile.usagePurposes.includes(q.purposeKey));
}

export function createDynamicStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');
  const relevant = DYNAMIC_QUESTIONS.filter(q => data.profile.usagePurposes.includes(q.purposeKey));
  const showProgramming = data.profile.usagePurposes.includes('Programmieren');

  const children: HTMLElement[] = relevant.map(q => {
    return sarahSelect({
      label: q.question,
      options: SKILL_LEVELS,
      value: (data.skills[q.skillKey] as string) ?? 'Mittel',
      onChange: (value) => { (data.skills[q.skillKey] as string | null) = value; },
    });
  });

  // Programming-specific fields
  if (showProgramming) {
    children.push(
      sarahTagSelect({
        label: 'Dein Techstack',
        options: TECHSTACK_OPTIONS,
        selected: data.skills.programmingStack,
        allowCustom: true,
        onChange: (values) => { data.skills.programmingStack = values; },
      }),
      sarahTagSelect({
        label: 'Wo suchst du nach Lösungen?',
        options: RESOURCE_OPTIONS,
        selected: data.skills.programmingResources,
        allowCustom: true,
        onChange: (values) => { data.skills.programmingResources = values; },
      }),
      sarahPathPicker({
        label: 'Wo liegen deine Projekte?',
        placeholder: 'z.B. D:\\projects oder ~/dev',
        value: data.skills.programmingProjectsFolder,
        onChange: (value) => { data.skills.programmingProjectsFolder = value; },
      }),
    );
  }

  const form = sarahForm({
    title: 'Vertiefung',
    description: 'Damit ich meine Antworten besser an dein Level anpassen kann.',
    children,
  });

  container.appendChild(form);
  return container;
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS for step-dynamic.ts (step-files.ts and step-finish.ts may still error)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/steps/step-dynamic.ts
git commit -m "feat(wizard): add techstack, resources, projects folder to programming deepening"
```

---

### Task 4: Files-Step — PDF-Kategorisierung + Grid-Layout

**Files:**
- Modify: `src/renderer/wizard/steps/step-files.ts` (entire file)

- [ ] **Step 1: Rewrite step-files.ts with PDF categories and folder grid**

Replace the entire content of `src/renderer/wizard/steps/step-files.ts`:

```ts
import type { WizardData, ProgramEntry, ProgramType, PdfCategory } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';
import { sarahInput } from '../../components/sarah-input.js';
import { sarahToggle } from '../../components/sarah-toggle.js';

function getSarah(): any {
  return (window as any).__sarah;
}

interface DetectedProgram {
  path: string;
  type: ProgramType;
  verified: boolean;
  aliases: string[];
  duplicateGroup?: string;
}

/** Maps program name → detected metadata */
const detectedProgramMap = new Map<string, DetectedProgram>();

const KNOWN_ICONS: Record<string, string> = {
  'visual studio code': '💻',
  'vs code': '💻',
  'google chrome': '🌐',
  'chrome': '🌐',
  'mozilla firefox': '🦊',
  'firefox': '🦊',
  'microsoft word': '📝',
  'word': '📝',
  'microsoft excel': '📊',
  'excel': '📊',
  'microsoft outlook': '📧',
  'outlook': '📧',
  'slack': '💬',
  'discord': '🎮',
  'spotify': '🎵',
  'adobe photoshop': '🎨',
  'photoshop': '🎨',
  'steam': '🎮',
  'notepad++': '📝',
  'git': '🔧',
  '7-zip': '📦',
  'vlc': '🎬',
  'obs studio': '🎥',
  'telegram': '💬',
  'whatsapp': '💬',
  'zoom': '📹',
  'microsoft teams': '📹',
  'davinci': '🎬',
  'resolve': '🎬',
  'blender': '🎨',
  'gimp': '🎨',
  'audacity': '🎵',
  'opera': '🌐',
  'brave': '🌐',
  'edge': '🌐',
  'filezilla': '📂',
  'postman': '🔧',
  'docker': '🐳',
  'after effects': '🎬',
  'premiere': '🎬',
  'illustrator': '🎨',
  'lightroom': '📷',
  'acrobat': '📄',
};

function getIcon(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(KNOWN_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '📦';
}

/** Reference to the tag-select element so folder scans can inject options */
let tagSelectEl: ReturnType<typeof sarahTagSelect> | null = null;
let currentOptions: { value: string; label: string; icon: string }[] = [];
let currentSelected: string[] = [];

function syncTagSelect(data: WizardData): void {
  if (!tagSelectEl) return;
  tagSelectEl.setOptions(currentOptions);
  tagSelectEl.setSelected(currentSelected);
}

function addScannedPrograms(
  programs: { name: string; path: string; type: ProgramType; verified: boolean; aliases: string[]; duplicateGroup?: string }[],
  data: WizardData,
): void {
  for (const prog of programs) {
    if (!detectedProgramMap.has(prog.name)) {
      detectedProgramMap.set(prog.name, {
        path: prog.path,
        type: prog.type,
        verified: prog.verified,
        aliases: prog.aliases,
        duplicateGroup: prog.duplicateGroup,
      });
      const warning = prog.type === 'updater' ? ' ⚠️ Updater' : prog.type === 'launcher' ? ' ⚠️ Launcher' : '';
      currentOptions.push({ value: prog.name, label: prog.name + warning, icon: getIcon(prog.name) });
    }
  }
  syncTagSelect(data);
}

function buildProgramEntry(name: string): ProgramEntry {
  const detected = detectedProgramMap.get(name);
  if (detected) {
    return {
      name,
      path: detected.path,
      type: detected.type,
      source: 'detected',
      verified: detected.verified,
      aliases: detected.aliases,
      duplicateGroup: detected.duplicateGroup,
    };
  }
  return { name, path: '', type: 'exe', source: 'manual', verified: false, aliases: [] };
}

// --- PDF Category constants ---

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

function createPdfBlock(tag: string, data: WizardData): HTMLElement {
  const cat = findCategory(data, tag);

  const block = document.createElement('div');
  block.className = 'pdf-block';
  block.dataset.pdfTag = tag;

  const title = document.createElement('div');
  title.className = 'pdf-block-title';
  title.textContent = tag;
  block.appendChild(title);

  block.appendChild(sarahPathPicker({
    label: 'Ordner',
    placeholder: 'Ordner auswählen...',
    value: cat.folder,
    onChange: (value) => { cat.folder = value; },
  }));

  block.appendChild(sarahInput({
    label: 'Benennungsschema (optional)',
    placeholder: PDF_PLACEHOLDERS[tag] ?? 'Beschreibung_Datum',
    value: cat.pattern,
    onChange: (value) => { cat.pattern = value; },
  }));

  block.appendChild(sarahToggle({
    label: 'An bestehenden Dateien orientieren',
    checked: cat.inferFromExisting,
    onChange: (value) => { cat.inferFromExisting = value; },
  }));

  return block;
}

export function createFilesStep(data: WizardData): HTMLElement {
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
        getSarah().scanFolderExes(value).then((programs: any[]) => {
          scanStatus.textContent = programs.length > 0
            ? `${programs.length} Programme gefunden in ${value}`
            : 'Keine Programme gefunden';
          addScannedPrograms(programs, data);
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
          getSarah().scanFolderExes(value).then((programs: any[]) => {
            scanStatus.textContent = programs.length > 0
              ? `${programs.length} Games gefunden in ${value}`
              : 'Keine Games gefunden';
            addScannedPrograms(programs, data);
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
    pdfBlocksContainer.appendChild(createPdfBlock(cat.tag, data));
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
            pdfBlocksContainer.appendChild(createPdfBlock(tag, data));
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
  currentSelected = data.resources.programs.map(p => p.name);

  getSarah().detectPrograms().then((programs: { name: string; path: string; type: ProgramType; verified: boolean; aliases: string[]; duplicateGroup?: string }[]) => {
    for (const prog of programs) {
      detectedProgramMap.set(prog.name, {
        path: prog.path,
        type: prog.type,
        verified: prog.verified,
        aliases: prog.aliases,
        duplicateGroup: prog.duplicateGroup,
      });
    }

    currentOptions = programs.map(prog => {
      const warning = prog.type === 'updater' ? ' ⚠️ Updater' : prog.type === 'launcher' ? ' ⚠️ Launcher' : '';
      return {
        value: prog.name,
        label: prog.name + warning,
        icon: getIcon(prog.name),
      };
    });

    tagSelectEl = sarahTagSelect({
      label: 'Welche Programme nutzt du oft?',
      options: currentOptions,
      selected: currentSelected,
      allowCustom: true,
      onChange: (values) => {
        currentSelected = values;
        data.resources.programs = values.map(buildProgramEntry);
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
        data.resources.programs = values.map(buildProgramEntry);
      },
    });
    programsPlaceholder.replaceWith(tagSelectEl);
  });

  return container;
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: step-files.ts compiles (step-finish.ts may still error)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/steps/step-files.ts
git commit -m "feat(wizard): add PDF categorization with dynamic blocks, folder grid layout"
```

---

### Task 5: Finish-Step — Zusammenfassung anpassen

**Files:**
- Modify: `src/renderer/wizard/steps/step-finish.ts:139-157` (files section)
- Modify: `src/renderer/wizard/steps/step-finish.ts:139-143` (skills section)

- [ ] **Step 1: Update finish step for new data model**

In `src/renderer/wizard/steps/step-finish.ts`, update the skills section to show programmingStack:

Replace the skills block (lines ~139-143):

```ts
  // Skills
  const skillRows: [string, string][] = [];
  if (data.skills.programming) skillRows.push(['Programmieren', data.skills.programming]);
  if (data.skills.programmingStack.length > 0) skillRows.push(['Techstack', data.skills.programmingStack.join(', ')]);
  if (data.skills.programmingResources.length > 0) skillRows.push(['Anlaufstellen', data.skills.programmingResources.join(', ')]);
  if (data.skills.programmingProjectsFolder) skillRows.push(['Projekte-Ordner', data.skills.programmingProjectsFolder]);
  if (data.skills.design) skillRows.push(['Design', data.skills.design]);
  if (data.skills.office) skillRows.push(['Office', data.skills.office]);
  if (skillRows.length > 0) addSection(finish, 'Skill-Level', skillRows);
```

Replace the files section (the `else` branch for files, lines ~148-157):

```ts
  // Files (optional)
  if (data.skippedSteps.has('files')) {
    addSkipped(finish, 'Dateien & Programme', 'Übersprungen — kannst du jederzeit in den Einstellungen nachholen');
  } else {
    const fileRows: [string, string][] = [
      ['Programme', data.resources.programs.map(p => p.name).join(', ') || '—'],
      ['Bilder', data.resources.picturesFolder || '—'],
    ];
    if (data.resources.extraProgramsFolder) fileRows.push(['Programm-Ordner', data.resources.extraProgramsFolder]);
    if (data.resources.gamesFolder) fileRows.push(['Games-Ordner', data.resources.gamesFolder]);
    if (data.resources.pdfCategories.length > 0) {
      fileRows.push(['PDF-Kategorien', data.resources.pdfCategories.map(c => c.tag).join(', ')]);
    }
    addSection(finish, 'Dateien & Programme', fileRows);
  }
```

- [ ] **Step 2: Build and verify no compile errors**

Run: `npm run build`
Expected: PASS — all files compile

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/steps/step-finish.ts
git commit -m "feat(wizard): update finish summary for programmingStack and pdfCategories"
```

---

### Task 6: Build + Smoke Test

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: PASS — no TypeScript errors

- [ ] **Step 2: Start the app**

Run: `npm start`
Expected: App launches. If first-run, wizard shows.

- [ ] **Step 3: Walk through wizard**

Verify:
1. Welcome → System-Scan → Pflichtfelder: select "Programmieren" as usage purpose
2. Vertiefung: Level-Select + Techstack tags + Anlaufstellen tags (SO/GitHub/MDN pre-selected) + Projekte-Ordner picker all visible
3. Dateien & Apps: Program tag-select loads, folder grid is 2-col on desktop, PDF tag-select shows categories, selecting a tag creates a block with folder picker + pattern input + toggle
4. Fertig: Summary shows Techstack, Anlaufstellen, PDF-Kategorien

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(wizard): wizard improvements - programming deepening, PDF categorization, responsive layout"
```
