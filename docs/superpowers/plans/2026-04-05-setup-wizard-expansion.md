# Setup-Wizard Expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the existing 5-step wizard to 9 steps with full form fields from `docs/forms/setup-wizard-forms.md`, add 3 new components (tag-select, toggle, path-picker), add skip functionality for optional steps, extend system scan and IPC bridge.

**Architecture:** Extends the existing wizard orchestrator. New components follow the established Web Component + Factory pattern. WizardData interface expands to hold all new fields. The preload bridge gets new IPC channels for folder dialog and program detection.

**Tech Stack:** Same as base — TypeScript, Electron, Web Components, CSS Custom Properties, ES Modules.

**Spec:** `docs/superpowers/specs/2026-04-05-setup-wizard-design.md` (updated)

---

## File Structure (changes only)

```
src/renderer/
  components/
    sarah-tag-select.ts       ← NEW: clickable badges + custom input
    sarah-toggle.ts            ← NEW: on/off switch
    sarah-path-picker.ts       ← NEW: folder/file picker via Electron dialog
    index.ts                   ← MODIFY: register 3 new components

  wizard/
    wizard.ts                  ← MODIFY: 9 steps, expanded WizardData, skip logic, new nav
    steps/
      step-welcome.ts          ← EXISTING: no changes
      step-system-scan.ts      ← MODIFY: detect folders + installed programs
      step-required.ts         ← NEW: replaces step-profile.ts (name, city, usage purposes)
      step-personal.ts         ← NEW: optional personal info (skippable)
      step-dynamic.ts          ← NEW: conditional skill-level questions
      step-files.ts            ← NEW: optional files & programs (skippable)
      step-trust.ts            ← NEW: memory + file access permissions
      step-personalization.ts  ← EXISTING: no changes
      step-finish.ts           ← MODIFY: expanded summary with all new fields
      step-profile.ts          ← DELETE: replaced by step-required.ts

src/
  main.ts                      ← MODIFY: add folder dialog + program scan IPC
  preload.ts                   ← MODIFY: expose new IPC channels
```

---

## Task 1: New Component — sarah-tag-select

**Files:**
- Create: `src/renderer/components/sarah-tag-select.ts`

- [ ] **Step 1: Create the component**

```ts
import { SarahElement } from './base.js';

const CSS = `
  .tag-select-wrapper {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-sm);
    width: 100%;
  }

  label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    letter-spacing: 0.03em;
  }

  .tag-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sarah-space-sm);
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: var(--sarah-space-xs);
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    border-radius: var(--sarah-radius-lg);
    border: 1px solid var(--sarah-border);
    background: var(--sarah-bg-surface);
    color: var(--sarah-text-secondary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-sm);
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
    user-select: none;
  }

  .tag:hover {
    border-color: rgba(var(--sarah-accent-rgb), 0.3);
    color: var(--sarah-text-primary);
  }

  .tag.selected {
    border-color: var(--sarah-accent);
    background: rgba(var(--sarah-accent-rgb), 0.1);
    color: var(--sarah-accent);
    box-shadow: 0 0 10px var(--sarah-glow-subtle);
  }

  .tag-icon {
    font-size: 1rem;
  }

  .custom-tag {
    border-style: dashed;
  }

  .add-input-wrapper {
    display: flex;
    gap: var(--sarah-space-sm);
    margin-top: var(--sarah-space-xs);
  }

  .add-input {
    flex: 1;
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-primary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-sm);
    min-height: 36px;
  }

  .add-input:focus {
    outline: none;
    border-color: var(--sarah-accent);
    box-shadow: 0 0 8px var(--sarah-glow-subtle);
  }

  .add-input::placeholder {
    color: var(--sarah-text-muted);
  }

  .add-btn {
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-secondary);
    font-family: var(--sarah-font-family);
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
  }

  .add-btn:hover {
    border-color: var(--sarah-accent);
    color: var(--sarah-accent);
  }
`;

export interface TagOption {
  value: string;
  label: string;
  icon?: string;
}

export class SarahTagSelect extends SarahElement {
  private _options: TagOption[] = [];
  private _selected: Set<string> = new Set();
  private _allowCustom = false;
  private container!: HTMLElement;
  private tagGrid!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    this.container = document.createElement('div');
    this.container.className = 'tag-select-wrapper';

    const labelText = this.getAttribute('label');
    if (labelText) {
      const label = document.createElement('label');
      label.textContent = labelText;
      this.container.appendChild(label);
    }

    this.tagGrid = document.createElement('div');
    this.tagGrid.className = 'tag-grid';
    this.container.appendChild(this.tagGrid);

    this._allowCustom = this.hasAttribute('allow-custom');

    if (this._allowCustom) {
      const addWrapper = document.createElement('div');
      addWrapper.className = 'add-input-wrapper';

      const input = document.createElement('input');
      input.className = 'add-input';
      input.placeholder = 'Eigenen Bereich hinzufügen...';

      const addBtn = document.createElement('button');
      addBtn.className = 'add-btn';
      addBtn.textContent = '+';
      addBtn.addEventListener('click', () => {
        const val = input.value.trim();
        if (val && !this._options.some(o => o.value === val)) {
          this._options.push({ value: val, label: val });
          this._selected.add(val);
          this.renderTags();
          this.emitChange();
          input.value = '';
        }
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addBtn.click();
        }
      });

      addWrapper.appendChild(input);
      addWrapper.appendChild(addBtn);
      this.container.appendChild(addWrapper);
    }

    this.root.appendChild(this.container);
    this.renderTags();
  }

  setOptions(options: TagOption[]): void {
    this._options = options;
    if (this.tagGrid) this.renderTags();
  }

  setSelected(values: string[]): void {
    this._selected = new Set(values);
    if (this.tagGrid) this.renderTags();
  }

  getSelected(): string[] {
    return Array.from(this._selected);
  }

  private renderTags(): void {
    this.tagGrid.innerHTML = '';
    for (const opt of this._options) {
      const tag = document.createElement('div');
      tag.className = 'tag';
      if (this._selected.has(opt.value)) tag.classList.add('selected');

      if (opt.icon) {
        const icon = document.createElement('span');
        icon.className = 'tag-icon';
        icon.textContent = opt.icon;
        tag.appendChild(icon);
      }

      const text = document.createTextNode(opt.label);
      tag.appendChild(text);

      tag.addEventListener('click', () => {
        if (this._selected.has(opt.value)) {
          this._selected.delete(opt.value);
          tag.classList.remove('selected');
        } else {
          this._selected.add(opt.value);
          tag.classList.add('selected');
        }
        this.emitChange();
      });

      this.tagGrid.appendChild(tag);
    }
  }

  private emitChange(): void {
    this.dispatchEvent(new CustomEvent('change', {
      detail: { values: this.getSelected() },
      bubbles: true,
      composed: true,
    }));
  }
}

/** Factory function */
export function sarahTagSelect(props: {
  label?: string;
  options: TagOption[];
  selected?: string[];
  allowCustom?: boolean;
  onChange?: (values: string[]) => void;
}): SarahTagSelect {
  const el = document.createElement('sarah-tag-select') as SarahTagSelect;
  if (props.label) el.setAttribute('label', props.label);
  if (props.allowCustom) el.setAttribute('allow-custom', '');
  el.setOptions(props.options);
  if (props.selected) el.setSelected(props.selected);
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent) => {
      props.onChange!(e.detail.values);
    }) as EventListener);
  }
  return el;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/sarah-tag-select.ts
git commit -m "feat: add sarah-tag-select component — clickable badges with custom input"
```

---

## Task 2: New Component — sarah-toggle

**Files:**
- Create: `src/renderer/components/sarah-toggle.ts`

- [ ] **Step 1: Create the component**

```ts
import { SarahElement } from './base.js';

const CSS = `
  .toggle-wrapper {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sarah-space-md);
    width: 100%;
    cursor: pointer;
    user-select: none;
  }

  .toggle-label {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-primary);
  }

  .toggle-description {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    margin-top: 2px;
  }

  .toggle-track {
    width: 44px;
    height: 24px;
    border-radius: 12px;
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    position: relative;
    flex-shrink: 0;
    transition: all var(--sarah-transition-fast);
  }

  .toggle-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--sarah-text-muted);
    position: absolute;
    top: 2px;
    left: 2px;
    transition: all var(--sarah-transition-fast);
  }

  /* Active state */
  .toggle-wrapper.active .toggle-track {
    background: rgba(var(--sarah-accent-rgb), 0.2);
    border-color: var(--sarah-accent);
  }

  .toggle-wrapper.active .toggle-thumb {
    background: var(--sarah-accent);
    left: 22px;
    box-shadow: 0 0 8px var(--sarah-glow);
  }
`;

export class SarahToggle extends SarahElement {
  private _active = false;
  private wrapper!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'toggle-wrapper';
    if (this.hasAttribute('checked')) {
      this._active = true;
      this.wrapper.classList.add('active');
    }

    const labelArea = document.createElement('div');

    const labelText = this.getAttribute('label');
    if (labelText) {
      const label = document.createElement('div');
      label.className = 'toggle-label';
      label.textContent = labelText;
      labelArea.appendChild(label);
    }

    const desc = this.getAttribute('description');
    if (desc) {
      const descEl = document.createElement('div');
      descEl.className = 'toggle-description';
      descEl.textContent = desc;
      labelArea.appendChild(descEl);
    }

    const track = document.createElement('div');
    track.className = 'toggle-track';
    const thumb = document.createElement('div');
    thumb.className = 'toggle-thumb';
    track.appendChild(thumb);

    this.wrapper.appendChild(labelArea);
    this.wrapper.appendChild(track);

    this.wrapper.addEventListener('click', () => {
      this._active = !this._active;
      this.wrapper.classList.toggle('active', this._active);
      this.dispatchEvent(new CustomEvent('change', {
        detail: { value: this._active },
        bubbles: true,
        composed: true,
      }));
    });

    this.root.appendChild(this.wrapper);
  }

  get checked(): boolean {
    return this._active;
  }

  set checked(val: boolean) {
    this._active = val;
    if (this.wrapper) this.wrapper.classList.toggle('active', val);
  }
}

/** Factory function */
export function sarahToggle(props: {
  label?: string;
  description?: string;
  checked?: boolean;
  onChange?: (value: boolean) => void;
}): SarahToggle {
  const el = document.createElement('sarah-toggle') as SarahToggle;
  if (props.label) el.setAttribute('label', props.label);
  if (props.description) el.setAttribute('description', props.description);
  if (props.checked) el.setAttribute('checked', '');
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
```

- [ ] **Step 2: Verify build, commit**

```bash
git add src/renderer/components/sarah-toggle.ts
git commit -m "feat: add sarah-toggle component — on/off switch with glow"
```

---

## Task 3: New Component — sarah-path-picker + IPC

**Files:**
- Create: `src/renderer/components/sarah-path-picker.ts`
- Modify: `src/preload.ts` — add `selectFolder` IPC
- Modify: `src/main.ts` — add `dialog.showOpenDialog` handler

- [ ] **Step 1: Add IPC channel for folder selection**

In `src/preload.ts`, add to the `contextBridge.exposeInMainWorld` object:

```ts
selectFolder: (title?: string) => ipcRenderer.invoke('select-folder', title),
```

In `src/main.ts`, add this import at top:

```ts
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
```

(Replace the existing `import { app, BrowserWindow, ipcMain } from 'electron';`)

Add this handler inside `app.whenReady().then(...)`, after the existing handlers:

```ts
ipcMain.handle('select-folder', async (_event, title?: string) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: title ?? 'Ordner auswählen',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
```

- [ ] **Step 2: Create the path-picker component**

```ts
import { SarahElement } from './base.js';

function getSarah(): { selectFolder: (title?: string) => Promise<string | null> } {
  return (window as any).__sarah ?? (window as any).sarah;
}

const CSS = `
  .path-wrapper {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-xs);
    width: 100%;
  }

  label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    letter-spacing: 0.03em;
  }

  .path-row {
    display: flex;
    gap: var(--sarah-space-sm);
  }

  .path-display {
    flex: 1;
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-primary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-sm);
    min-height: 40px;
    display: flex;
    align-items: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path-display.empty {
    color: var(--sarah-text-muted);
  }

  .browse-btn {
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-secondary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-sm);
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
    white-space: nowrap;
  }

  .browse-btn:hover {
    border-color: var(--sarah-accent);
    color: var(--sarah-accent);
  }
`;

export class SarahPathPicker extends SarahElement {
  private _value = '';
  private pathDisplay!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const wrapper = document.createElement('div');
    wrapper.className = 'path-wrapper';

    const labelText = this.getAttribute('label');
    if (labelText) {
      const label = document.createElement('label');
      label.textContent = labelText;
      wrapper.appendChild(label);
    }

    const row = document.createElement('div');
    row.className = 'path-row';

    this.pathDisplay = document.createElement('div');
    this.pathDisplay.className = 'path-display empty';
    this.pathDisplay.textContent = this.getAttribute('placeholder') ?? 'Kein Ordner ausgewählt';

    const browseBtn = document.createElement('button');
    browseBtn.className = 'browse-btn';
    browseBtn.textContent = 'Durchsuchen';
    browseBtn.addEventListener('click', async () => {
      const folder = await getSarah().selectFolder(labelText ?? undefined);
      if (folder) {
        this._value = folder;
        this.pathDisplay.textContent = folder;
        this.pathDisplay.classList.remove('empty');
        this.dispatchEvent(new CustomEvent('change', {
          detail: { value: folder },
          bubbles: true,
          composed: true,
        }));
      }
    });

    // Pre-fill if value attribute set
    const presetValue = this.getAttribute('value');
    if (presetValue) {
      this._value = presetValue;
      this.pathDisplay.textContent = presetValue;
      this.pathDisplay.classList.remove('empty');
    }

    row.appendChild(this.pathDisplay);
    row.appendChild(browseBtn);
    wrapper.appendChild(row);
    this.root.appendChild(wrapper);
  }

  get value(): string {
    return this._value;
  }

  set value(v: string) {
    this._value = v;
    if (this.pathDisplay) {
      this.pathDisplay.textContent = v || this.getAttribute('placeholder') || 'Kein Ordner ausgewählt';
      this.pathDisplay.classList.toggle('empty', !v);
    }
  }
}

/** Factory function */
export function sarahPathPicker(props: {
  label?: string;
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
}): SarahPathPicker {
  const el = document.createElement('sarah-path-picker') as SarahPathPicker;
  if (props.label) el.setAttribute('label', props.label);
  if (props.placeholder) el.setAttribute('placeholder', props.placeholder);
  if (props.value) el.setAttribute('value', props.value);
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
```

- [ ] **Step 3: Verify build, commit**

```bash
git add src/renderer/components/sarah-path-picker.ts src/preload.ts src/main.ts
git commit -m "feat: add sarah-path-picker component with native folder dialog"
```

---

## Task 4: Register New Components + Extend System Scan IPC

**Files:**
- Modify: `src/renderer/components/index.ts` — register 3 new components
- Modify: `src/main.ts` — extend `get-system-info` to return folders + programs
- Modify: `src/preload.ts` — add `selectFolder` if not done in Task 3

- [ ] **Step 1: Update `index.ts`**

Add these imports at top:

```ts
import { SarahTagSelect } from './sarah-tag-select.js';
import { SarahToggle } from './sarah-toggle.js';
import { SarahPathPicker } from './sarah-path-picker.js';
```

Add these exports:

```ts
export { SarahTagSelect, sarahTagSelect } from './sarah-tag-select.js';
export type { TagOption } from './sarah-tag-select.js';
export { SarahToggle, sarahToggle } from './sarah-toggle.js';
export { SarahPathPicker, sarahPathPicker } from './sarah-path-picker.js';
```

Add to `registerComponents()`:

```ts
customElements.define('sarah-tag-select', SarahTagSelect);
customElements.define('sarah-toggle', SarahToggle);
customElements.define('sarah-path-picker', SarahPathPicker);
```

- [ ] **Step 2: Extend system-info IPC in `src/main.ts`**

Replace the `ipcMain.handle('get-system-info', ...)` handler with:

```ts
ipcMain.handle('get-system-info', async () => {
  const cpus = os.cpus();
  const homedir = os.homedir();

  return {
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: os.arch(),
    cpu: cpus.length > 0 ? cpus[0].model : 'Unknown',
    cpuCores: String(cpus.length),
    totalMemory: `${Math.round(os.totalmem() / (1024 ** 3))} GB`,
    freeMemory: `${Math.round(os.freemem() / (1024 ** 3))} GB`,
    hostname: os.hostname(),
    shell: process.env.SHELL || process.env.COMSPEC || 'Unknown',
    language: app.getLocale(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    folders: JSON.stringify({
      documents: path.join(homedir, 'Documents'),
      downloads: path.join(homedir, 'Downloads'),
      pictures: path.join(homedir, 'Pictures'),
      desktop: path.join(homedir, 'Desktop'),
    }),
  };
});
```

- [ ] **Step 3: Verify build, commit**

```bash
git add src/renderer/components/index.ts src/main.ts
git commit -m "feat: register new components, extend system scan with folders"
```

---

## Task 5: Rewrite Wizard Orchestrator

**Files:**
- Modify: `src/renderer/wizard/wizard.ts` — 9 steps, expanded WizardData, skip logic

- [ ] **Step 1: Rewrite `wizard.ts`**

Replace entire file with:

```ts
import { registerComponents } from '../components/index.js';
import { sarahStepper } from '../components/sarah-stepper.js';
import { sarahButton } from '../components/sarah-button.js';
import { createWelcomeStep } from './steps/step-welcome.js';
import { createSystemScanStep } from './steps/step-system-scan.js';
import { createRequiredStep } from './steps/step-required.js';
import { createPersonalStep } from './steps/step-personal.js';
import { createDynamicStep, hasDynamicQuestions } from './steps/step-dynamic.js';
import { createFilesStep } from './steps/step-files.js';
import { createTrustStep } from './steps/step-trust.js';
import { createPersonalizationStep } from './steps/step-personalization.js';
import { createFinishStep } from './steps/step-finish.js';

// Type declarations for preload bridge
declare const sarah: {
  version: string;
  splashDone: () => void;
  getSystemInfo: () => Promise<Record<string, string>>;
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  isFirstRun: () => Promise<boolean>;
  selectFolder: (title?: string) => Promise<string | null>;
};

// Make sarah available to step modules
(window as any).__sarah = sarah;

// Register all Web Components
registerComponents();

// Wizard state
export interface WizardData {
  system: Record<string, string>;
  profile: {
    displayName: string;
    city: string;
    usagePurposes: string[];
    lastName: string;
    address: string;
    hobbies: string[];
    profession: string;
    activities: string;
    responseStyle: string;
    tone: string;
  };
  skills: {
    programming: string | null;
    design: string | null;
    office: string | null;
  };
  files: {
    emails: string[];
    importantPrograms: string[];
    favoriteLinks: string[];
    importantFolders: string[];
    pdfFolder: string;
    picturesFolder: string;
    installFolder: string;
  };
  trust: {
    memoryAllowed: boolean;
    fileAccess: string;
  };
  personalization: {
    accentColor: string;
    voice: string;
    speechRate: number;
  };
  skippedSteps: Set<string>;
}

const wizardData: WizardData = {
  system: {},
  profile: {
    displayName: '',
    city: '',
    usagePurposes: [],
    lastName: '',
    address: '',
    hobbies: [],
    profession: '',
    activities: '',
    responseStyle: 'mittel',
    tone: 'freundlich',
  },
  skills: {
    programming: null,
    design: null,
    office: null,
  },
  files: {
    emails: [],
    importantPrograms: [],
    favoriteLinks: [],
    importantFolders: [],
    pdfFolder: '',
    picturesFolder: '',
    installFolder: '',
  },
  trust: {
    memoryAllowed: true,
    fileAccess: 'specific-folders',
  },
  personalization: {
    accentColor: '#00d4ff',
    voice: 'default-female-de',
    speechRate: 1.0,
  },
  skippedSteps: new Set(),
};

interface StepDef {
  id: string;
  label: string;
  optional: boolean;
  renderer: (data: WizardData) => HTMLElement;
  /** Return false to skip this step entirely */
  shouldShow?: (data: WizardData) => boolean;
}

const STEPS: StepDef[] = [
  { id: 'welcome', label: 'Willkommen', optional: false, renderer: createWelcomeStep },
  { id: 'system', label: 'System-Scan', optional: false, renderer: createSystemScanStep },
  { id: 'required', label: 'Pflichtfelder', optional: false, renderer: createRequiredStep },
  { id: 'personal', label: 'Persönliches', optional: true, renderer: createPersonalStep },
  {
    id: 'dynamic', label: 'Vertiefung', optional: false, renderer: createDynamicStep,
    shouldShow: (data) => hasDynamicQuestions(data),
  },
  { id: 'files', label: 'Dateien & Apps', optional: true, renderer: createFilesStep },
  { id: 'trust', label: 'Vertrauen', optional: false, renderer: createTrustStep },
  { id: 'personalization', label: 'Personalisierung', optional: false, renderer: createPersonalizationStep },
  { id: 'finish', label: 'Fertig', optional: false, renderer: createFinishStep },
];

let currentStep = 0;

// DOM references
const sidebar = document.getElementById('sidebar')!;
const slideArea = document.getElementById('slide-area')!;
const navArea = document.getElementById('nav-area')!;

// Create stepper (uses visible steps only)
function getVisibleSteps(): StepDef[] {
  return STEPS.filter(s => !s.shouldShow || s.shouldShow(wizardData));
}

let visibleSteps = getVisibleSteps();

const stepper = sarahStepper({
  steps: visibleSteps.map(s => ({ id: s.id, label: s.label })),
  activeIndex: 0,
  onStepClick: (index) => {
    if (index < currentStep) goToStep(index);
  },
});
sidebar.appendChild(stepper);

function refreshStepper(): void {
  visibleSteps = getVisibleSteps();
  stepper.setSteps(visibleSteps.map(s => ({ id: s.id, label: s.label })));
  stepper.setActive(currentStep);
}

// Navigation
function renderNav(): void {
  navArea.innerHTML = '';

  const step = visibleSteps[currentStep];

  if (currentStep > 0) {
    navArea.appendChild(sarahButton({
      label: 'Zurück',
      variant: 'secondary',
      onClick: () => goToStep(currentStep - 1),
    }));
  }

  // Spacer to push buttons right
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  navArea.appendChild(spacer);

  if (step.optional && currentStep < visibleSteps.length - 1) {
    navArea.appendChild(sarahButton({
      label: 'Überspringen',
      variant: 'ghost',
      onClick: () => {
        wizardData.skippedSteps.add(step.id);
        goToStep(currentStep + 1);
      },
    }));
  }

  if (currentStep < visibleSteps.length - 1) {
    const nextStep = visibleSteps[currentStep + 1];
    const nextLabel = step.optional
      ? `Weiter mit ${nextStep.label}`
      : 'Weiter';
    navArea.appendChild(sarahButton({
      label: nextLabel,
      variant: 'primary',
      onClick: () => goToStep(currentStep + 1),
    }));
  }

  if (currentStep === visibleSteps.length - 1) {
    navArea.appendChild(sarahButton({
      label: 'S.A.R.A.H. starten',
      variant: 'primary',
      onClick: finishWizard,
    }));
  }
}

function goToStep(index: number): void {
  currentStep = index;
  refreshStepper();
  renderStep();
  renderNav();
}

function renderStep(): void {
  slideArea.innerHTML = '';
  const step = visibleSteps[currentStep];
  const stepContent = step.renderer(wizardData);
  slideArea.appendChild(stepContent);
}

async function finishWizard(): Promise<void> {
  await sarah.saveConfig({
    setupComplete: true,
    system: wizardData.system,
    profile: {
      ...wizardData.profile,
      usagePurposes: wizardData.profile.usagePurposes,
      hobbies: wizardData.profile.hobbies,
    },
    skills: wizardData.skills,
    files: wizardData.files,
    trust: wizardData.trust,
    personalization: wizardData.personalization,
  });

  window.location.href = 'dashboard.html';
}

// Initialize
goToStep(0);
```

- [ ] **Step 2: Verify build** (will fail on missing step imports — expected)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/wizard.ts
git commit -m "feat: rewrite wizard orchestrator — 9 steps, skip logic, expanded data model"
```

---

## Task 6: New Step — Required Fields (replaces step-profile)

**Files:**
- Create: `src/renderer/wizard/steps/step-required.ts`
- Delete: `src/renderer/wizard/steps/step-profile.ts`

- [ ] **Step 1: Create `step-required.ts`**

```ts
import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahInput } from '../../components/sarah-input.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';

const USAGE_OPTIONS = [
  { value: 'Dateien', label: 'Dateien', icon: '📁' },
  { value: 'Organisation', label: 'Organisation', icon: '📋' },
  { value: 'Programmieren', label: 'Programmieren', icon: '💻' },
  { value: 'Design', label: 'Design / Bildbearbeitung', icon: '🎨' },
  { value: 'E-Mail', label: 'E-Mail', icon: '📧' },
  { value: 'Web', label: 'Web / Recherche', icon: '🌐' },
  { value: 'Office', label: 'Office', icon: '📊' },
  { value: 'Gaming', label: 'Gaming', icon: '🎮' },
];

export function createRequiredStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const form = sarahForm({
    title: 'Die Basics',
    description: 'Diese Infos brauche ich, damit ich direkt loslegen kann.',
    children: [
      sarahInput({
        label: 'Wie soll ich dich nennen?',
        placeholder: 'Dein Name',
        required: true,
        value: data.profile.displayName,
        onChange: (value) => { data.profile.displayName = value; },
      }),
      sarahInput({
        label: 'In welcher Stadt bist du?',
        placeholder: 'z.B. Hamburg',
        required: true,
        value: data.profile.city,
        onChange: (value) => { data.profile.city = value; },
      }),
      sarahTagSelect({
        label: 'Wobei soll ich dir helfen?',
        options: USAGE_OPTIONS,
        selected: data.profile.usagePurposes,
        allowCustom: true,
        onChange: (values) => { data.profile.usagePurposes = values; },
      }),
    ],
  });

  container.appendChild(form);
  return container;
}
```

- [ ] **Step 2: Delete `step-profile.ts`**

```bash
rm src/renderer/wizard/steps/step-profile.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/steps/step-required.ts
git rm src/renderer/wizard/steps/step-profile.ts
git commit -m "feat: add required fields step, replace old profile step"
```

---

## Task 7: New Step — Personal (Optional)

**Files:**
- Create: `src/renderer/wizard/steps/step-personal.ts`

- [ ] **Step 1: Create the step**

```ts
import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahInput } from '../../components/sarah-input.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';

const HOBBY_OPTIONS = [
  { value: 'Fitness', label: 'Fitness', icon: '💪' },
  { value: 'Coding', label: 'Coding', icon: '💻' },
  { value: 'Musik', label: 'Musik', icon: '🎵' },
  { value: 'Gaming', label: 'Gaming', icon: '🎮' },
  { value: 'Kochen', label: 'Kochen', icon: '🍳' },
  { value: 'Lesen', label: 'Lesen', icon: '📚' },
  { value: 'Reisen', label: 'Reisen', icon: '✈️' },
  { value: 'Fotografie', label: 'Fotografie', icon: '📷' },
];

export function createPersonalStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const form = sarahForm({
    title: 'Persönliches',
    description: 'Ich kann dich besser unterstützen, wenn ich mehr über dich weiß. Du kannst diesen Schritt auch überspringen.',
    children: [
      sarahInput({
        label: 'Möchtest du deinen Nachnamen angeben?',
        placeholder: 'Nachname',
        value: data.profile.lastName,
        onChange: (value) => { data.profile.lastName = value; },
      }),
      sarahInput({
        label: 'Möchtest du deine Adresse speichern?',
        placeholder: 'Straße, Nr.',
        value: data.profile.address,
        onChange: (value) => { data.profile.address = value; },
      }),
      sarahTagSelect({
        label: 'Was sind deine Interessen?',
        options: HOBBY_OPTIONS,
        selected: data.profile.hobbies,
        allowCustom: true,
        onChange: (values) => { data.profile.hobbies = values; },
      }),
      sarahInput({
        label: 'Was machst du beruflich?',
        placeholder: 'z.B. Entwickler',
        value: data.profile.profession,
        onChange: (value) => { data.profile.profession = value; },
      }),
      sarahInput({
        label: 'Was machst du häufig?',
        placeholder: 'z.B. Rechnungen, Planung',
        value: data.profile.activities,
        onChange: (value) => { data.profile.activities = value; },
      }),
      sarahSelect({
        label: 'Wie soll ich antworten?',
        options: [
          { value: 'kurz', label: 'Kurz & knapp' },
          { value: 'mittel', label: 'Normal' },
          { value: 'ausführlich', label: 'Ausführlich' },
        ],
        value: data.profile.responseStyle,
        onChange: (value) => { data.profile.responseStyle = value; },
      }),
      sarahSelect({
        label: 'Wie soll ich klingen?',
        options: [
          { value: 'direkt', label: 'Direkt' },
          { value: 'freundlich', label: 'Freundlich' },
          { value: 'professionell', label: 'Professionell' },
        ],
        value: data.profile.tone,
        onChange: (value) => { data.profile.tone = value; },
      }),
    ],
  });

  container.appendChild(form);
  return container;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/wizard/steps/step-personal.ts
git commit -m "feat: add optional personal info step"
```

---

## Task 8: New Step — Dynamic Questions

**Files:**
- Create: `src/renderer/wizard/steps/step-dynamic.ts`

- [ ] **Step 1: Create the step**

```ts
import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahSelect } from '../../components/sarah-select.js';

const SKILL_LEVELS = [
  { value: 'Anfänger', label: 'Anfänger' },
  { value: 'Mittel', label: 'Mittel' },
  { value: 'Fortgeschritten', label: 'Fortgeschritten' },
  { value: 'Profi', label: 'Profi' },
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

/** Check if any dynamic questions apply based on selected usage purposes */
export function hasDynamicQuestions(data: WizardData): boolean {
  return DYNAMIC_QUESTIONS.some(q => data.profile.usagePurposes.includes(q.purposeKey));
}

export function createDynamicStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');
  const relevant = DYNAMIC_QUESTIONS.filter(q => data.profile.usagePurposes.includes(q.purposeKey));

  const children: HTMLElement[] = relevant.map(q => {
    return sarahSelect({
      label: q.question,
      options: SKILL_LEVELS,
      value: data.skills[q.skillKey] ?? 'Mittel',
      onChange: (value) => { data.skills[q.skillKey] = value; },
    });
  });

  const form = sarahForm({
    title: 'Vertiefung',
    description: 'Damit ich meine Antworten besser an dein Level anpassen kann.',
    children,
  });

  container.appendChild(form);
  return container;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/wizard/steps/step-dynamic.ts
git commit -m "feat: add dynamic skill-level questions step"
```

---

## Task 9: New Step — Files & Programs (Optional)

**Files:**
- Create: `src/renderer/wizard/steps/step-files.ts`

- [ ] **Step 1: Create the step**

```ts
import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';

const PROGRAM_OPTIONS = [
  { value: 'VS Code', label: 'VS Code', icon: '💻' },
  { value: 'Chrome', label: 'Chrome', icon: '🌐' },
  { value: 'Firefox', label: 'Firefox', icon: '🦊' },
  { value: 'Word', label: 'Word', icon: '📝' },
  { value: 'Excel', label: 'Excel', icon: '📊' },
  { value: 'Outlook', label: 'Outlook', icon: '📧' },
  { value: 'Slack', label: 'Slack', icon: '💬' },
  { value: 'Discord', label: 'Discord', icon: '🎮' },
  { value: 'Spotify', label: 'Spotify', icon: '🎵' },
  { value: 'Photoshop', label: 'Photoshop', icon: '🎨' },
];

export function createFilesStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  // Try to pre-fill from system scan
  let detectedFolders: Record<string, string> = {};
  try {
    if (data.system.folders) {
      detectedFolders = JSON.parse(data.system.folders);
    }
  } catch {}

  const form = sarahForm({
    title: 'Dateien & Programme',
    description: 'Damit ich dir besser helfen kann, zeig mir wo deine wichtigen Dateien liegen. Du kannst das auch später einstellen.',
    children: [
      sarahTagSelect({
        label: 'Welche Programme nutzt du oft?',
        options: PROGRAM_OPTIONS,
        selected: data.files.importantPrograms,
        allowCustom: true,
        onChange: (values) => { data.files.importantPrograms = values; },
      }),
      sarahPathPicker({
        label: 'Wichtige Ordner',
        placeholder: 'Ordner auswählen...',
        value: data.files.importantFolders[0] ?? '',
        onChange: (value) => { data.files.importantFolders = [value]; },
      }),
      sarahPathPicker({
        label: 'Wo speicherst du PDFs?',
        placeholder: 'PDF-Ordner...',
        value: data.files.pdfFolder,
        onChange: (value) => { data.files.pdfFolder = value; },
      }),
      sarahPathPicker({
        label: 'Wo liegen deine Bilder?',
        placeholder: detectedFolders.pictures || 'Bilder-Ordner...',
        value: data.files.picturesFolder || detectedFolders.pictures || '',
        onChange: (value) => { data.files.picturesFolder = value; },
      }),
      sarahPathPicker({
        label: 'Wo installierst du Programme?',
        placeholder: 'Installations-Ordner...',
        value: data.files.installFolder,
        onChange: (value) => { data.files.installFolder = value; },
      }),
    ],
  });

  container.appendChild(form);
  return container;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/wizard/steps/step-files.ts
git commit -m "feat: add optional files & programs step with path pickers"
```

---

## Task 10: New Step — Trust & Control

**Files:**
- Create: `src/renderer/wizard/steps/step-trust.ts`

- [ ] **Step 1: Create the step**

```ts
import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahSelect } from '../../components/sarah-select.js';

const TRUST_CSS = `
  .trust-notice {
    padding: var(--sarah-space-md) var(--sarah-space-lg);
    background: rgba(var(--sarah-accent-rgb), 0.05);
    border: 1px solid rgba(var(--sarah-accent-rgb), 0.15);
    border-radius: var(--sarah-radius-md);
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    line-height: 1.5;
  }

  .trust-notice strong {
    color: var(--sarah-accent);
  }
`;

export function createTrustStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = TRUST_CSS;
  container.appendChild(style);

  const notice = document.createElement('div');
  notice.className = 'trust-notice';
  notice.innerHTML = '<strong>🔒 Datenschutz:</strong> Alle Daten werden ausschließlich lokal auf deinem Computer gespeichert. Nichts wird ins Internet gesendet.';

  const form = sarahForm({
    title: 'Vertrauen & Kontrolle',
    description: 'Lege fest, was S.A.R.A.H. darf und was nicht.',
    children: [
      notice,
      sarahToggle({
        label: 'Darf ich mir Dinge merken?',
        description: 'Sarah lernt aus Gesprächen und merkt sich Präferenzen',
        checked: data.trust.memoryAllowed,
        onChange: (value) => { data.trust.memoryAllowed = value; },
      }),
      sarahSelect({
        label: 'Darf ich Dateien analysieren?',
        options: [
          { value: 'all', label: 'Ja, alle Dateien' },
          { value: 'specific-folders', label: 'Nur bestimmte Ordner' },
          { value: 'none', label: 'Nein, keinen Zugriff' },
        ],
        value: data.trust.fileAccess,
        onChange: (value) => { data.trust.fileAccess = value; },
      }),
    ],
  });

  container.appendChild(form);
  return container;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/wizard/steps/step-trust.ts
git commit -m "feat: add trust & control step with memory toggle and file access"
```

---

## Task 11: Update Finish Step

**Files:**
- Modify: `src/renderer/wizard/steps/step-finish.ts`

- [ ] **Step 1: Rewrite finish step to show all new fields**

Replace entire file. The summary should group by section and show skipped steps as "Nicht konfiguriert — kannst du jederzeit in den Einstellungen nachholen".

```ts
import type { WizardData } from '../wizard.js';

const FINISH_CSS = `
  .finish {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sarah-space-lg);
    max-width: 550px;
    text-align: center;
    overflow-y: auto;
    max-height: 100%;
  }

  .finish-title {
    font-size: var(--sarah-font-size-xl);
    font-weight: 300;
    color: var(--sarah-text-primary);
    letter-spacing: 0.05em;
  }

  .finish-text {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-secondary);
    line-height: 1.5;
  }

  .summary-section {
    width: 100%;
    text-align: left;
  }

  .summary-heading {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: var(--sarah-space-sm);
    margin-top: var(--sarah-space-md);
  }

  .summary {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-xs);
    padding: var(--sarah-space-md) var(--sarah-space-lg);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-lg);
  }

  .summary-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--sarah-space-xs) 0;
  }

  .summary-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
  }

  .summary-value {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-primary);
    text-align: right;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .summary-skipped {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    font-style: italic;
    padding: var(--sarah-space-sm) var(--sarah-space-lg);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-lg);
    width: 100%;
    text-align: left;
  }

  .accent-preview {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: inline-block;
    vertical-align: middle;
    margin-left: var(--sarah-space-sm);
    box-shadow: 0 0 6px currentColor;
  }
`;

export function createFinishStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = FINISH_CSS;
  container.appendChild(style);

  const finish = document.createElement('div');
  finish.className = 'finish';

  const title = document.createElement('div');
  title.className = 'finish-title';
  title.textContent = 'Alles bereit!';

  const text = document.createElement('div');
  text.className = 'finish-text';
  text.textContent = 'Hier ist eine Zusammenfassung deiner Einstellungen.';

  finish.appendChild(title);
  finish.appendChild(text);

  // Required fields
  addSection(finish, 'Pflichtfelder', [
    ['Name', data.profile.displayName || '—'],
    ['Stadt', data.profile.city || '—'],
    ['Verwendungszwecke', data.profile.usagePurposes.join(', ') || '—'],
  ]);

  // Personal (optional)
  if (data.skippedSteps.has('personal')) {
    addSkipped(finish, 'Persönliches', 'Übersprungen — kannst du jederzeit in den Einstellungen nachholen');
  } else {
    addSection(finish, 'Persönliches', [
      ['Beruf', data.profile.profession || '—'],
      ['Hobbys', data.profile.hobbies.join(', ') || '—'],
      ['Antwortstil', data.profile.responseStyle],
      ['Tonfall', data.profile.tone],
    ]);
  }

  // Skills
  const skillRows: [string, string][] = [];
  if (data.skills.programming) skillRows.push(['Programmieren', data.skills.programming]);
  if (data.skills.design) skillRows.push(['Design', data.skills.design]);
  if (data.skills.office) skillRows.push(['Office', data.skills.office]);
  if (skillRows.length > 0) addSection(finish, 'Skill-Level', skillRows);

  // Files (optional)
  if (data.skippedSteps.has('files')) {
    addSkipped(finish, 'Dateien & Programme', 'Übersprungen — kannst du jederzeit in den Einstellungen nachholen');
  } else {
    addSection(finish, 'Dateien & Programme', [
      ['Programme', data.files.importantPrograms.join(', ') || '—'],
      ['PDF-Ordner', data.files.pdfFolder || '—'],
      ['Bilder', data.files.picturesFolder || '—'],
    ]);
  }

  // Trust
  addSection(finish, 'Vertrauen', [
    ['Memory', data.trust.memoryAllowed ? 'Erlaubt' : 'Nicht erlaubt'],
    ['Dateizugriff', data.trust.fileAccess],
  ]);

  // Personalization
  const colorRow = document.createElement('div');
  colorRow.className = 'summary-row';
  const colorLabel = document.createElement('span');
  colorLabel.className = 'summary-label';
  colorLabel.textContent = 'Akzentfarbe';
  const colorValue = document.createElement('span');
  colorValue.className = 'summary-value';
  colorValue.textContent = data.personalization.accentColor;
  const colorDot = document.createElement('span');
  colorDot.className = 'accent-preview';
  colorDot.style.backgroundColor = data.personalization.accentColor;
  colorDot.style.color = data.personalization.accentColor;
  colorValue.appendChild(colorDot);

  const persSection = document.createElement('div');
  persSection.className = 'summary-section';
  const persHeading = document.createElement('div');
  persHeading.className = 'summary-heading';
  persHeading.textContent = 'Personalisierung';
  const persSummary = document.createElement('div');
  persSummary.className = 'summary';
  colorRow.appendChild(colorLabel);
  colorRow.appendChild(colorValue);
  persSummary.appendChild(colorRow);
  persSection.appendChild(persHeading);
  persSection.appendChild(persSummary);
  finish.appendChild(persSection);

  // System
  addSection(finish, 'System', [
    ['OS', data.system.os || '—'],
    ['CPU', data.system.cpu || '—'],
    ['RAM', data.system.totalMemory || '—'],
  ]);

  container.appendChild(finish);
  return container;
}

function addSection(parent: HTMLElement, heading: string, rows: [string, string][]): void {
  const section = document.createElement('div');
  section.className = 'summary-section';

  const h = document.createElement('div');
  h.className = 'summary-heading';
  h.textContent = heading;
  section.appendChild(h);

  const summary = document.createElement('div');
  summary.className = 'summary';

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const l = document.createElement('span');
    l.className = 'summary-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'summary-value';
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    summary.appendChild(row);
  }

  section.appendChild(summary);
  parent.appendChild(section);
}

function addSkipped(parent: HTMLElement, heading: string, message: string): void {
  const section = document.createElement('div');
  section.className = 'summary-section';
  const h = document.createElement('div');
  h.className = 'summary-heading';
  h.textContent = heading;
  const skipped = document.createElement('div');
  skipped.className = 'summary-skipped';
  skipped.textContent = message;
  section.appendChild(h);
  section.appendChild(skipped);
  parent.appendChild(section);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/wizard/steps/step-finish.ts
git commit -m "feat: update finish step with expanded summary for all wizard sections"
```

---

## Task 12: Integration — Build, Test, Polish

**Files:**
- All modified files

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean compile, no errors.

- [ ] **Step 2: Delete stale config to test fresh wizard**

```bash
# Find and delete existing config to simulate first run
# On Windows: %APPDATA%/s-a-r-a-h/config.json
```

- [ ] **Step 3: Manual test — run the app**

Run: `npm start`
Walk through all 9 steps:
1. Welcome — animated intro
2. System Scan — progress bar, cards with folder info
3. Required — name, city, tag-select for purposes
4. Personal (optional) — skip button visible, form with hobbys/beruf/style
5. Dynamic — only shows if Programmieren/Design/Office selected
6. Files (optional) — path pickers, program tags
7. Trust — toggle for memory, select for file access
8. Personalization — color swatches, voice
9. Finish — grouped summary, skipped sections shown

- [ ] **Step 4: Test skip functionality**

Skip "Persönliches" and "Dateien & Programme". Verify:
- Stepper shows them as passed
- Finish step shows "Übersprungen" messages
- Config still saves correctly

- [ ] **Step 5: Test second launch**

Run: `npm start` again.
Expected: After splash → dashboard (not wizard).

- [ ] **Step 6: Fix any issues**

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete expanded setup wizard — 9 steps with full form fields"
```
