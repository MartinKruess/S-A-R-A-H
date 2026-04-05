# Setup-Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first-run Setup-Wizard with 5 steps (Welcome, System-Scan, Profile, Personalization, Finish), a custom Web Component system, and Jarvis-inspired dark UI.

**Architecture:** Dual-tsconfig Electron app — `tsconfig.json` for main/preload (CommonJS, Node), `tsconfig.renderer.json` for browser code (ES modules, DOM). Web Components with Shadow DOM for style encapsulation, CSS custom properties for theming (pierce Shadow DOM). Config stored as JSON in Electron's `userData` path.

**Tech Stack:** TypeScript, Electron, Web Components (Custom Elements + Shadow DOM), CSS Custom Properties, ES Modules in renderer.

**Spec:** `docs/superpowers/specs/2026-04-05-setup-wizard-design.md`

---

## File Structure

```
styles/
  theme.css                          ← CSS custom properties (colors, spacing, radii, transitions)
  base.css                           ← Reset, fonts, global body styles
  components.css                     ← Shared component utility styles (imported by components)
  wizard.css                         ← Wizard-specific layout (stepper, slides)

src/
  main.ts                            ← MODIFY: add config check, wizard vs dashboard routing
  preload.ts                         ← MODIFY: expose system-info + config IPC channels
  splash.ts                          ← EXISTING: no changes

  renderer/
    components/
      base.ts                        ← Base class + factory helper
      sarah-button.ts                ← Button component (primary, secondary, ghost)
      sarah-input.ts                 ← Text input with label + validation
      sarah-select.ts                ← Dropdown select
      sarah-form.ts                  ← Form wrapper with fieldset + layout
      sarah-stepper.ts               ← Vertical timeline stepper
      sarah-slide.ts                 ← Fullscreen slide container
      sarah-card.ts                  ← Info card (system scan results)
      sarah-progress.ts              ← Progress bar (animated)
      index.ts                       ← Re-exports all components + registers custom elements

    wizard/
      wizard.ts                      ← Wizard orchestrator (step management, navigation)
      steps/
        step-welcome.ts              ← Step 1: Sarah intro animation
        step-system-scan.ts          ← Step 2: auto-detect system info
        step-profile.ts              ← Step 3: name, city, language, timezone
        step-personalization.ts      ← Step 4: accent color, voice
        step-finish.ts               ← Step 5: summary + save config

wizard.html                          ← Wizard HTML entry point

tsconfig.renderer.json               ← Renderer tsconfig (ES modules, DOM)
```

---

## Task 1: Build Infrastructure

**Files:**
- Create: `tsconfig.renderer.json`
- Create: `styles/theme.css`
- Create: `styles/base.css`
- Create: `styles/wizard.css`
- Modify: `package.json` (build scripts)

- [ ] **Step 1: Create `tsconfig.renderer.json`**

```json
{
  "compilerOptions": {
    "rootDir": "./src/renderer",
    "outDir": "./dist/renderer",
    "module": "ES2022",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "moduleResolution": "node",
    "declaration": false
  },
  "include": ["src/renderer/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Update build scripts in `package.json`**

Change the `scripts` section:

```json
{
  "scripts": {
    "build": "tsc && tsc -p tsconfig.renderer.json",
    "start": "npm run build && electron .",
    "dev": "concurrently \"tsc --watch\" \"tsc -p tsconfig.renderer.json --watch\" \"electron .\""
  }
}
```

- [ ] **Step 3: Create `styles/theme.css`**

```css
:root {
  /* Background */
  --sarah-bg-primary: #0a0a1a;
  --sarah-bg-secondary: #12122a;
  --sarah-bg-surface: rgba(255, 255, 255, 0.03);
  --sarah-bg-surface-hover: rgba(255, 255, 255, 0.06);

  /* Text */
  --sarah-text-primary: #e8e8f0;
  --sarah-text-secondary: #a0a0b8;
  --sarah-text-muted: #555566;

  /* Accent */
  --sarah-accent: #00d4ff;
  --sarah-accent-rgb: 0, 212, 255;
  --sarah-accent-hover: #33ddff;
  --sarah-accent-blue: #4466ff;
  --sarah-accent-violet: #8855ff;
  --sarah-accent-orange: #ff8844;

  /* Glow */
  --sarah-glow: rgba(var(--sarah-accent-rgb), 0.3);
  --sarah-glow-strong: rgba(var(--sarah-accent-rgb), 0.5);
  --sarah-glow-subtle: rgba(var(--sarah-accent-rgb), 0.1);

  /* Borders */
  --sarah-border: rgba(255, 255, 255, 0.08);
  --sarah-border-focus: var(--sarah-accent);

  /* Spacing */
  --sarah-space-xs: 4px;
  --sarah-space-sm: 8px;
  --sarah-space-md: 16px;
  --sarah-space-lg: 24px;
  --sarah-space-xl: 48px;

  /* Radii */
  --sarah-radius-sm: 4px;
  --sarah-radius-md: 8px;
  --sarah-radius-lg: 16px;

  /* Transitions */
  --sarah-transition-fast: 150ms ease;
  --sarah-transition-normal: 300ms ease;
  --sarah-transition-slow: 600ms ease;

  /* Typography */
  --sarah-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --sarah-font-size-sm: 0.85rem;
  --sarah-font-size-md: 1rem;
  --sarah-font-size-lg: 1.25rem;
  --sarah-font-size-xl: 2rem;
  --sarah-font-size-xxl: 3rem;
}
```

- [ ] **Step 4: Create `styles/base.css`**

```css
@import url('./theme.css');

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: var(--sarah-font-family);
  background: var(--sarah-bg-primary);
  color: var(--sarah-text-primary);
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

::selection {
  background: rgba(var(--sarah-accent-rgb), 0.3);
  color: var(--sarah-text-primary);
}

:focus-visible {
  outline: 1px solid var(--sarah-accent);
  outline-offset: 2px;
}
```

- [ ] **Step 5: Create `styles/wizard.css`**

```css
@import url('./base.css');

.wizard-layout {
  display: flex;
  width: 100vw;
  height: 100vh;
}

.wizard-sidebar {
  width: 220px;
  padding: var(--sarah-space-xl) var(--sarah-space-lg);
  border-right: 1px solid var(--sarah-border);
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.wizard-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

.wizard-slide-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sarah-space-xl);
}

.wizard-nav {
  display: flex;
  justify-content: flex-end;
  gap: var(--sarah-space-md);
  padding: var(--sarah-space-lg) var(--sarah-space-xl);
  border-top: 1px solid var(--sarah-border);
}
```

- [ ] **Step 6: Verify build works**

Run: `npm run build`
Expected: Both tsconfigs compile. `dist/` has main process files, `dist/renderer/` is empty (no renderer files yet but no errors).

- [ ] **Step 7: Commit**

```bash
git add tsconfig.renderer.json styles/ package.json
git commit -m "feat: add build infrastructure — dual tsconfig, CSS architecture"
```

---

## Task 2: Component Base + Button + Input

**Files:**
- Create: `src/renderer/components/base.ts`
- Create: `src/renderer/components/sarah-button.ts`
- Create: `src/renderer/components/sarah-input.ts`
- Create: `src/renderer/components/index.ts`

- [ ] **Step 1: Create component base (`src/renderer/components/base.ts`)**

This provides a base class that loads theme CSS variables into Shadow DOM, and a `factory()` helper.

```ts
/**
 * Shared theme CSS injected into every component's Shadow DOM.
 * CSS custom properties defined on :root pierce Shadow DOM automatically,
 * but we need base styles (font, color) inside each shadow root.
 */
export const THEME_CSS = `
  :host {
    font-family: var(--sarah-font-family);
    color: var(--sarah-text-primary);
    box-sizing: border-box;
  }
  :host *, :host *::before, :host *::after {
    box-sizing: border-box;
  }
`;

/**
 * Base class for all sarah-* components.
 * Provides Shadow DOM with theme styles pre-injected.
 */
export class SarahElement extends HTMLElement {
  protected root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  /** Inject a <style> block into the shadow root. Prepends THEME_CSS automatically. */
  protected injectStyles(css: string): void {
    const style = document.createElement('style');
    style.textContent = THEME_CSS + css;
    this.root.prepend(style);
  }
}

/** Helper type for factory function props. */
export type ChildrenProp = { children?: (HTMLElement | string)[] };

/** Convenience: create an element, set attributes, append children. */
export function createElement<T extends HTMLElement>(
  tag: string,
  attrs?: Record<string, string>,
  children?: (HTMLElement | string)[]
): T {
  const el = document.createElement(tag) as T;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
      } else {
        el.appendChild(child);
      }
    }
  }
  return el;
}
```

- [ ] **Step 2: Create `sarah-button` component (`src/renderer/components/sarah-button.ts`)**

```ts
import { SarahElement, createElement } from './base.js';

const CSS = `
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--sarah-space-sm);
    padding: var(--sarah-space-sm) var(--sarah-space-lg);
    border-radius: var(--sarah-radius-md);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-md);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
    border: 1px solid transparent;
    min-height: 40px;
  }

  button:focus-visible {
    outline: 1px solid var(--sarah-accent);
    outline-offset: 2px;
  }

  /* Primary */
  button.primary {
    background: var(--sarah-accent);
    color: var(--sarah-bg-primary);
    border-color: var(--sarah-accent);
  }
  button.primary:hover {
    background: var(--sarah-accent-hover);
    box-shadow: 0 0 20px var(--sarah-glow);
  }

  /* Secondary */
  button.secondary {
    background: transparent;
    color: var(--sarah-text-primary);
    border-color: var(--sarah-border);
  }
  button.secondary:hover {
    border-color: var(--sarah-accent);
    color: var(--sarah-accent);
    box-shadow: 0 0 15px var(--sarah-glow-subtle);
  }

  /* Ghost */
  button.ghost {
    background: transparent;
    color: var(--sarah-text-secondary);
    border-color: transparent;
  }
  button.ghost:hover {
    color: var(--sarah-text-primary);
    background: var(--sarah-bg-surface-hover);
  }

  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
  }
`;

export class SarahButton extends SarahElement {
  private button!: HTMLButtonElement;

  connectedCallback(): void {
    this.injectStyles(CSS);
    const variant = this.getAttribute('variant') ?? 'primary';
    this.button = document.createElement('button');
    this.button.className = variant;
    this.button.textContent = this.getAttribute('label') ?? '';
    if (this.hasAttribute('disabled')) {
      this.button.disabled = true;
    }
    this.root.appendChild(this.button);

    // Forward click events
    this.button.addEventListener('click', () => {
      this.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
    });
  }

  static get observedAttributes(): string[] {
    return ['label', 'variant', 'disabled'];
  }

  attributeChangedCallback(name: string, _old: string, value: string): void {
    if (!this.button) return;
    if (name === 'label') this.button.textContent = value;
    if (name === 'variant') this.button.className = value;
    if (name === 'disabled') this.button.disabled = value !== null;
  }
}

/** Factory function */
export function sarahButton(props: {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  onClick?: () => void;
}): SarahButton {
  const el = createElement<SarahButton>('sarah-button', {
    label: props.label,
    variant: props.variant ?? 'primary',
    ...(props.disabled ? { disabled: '' } : {}),
  });
  if (props.onClick) {
    el.addEventListener('click', props.onClick);
  }
  return el;
}
```

- [ ] **Step 3: Create `sarah-input` component (`src/renderer/components/sarah-input.ts`)**

```ts
import { SarahElement, createElement } from './base.js';

const CSS = `
  .input-wrapper {
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

  input {
    width: 100%;
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-primary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-md);
    transition: border-color var(--sarah-transition-fast),
                box-shadow var(--sarah-transition-fast);
    min-height: 40px;
  }

  input:focus {
    outline: none;
    border-color: var(--sarah-accent);
    box-shadow: 0 0 12px var(--sarah-glow-subtle);
  }

  input::placeholder {
    color: var(--sarah-text-muted);
  }

  .error-msg {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-accent-orange);
    min-height: 1.2em;
  }
`;

export class SarahInput extends SarahElement {
  private input!: HTMLInputElement;
  private errorEl!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const wrapper = document.createElement('div');
    wrapper.className = 'input-wrapper';

    const labelText = this.getAttribute('label');
    if (labelText) {
      const label = document.createElement('label');
      label.textContent = labelText;
      wrapper.appendChild(label);
    }

    this.input = document.createElement('input');
    this.input.type = this.getAttribute('type') ?? 'text';
    this.input.placeholder = this.getAttribute('placeholder') ?? '';
    if (this.hasAttribute('required')) this.input.required = true;
    if (this.hasAttribute('value')) this.input.value = this.getAttribute('value')!;

    this.input.addEventListener('input', () => {
      this.dispatchEvent(new CustomEvent('change', {
        detail: { value: this.input.value },
        bubbles: true,
        composed: true,
      }));
    });

    this.errorEl = document.createElement('div');
    this.errorEl.className = 'error-msg';

    wrapper.appendChild(this.input);
    wrapper.appendChild(this.errorEl);
    this.root.appendChild(wrapper);
  }

  get value(): string {
    return this.input?.value ?? '';
  }

  set value(v: string) {
    if (this.input) this.input.value = v;
  }

  setError(msg: string): void {
    this.errorEl.textContent = msg;
  }

  clearError(): void {
    this.errorEl.textContent = '';
  }

  validate(): boolean {
    if (this.input.required && !this.input.value.trim()) {
      this.setError('Dieses Feld ist erforderlich');
      return false;
    }
    this.clearError();
    return true;
  }
}

/** Factory function */
export function sarahInput(props: {
  label?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  value?: string;
  onChange?: (value: string) => void;
}): SarahInput {
  const attrs: Record<string, string> = {};
  if (props.label) attrs.label = props.label;
  if (props.type) attrs.type = props.type;
  if (props.placeholder) attrs.placeholder = props.placeholder;
  if (props.required) attrs.required = '';
  if (props.value) attrs.value = props.value;

  const el = createElement<SarahInput>('sarah-input', attrs);
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
```

- [ ] **Step 4: Create `src/renderer/components/index.ts`**

```ts
import { SarahButton } from './sarah-button.js';
import { SarahInput } from './sarah-input.js';

export { SarahButton, sarahButton } from './sarah-button.js';
export { SarahInput, sarahInput } from './sarah-input.js';
export { SarahElement, createElement } from './base.js';

/** Register all custom elements. Call once at app startup. */
export function registerComponents(): void {
  customElements.define('sarah-button', SarahButton);
  customElements.define('sarah-input', SarahInput);
}
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: `dist/renderer/components/` contains compiled JS files with ES module syntax (import/export).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/
git commit -m "feat: add component base, sarah-button, sarah-input"
```

---

## Task 3: Select + Form + Card + Progress Components

**Files:**
- Create: `src/renderer/components/sarah-select.ts`
- Create: `src/renderer/components/sarah-form.ts`
- Create: `src/renderer/components/sarah-card.ts`
- Create: `src/renderer/components/sarah-progress.ts`
- Modify: `src/renderer/components/index.ts`

- [ ] **Step 1: Create `sarah-select` component (`src/renderer/components/sarah-select.ts`)**

```ts
import { SarahElement, createElement } from './base.js';

const CSS = `
  .select-wrapper {
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

  select {
    width: 100%;
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-primary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-md);
    transition: border-color var(--sarah-transition-fast),
                box-shadow var(--sarah-transition-fast);
    min-height: 40px;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23a0a0b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    padding-right: 36px;
    cursor: pointer;
  }

  select:focus {
    outline: none;
    border-color: var(--sarah-accent);
    box-shadow: 0 0 12px var(--sarah-glow-subtle);
  }

  option {
    background: var(--sarah-bg-secondary);
    color: var(--sarah-text-primary);
  }
`;

export interface SelectOption {
  value: string;
  label: string;
}

export class SarahSelect extends SarahElement {
  private select!: HTMLSelectElement;
  private _options: SelectOption[] = [];

  connectedCallback(): void {
    this.injectStyles(CSS);

    const wrapper = document.createElement('div');
    wrapper.className = 'select-wrapper';

    const labelText = this.getAttribute('label');
    if (labelText) {
      const label = document.createElement('label');
      label.textContent = labelText;
      wrapper.appendChild(label);
    }

    this.select = document.createElement('select');
    this.select.addEventListener('change', () => {
      this.dispatchEvent(new CustomEvent('change', {
        detail: { value: this.select.value },
        bubbles: true,
        composed: true,
      }));
    });

    wrapper.appendChild(this.select);
    this.root.appendChild(wrapper);

    // If options were set via setOptions() before connectedCallback
    if (this._options.length) this.renderOptions();
  }

  get value(): string {
    return this.select?.value ?? '';
  }

  set value(v: string) {
    if (this.select) this.select.value = v;
  }

  setOptions(options: SelectOption[]): void {
    this._options = options;
    if (this.select) this.renderOptions();
  }

  private renderOptions(): void {
    this.select.innerHTML = '';
    for (const opt of this._options) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      this.select.appendChild(option);
    }
  }
}

/** Factory function */
export function sarahSelect(props: {
  label?: string;
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
}): SarahSelect {
  const attrs: Record<string, string> = {};
  if (props.label) attrs.label = props.label;

  const el = createElement<SarahSelect>('sarah-select', attrs);
  el.setOptions(props.options);
  if (props.value) el.value = props.value;
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
```

- [ ] **Step 2: Create `sarah-form` component (`src/renderer/components/sarah-form.ts`)**

```ts
import { SarahElement } from './base.js';

const CSS = `
  .form-wrapper {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-lg);
    width: 100%;
    max-width: 480px;
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
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-md);
  }
`;

export class SarahForm extends SarahElement {
  private fieldsContainer!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const wrapper = document.createElement('div');
    wrapper.className = 'form-wrapper';

    const title = this.getAttribute('title');
    if (title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'form-title';
      titleEl.textContent = title;
      wrapper.appendChild(titleEl);
    }

    const description = this.getAttribute('description');
    if (description) {
      const descEl = document.createElement('div');
      descEl.className = 'form-description';
      descEl.textContent = description;
      wrapper.appendChild(descEl);
    }

    this.fieldsContainer = document.createElement('div');
    this.fieldsContainer.className = 'form-fields';

    // Move slotted children into shadow DOM fields container
    const slot = document.createElement('slot');
    this.fieldsContainer.appendChild(slot);

    wrapper.appendChild(this.fieldsContainer);
    this.root.appendChild(wrapper);
  }
}

/** Factory function */
export function sarahForm(props: {
  title?: string;
  description?: string;
  children?: HTMLElement[];
}): SarahForm {
  const el = document.createElement('sarah-form') as SarahForm;
  if (props.title) el.setAttribute('title', props.title);
  if (props.description) el.setAttribute('description', props.description);
  if (props.children) {
    for (const child of props.children) {
      el.appendChild(child);
    }
  }
  return el;
}
```

- [ ] **Step 3: Create `sarah-card` component (`src/renderer/components/sarah-card.ts`)**

```ts
import { SarahElement } from './base.js';

const CSS = `
  .card {
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-lg);
    padding: var(--sarah-space-md) var(--sarah-space-lg);
    transition: border-color var(--sarah-transition-fast),
                box-shadow var(--sarah-transition-fast);
  }

  .card:hover {
    border-color: rgba(var(--sarah-accent-rgb), 0.2);
    box-shadow: 0 0 20px var(--sarah-glow-subtle);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: var(--sarah-space-sm);
    margin-bottom: var(--sarah-space-sm);
  }

  .card-icon {
    font-size: 1.2rem;
    opacity: 0.8;
  }

  .card-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .card-value {
    font-size: var(--sarah-font-size-lg);
    color: var(--sarah-text-primary);
    font-weight: 300;
  }
`;

export class SarahCard extends SarahElement {
  private valueEl!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const card = document.createElement('div');
    card.className = 'card';

    const header = document.createElement('div');
    header.className = 'card-header';

    const icon = this.getAttribute('icon');
    if (icon) {
      const iconEl = document.createElement('span');
      iconEl.className = 'card-icon';
      iconEl.textContent = icon;
      header.appendChild(iconEl);
    }

    const label = document.createElement('span');
    label.className = 'card-label';
    label.textContent = this.getAttribute('label') ?? '';
    header.appendChild(label);

    this.valueEl = document.createElement('div');
    this.valueEl.className = 'card-value';
    this.valueEl.textContent = this.getAttribute('value') ?? '';

    card.appendChild(header);
    card.appendChild(this.valueEl);
    this.root.appendChild(card);
  }

  static get observedAttributes(): string[] {
    return ['value'];
  }

  attributeChangedCallback(name: string, _old: string, value: string): void {
    if (name === 'value' && this.valueEl) {
      this.valueEl.textContent = value;
    }
  }
}

/** Factory function */
export function sarahCard(props: {
  label: string;
  value: string;
  icon?: string;
}): SarahCard {
  const attrs: Record<string, string> = {
    label: props.label,
    value: props.value,
  };
  if (props.icon) attrs.icon = props.icon;
  return document.createElement('sarah-card') as SarahCard;
  // Correction: use createElement helper
}

// Override factory to use createElement properly
export function SarahCardFactory(props: {
  label: string;
  value: string;
  icon?: string;
}): SarahCard {
  const el = document.createElement('sarah-card') as SarahCard;
  el.setAttribute('label', props.label);
  el.setAttribute('value', props.value);
  if (props.icon) el.setAttribute('icon', props.icon);
  return el;
}
```

- [ ] **Step 4: Create `sarah-progress` component (`src/renderer/components/sarah-progress.ts`)**

```ts
import { SarahElement } from './base.js';

const CSS = `
  .progress-wrapper {
    width: 100%;
  }

  .progress-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    margin-bottom: var(--sarah-space-xs);
  }

  .progress-track {
    width: 100%;
    height: 4px;
    background: var(--sarah-bg-surface);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--sarah-accent);
    border-radius: 2px;
    transition: width var(--sarah-transition-normal);
    box-shadow: 0 0 8px var(--sarah-glow);
    width: 0%;
  }

  /* Indeterminate animation */
  .progress-fill.indeterminate {
    width: 30%;
    animation: indeterminate 1.5s ease-in-out infinite;
  }

  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }
`;

export class SarahProgress extends SarahElement {
  private fillEl!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const wrapper = document.createElement('div');
    wrapper.className = 'progress-wrapper';

    const label = this.getAttribute('label');
    if (label) {
      const labelEl = document.createElement('div');
      labelEl.className = 'progress-label';
      labelEl.textContent = label;
      wrapper.appendChild(labelEl);
    }

    const track = document.createElement('div');
    track.className = 'progress-track';

    this.fillEl = document.createElement('div');
    this.fillEl.className = 'progress-fill';

    const value = this.getAttribute('value');
    if (value) {
      this.fillEl.style.width = `${value}%`;
    } else {
      this.fillEl.classList.add('indeterminate');
    }

    track.appendChild(this.fillEl);
    wrapper.appendChild(track);
    this.root.appendChild(wrapper);
  }

  setProgress(percent: number): void {
    if (!this.fillEl) return;
    this.fillEl.classList.remove('indeterminate');
    this.fillEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  setIndeterminate(): void {
    if (!this.fillEl) return;
    this.fillEl.style.width = '';
    this.fillEl.classList.add('indeterminate');
  }
}

/** Factory function */
export function sarahProgress(props?: {
  label?: string;
  value?: number;
}): SarahProgress {
  const el = document.createElement('sarah-progress') as SarahProgress;
  if (props?.label) el.setAttribute('label', props.label);
  if (props?.value !== undefined) el.setAttribute('value', String(props.value));
  return el;
}
```

- [ ] **Step 5: Update `src/renderer/components/index.ts`**

Replace entire file:

```ts
import { SarahButton } from './sarah-button.js';
import { SarahInput } from './sarah-input.js';
import { SarahSelect } from './sarah-select.js';
import { SarahForm } from './sarah-form.js';
import { SarahCard } from './sarah-card.js';
import { SarahProgress } from './sarah-progress.js';

export { SarahButton, sarahButton } from './sarah-button.js';
export { SarahInput, sarahInput } from './sarah-input.js';
export { SarahSelect, sarahSelect } from './sarah-select.js';
export type { SelectOption } from './sarah-select.js';
export { SarahForm, sarahForm } from './sarah-form.js';
export { SarahCard, SarahCardFactory as sarahCard } from './sarah-card.js';
export { SarahProgress, sarahProgress } from './sarah-progress.js';
export { SarahElement, createElement } from './base.js';

/** Register all custom elements. Call once at app startup. */
export function registerComponents(): void {
  customElements.define('sarah-button', SarahButton);
  customElements.define('sarah-input', SarahInput);
  customElements.define('sarah-select', SarahSelect);
  customElements.define('sarah-form', SarahForm);
  customElements.define('sarah-card', SarahCard);
  customElements.define('sarah-progress', SarahProgress);
}
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: All files compile to `dist/renderer/components/` with ES module syntax.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/
git commit -m "feat: add select, form, card, progress components"
```

---

## Task 4: Stepper + Slide Components

**Files:**
- Create: `src/renderer/components/sarah-stepper.ts`
- Create: `src/renderer/components/sarah-slide.ts`
- Modify: `src/renderer/components/index.ts`

- [ ] **Step 1: Create `sarah-stepper` component (`src/renderer/components/sarah-stepper.ts`)**

```ts
import { SarahElement } from './base.js';

const CSS = `
  .stepper {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .step {
    display: flex;
    align-items: flex-start;
    gap: var(--sarah-space-md);
    cursor: pointer;
    padding: var(--sarah-space-sm) 0;
    user-select: none;
  }

  .step-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
  }

  .step-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--sarah-text-muted);
    background: transparent;
    transition: all var(--sarah-transition-normal);
    position: relative;
  }

  .step-line {
    width: 2px;
    height: 32px;
    background: var(--sarah-border);
    transition: background var(--sarah-transition-normal);
  }

  .step:last-child .step-line {
    display: none;
  }

  .step-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    padding-top: 1px;
    transition: color var(--sarah-transition-fast);
    letter-spacing: 0.02em;
  }

  /* Active step */
  .step.active .step-dot {
    border-color: var(--sarah-accent);
    background: var(--sarah-accent);
    box-shadow: 0 0 12px var(--sarah-glow),
                0 0 4px var(--sarah-glow-strong);
    animation: pulse 2s ease-in-out infinite;
  }

  .step.active .step-label {
    color: var(--sarah-text-primary);
  }

  /* Completed step */
  .step.completed .step-dot {
    border-color: var(--sarah-accent);
    background: var(--sarah-accent);
  }

  .step.completed .step-dot::after {
    content: '✓';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 9px;
    color: var(--sarah-bg-primary);
    font-weight: bold;
  }

  .step.completed .step-label {
    color: var(--sarah-text-secondary);
  }

  .step.completed .step-line {
    background: var(--sarah-accent);
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 12px var(--sarah-glow), 0 0 4px var(--sarah-glow-strong); }
    50% { box-shadow: 0 0 20px var(--sarah-glow-strong), 0 0 8px var(--sarah-glow); }
  }
`;

export interface StepperStep {
  id: string;
  label: string;
}

export class SarahStepper extends SarahElement {
  private _steps: StepperStep[] = [];
  private _activeIndex = 0;
  private container!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);
    this.container = document.createElement('div');
    this.container.className = 'stepper';
    this.root.appendChild(this.container);
    this.render();
  }

  setSteps(steps: StepperStep[]): void {
    this._steps = steps;
    if (this.container) this.render();
  }

  setActive(index: number): void {
    this._activeIndex = index;
    if (this.container) this.render();
  }

  private render(): void {
    this.container.innerHTML = '';
    this._steps.forEach((step, i) => {
      const stepEl = document.createElement('div');
      stepEl.className = 'step';
      if (i === this._activeIndex) stepEl.classList.add('active');
      if (i < this._activeIndex) stepEl.classList.add('completed');

      const indicator = document.createElement('div');
      indicator.className = 'step-indicator';

      const dot = document.createElement('div');
      dot.className = 'step-dot';
      indicator.appendChild(dot);

      const line = document.createElement('div');
      line.className = 'step-line';
      indicator.appendChild(line);

      const label = document.createElement('div');
      label.className = 'step-label';
      label.textContent = step.label;

      stepEl.appendChild(indicator);
      stepEl.appendChild(label);

      stepEl.addEventListener('click', () => {
        if (i <= this._activeIndex) {
          this.dispatchEvent(new CustomEvent('step-click', {
            detail: { index: i, id: step.id },
            bubbles: true,
            composed: true,
          }));
        }
      });

      this.container.appendChild(stepEl);
    });
  }
}

/** Factory function */
export function sarahStepper(props: {
  steps: StepperStep[];
  activeIndex?: number;
  onStepClick?: (index: number, id: string) => void;
}): SarahStepper {
  const el = document.createElement('sarah-stepper') as SarahStepper;
  el.setSteps(props.steps);
  if (props.activeIndex !== undefined) el.setActive(props.activeIndex);
  if (props.onStepClick) {
    el.addEventListener('step-click', ((e: CustomEvent) => {
      props.onStepClick!(e.detail.index, e.detail.id);
    }) as EventListener);
  }
  return el;
}
```

- [ ] **Step 2: Create `sarah-slide` component (`src/renderer/components/sarah-slide.ts`)**

```ts
import { SarahElement } from './base.js';

const CSS = `
  :host {
    display: block;
    width: 100%;
    height: 100%;
    position: absolute;
    top: 0;
    left: 0;
    opacity: 0;
    transform: translateY(12px);
    transition: opacity var(--sarah-transition-slow),
                transform var(--sarah-transition-slow);
    pointer-events: none;
  }

  :host(.active) {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }

  .slide-content {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--sarah-space-xl);
  }
`;

export class SarahSlide extends SarahElement {
  connectedCallback(): void {
    this.injectStyles(CSS);
    const content = document.createElement('div');
    content.className = 'slide-content';
    const slot = document.createElement('slot');
    content.appendChild(slot);
    this.root.appendChild(content);
  }

  show(): void {
    this.classList.add('active');
  }

  hide(): void {
    this.classList.remove('active');
  }
}

/** Factory function */
export function sarahSlide(props?: {
  children?: HTMLElement[];
  active?: boolean;
}): SarahSlide {
  const el = document.createElement('sarah-slide') as SarahSlide;
  if (props?.children) {
    for (const child of props.children) {
      el.appendChild(child);
    }
  }
  if (props?.active) el.classList.add('active');
  return el;
}
```

- [ ] **Step 3: Update `src/renderer/components/index.ts`**

Add to imports at top:

```ts
import { SarahStepper } from './sarah-stepper.js';
import { SarahSlide } from './sarah-slide.js';
```

Add to exports:

```ts
export { SarahStepper, sarahStepper } from './sarah-stepper.js';
export type { StepperStep } from './sarah-stepper.js';
export { SarahSlide, sarahSlide } from './sarah-slide.js';
```

Add to `registerComponents()`:

```ts
customElements.define('sarah-stepper', SarahStepper);
customElements.define('sarah-slide', SarahSlide);
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: All files compile without errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/
git commit -m "feat: add stepper and slide components for wizard navigation"
```

---

## Task 5: Preload Bridge + System Info IPC

**Files:**
- Modify: `src/preload.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Extend preload bridge (`src/preload.ts`)**

Replace entire file:

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sarah', {
  version: process.versions.electron,
  splashDone: () => ipcRenderer.send('splash-done'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('save-config', config),
  isFirstRun: () => ipcRenderer.invoke('is-first-run'),
});
```

- [ ] **Step 2: Add IPC handlers in `src/main.ts`**

Add these imports at the top of `main.ts`:

```ts
import * as os from 'os';
import * as fs from 'fs';
```

Add this helper function before `createWindow()`:

```ts
function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig(): Record<string, unknown> {
  try {
    const data = fs.readFileSync(getConfigPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}
```

Add IPC handlers inside `app.whenReady().then(() => { ... })`, after `createWindow()`:

```ts
ipcMain.handle('get-system-info', async () => {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: os.arch(),
    cpu: cpus.length > 0 ? cpus[0].model : 'Unknown',
    cpuCores: cpus.length,
    totalMemory: `${Math.round(os.totalmem() / (1024 ** 3))} GB`,
    freeMemory: `${Math.round(os.freemem() / (1024 ** 3))} GB`,
    hostname: os.hostname(),
    shell: process.env.SHELL || process.env.COMSPEC || 'Unknown',
  };
});

ipcMain.handle('get-config', () => {
  return loadConfig();
});

ipcMain.handle('save-config', (_event, config: Record<string, unknown>) => {
  const existing = loadConfig();
  const merged = { ...existing, ...config };
  saveConfig(merged);
  return merged;
});

ipcMain.handle('is-first-run', () => {
  const config = loadConfig();
  return !config.setupComplete;
});
```

- [ ] **Step 3: Update the splash-done handler to route based on config**

In `src/main.ts`, replace the existing `splash-done` handler:

```ts
ipcMain.on('splash-done', () => {
  if (mainWindow) {
    const config = loadConfig();
    if (config.setupComplete) {
      mainWindow.loadFile(path.join(__dirname, '..', 'dashboard.html'));
    } else {
      mainWindow.loadFile(path.join(__dirname, '..', 'wizard.html'));
    }
  }
});
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/preload.ts src/main.ts
git commit -m "feat: add system-info, config IPC and first-run routing"
```

---

## Task 6: Wizard HTML + Orchestrator

**Files:**
- Create: `wizard.html`
- Create: `src/renderer/wizard/wizard.ts`

- [ ] **Step 1: Create `wizard.html`**

```html
<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'" />
    <title>S.A.R.A.H. — Einrichtung</title>
    <link rel="stylesheet" href="styles/wizard.css" />
  </head>
  <body>
    <div class="wizard-layout">
      <div class="wizard-sidebar" id="sidebar"></div>
      <div class="wizard-content">
        <div class="wizard-slide-area" id="slide-area"></div>
        <div class="wizard-nav" id="nav-area"></div>
      </div>
    </div>
    <script type="module" src="dist/renderer/wizard/wizard.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create wizard orchestrator (`src/renderer/wizard/wizard.ts`)**

```ts
import { registerComponents } from '../components/index.js';
import { sarahStepper } from '../components/sarah-stepper.js';
import { sarahButton } from '../components/sarah-button.js';
import { createWelcomeStep } from './steps/step-welcome.js';
import { createSystemScanStep } from './steps/step-system-scan.js';
import { createProfileStep } from './steps/step-profile.js';
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
    language: string;
    timezone: string;
  };
  personalization: {
    accentColor: string;
    voice: string;
    speechRate: number;
  };
}

const wizardData: WizardData = {
  system: {},
  profile: {
    displayName: '',
    city: '',
    language: 'de',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  personalization: {
    accentColor: '#00d4ff',
    voice: 'default-female-de',
    speechRate: 1.0,
  },
};

const STEPS = [
  { id: 'welcome', label: 'Willkommen' },
  { id: 'system', label: 'System-Scan' },
  { id: 'profile', label: 'Profil' },
  { id: 'personalization', label: 'Personalisierung' },
  { id: 'finish', label: 'Fertig' },
];

let currentStep = 0;

// DOM references
const sidebar = document.getElementById('sidebar')!;
const slideArea = document.getElementById('slide-area')!;
const navArea = document.getElementById('nav-area')!;

// Create stepper
const stepper = sarahStepper({
  steps: STEPS,
  activeIndex: 0,
  onStepClick: (index) => {
    if (index < currentStep) goToStep(index);
  },
});
sidebar.appendChild(stepper);

// Step renderers — each returns an HTMLElement
type StepRenderer = (data: WizardData) => HTMLElement;

const stepRenderers: StepRenderer[] = [
  createWelcomeStep,
  createSystemScanStep,
  createProfileStep,
  createPersonalizationStep,
  createFinishStep,
];

// Navigation
function renderNav(): void {
  navArea.innerHTML = '';

  if (currentStep > 0) {
    navArea.appendChild(sarahButton({
      label: 'Zurück',
      variant: 'secondary',
      onClick: () => goToStep(currentStep - 1),
    }));
  }

  if (currentStep < STEPS.length - 1) {
    navArea.appendChild(sarahButton({
      label: 'Weiter',
      variant: 'primary',
      onClick: () => goToStep(currentStep + 1),
    }));
  }

  if (currentStep === STEPS.length - 1) {
    navArea.appendChild(sarahButton({
      label: 'S.A.R.A.H. starten',
      variant: 'primary',
      onClick: finishWizard,
    }));
  }
}

function goToStep(index: number): void {
  currentStep = index;
  stepper.setActive(currentStep);
  renderStep();
  renderNav();
}

function renderStep(): void {
  slideArea.innerHTML = '';
  const stepContent = stepRenderers[currentStep](wizardData);
  slideArea.appendChild(stepContent);
}

async function finishWizard(): Promise<void> {
  await sarah.saveConfig({
    setupComplete: true,
    system: wizardData.system,
    profile: wizardData.profile,
    personalization: wizardData.personalization,
  });

  // Reload to dashboard
  window.location.href = 'dashboard.html';
}

// Initialize
goToStep(0);
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build may fail because step modules don't exist yet — that's expected. Verify no errors in wizard.ts besides missing imports.

- [ ] **Step 4: Commit**

```bash
git add wizard.html src/renderer/wizard/wizard.ts
git commit -m "feat: add wizard HTML and orchestrator with step routing"
```

---

## Task 7: Wizard Step 1 — Welcome

**Files:**
- Create: `src/renderer/wizard/steps/step-welcome.ts`

- [ ] **Step 1: Create welcome step**

```ts
import type { WizardData } from '../wizard.js';

const WELCOME_CSS = `
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: var(--sarah-space-lg);
    max-width: 500px;
  }

  .welcome-avatar {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    border: 2px solid var(--sarah-accent);
    box-shadow: 0 0 30px var(--sarah-glow),
                0 0 60px var(--sarah-glow-subtle);
    background: var(--sarah-bg-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 3rem;
    animation: float 3s ease-in-out infinite;
  }

  .welcome-title {
    font-size: var(--sarah-font-size-xxl);
    font-weight: 300;
    letter-spacing: 0.15em;
    color: var(--sarah-text-primary);
  }

  .welcome-text {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-secondary);
    line-height: 1.6;
    opacity: 0;
    animation: fadeUp 0.6s ease forwards;
    animation-delay: 0.3s;
  }

  .welcome-subtitle {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    letter-spacing: 0.1em;
    opacity: 0;
    animation: fadeUp 0.6s ease forwards;
    animation-delay: 0.6s;
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-8px); }
  }

  @keyframes fadeUp {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

export function createWelcomeStep(_data: WizardData): HTMLElement {
  const container = document.createElement('div');

  // Inject scoped styles
  const style = document.createElement('style');
  style.textContent = WELCOME_CSS;
  container.appendChild(style);

  const welcome = document.createElement('div');
  welcome.className = 'welcome';

  // Avatar placeholder (will be replaced by 3D persona later)
  const avatar = document.createElement('div');
  avatar.className = 'welcome-avatar';
  avatar.textContent = 'S';

  const title = document.createElement('div');
  title.className = 'welcome-title';
  title.textContent = 'S.A.R.A.H.';

  const text = document.createElement('div');
  text.className = 'welcome-text';
  text.textContent = 'Hallo! Ich bin Sarah — dein persönlicher Assistent. Ich helfe dir bei der Einrichtung, damit ich optimal für dich arbeiten kann.';

  const subtitle = document.createElement('div');
  subtitle.className = 'welcome-subtitle';
  subtitle.textContent = 'Smart Assistant for Resource and Administration Handling';

  welcome.appendChild(avatar);
  welcome.appendChild(title);
  welcome.appendChild(text);
  welcome.appendChild(subtitle);
  container.appendChild(welcome);

  return container;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Compiles. (step-system-scan etc. still missing — wizard.ts will error on those imports)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/steps/step-welcome.ts
git commit -m "feat: add wizard welcome step with avatar and animated intro"
```

---

## Task 8: Wizard Step 2 — System Scan

**Files:**
- Create: `src/renderer/wizard/steps/step-system-scan.ts`

- [ ] **Step 1: Create system scan step**

```ts
import type { WizardData } from '../wizard.js';
import { sarahCard } from '../../components/sarah-card.js';
import { sarahProgress } from '../../components/sarah-progress.js';

declare const sarah: {
  getSystemInfo: () => Promise<Record<string, string>>;
};

// Use the globally exposed sarah from wizard.ts
function getSarah(): typeof sarah {
  return (window as any).__sarah;
}

const SCAN_CSS = `
  .scan {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sarah-space-lg);
    width: 100%;
    max-width: 600px;
  }

  .scan-title {
    font-size: var(--sarah-font-size-xl);
    font-weight: 300;
    color: var(--sarah-text-primary);
    letter-spacing: 0.05em;
  }

  .scan-subtitle {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-secondary);
  }

  .scan-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sarah-space-md);
    width: 100%;
  }

  .scan-grid sarah-card {
    opacity: 0;
    transform: translateY(8px);
    animation: cardIn 0.4s ease forwards;
  }
  
  @keyframes cardIn {
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

const SYSTEM_LABELS: Record<string, { label: string; icon: string }> = {
  os: { label: 'Betriebssystem', icon: '💻' },
  cpu: { label: 'Prozessor', icon: '⚡' },
  cpuCores: { label: 'CPU Kerne', icon: '🧮' },
  totalMemory: { label: 'Arbeitsspeicher', icon: '🧠' },
  hostname: { label: 'Hostname', icon: '🏷️' },
  shell: { label: 'Shell', icon: '⌨️' },
  arch: { label: 'Architektur', icon: '🔧' },
  freeMemory: { label: 'Freier RAM', icon: '📊' },
};

export function createSystemScanStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = SCAN_CSS;
  container.appendChild(style);

  const scan = document.createElement('div');
  scan.className = 'scan';

  const title = document.createElement('div');
  title.className = 'scan-title';
  title.textContent = 'System-Scan';

  const subtitle = document.createElement('div');
  subtitle.className = 'scan-subtitle';
  subtitle.textContent = 'Ich analysiere dein System...';

  const progress = sarahProgress({ label: 'Scanning...' });

  const grid = document.createElement('div');
  grid.className = 'scan-grid';

  scan.appendChild(title);
  scan.appendChild(subtitle);
  scan.appendChild(progress);
  scan.appendChild(grid);
  container.appendChild(scan);

  // Run the scan
  runScan(data, progress, grid, subtitle);

  return container;
}

async function runScan(
  data: WizardData,
  progress: HTMLElement & { setProgress: (n: number) => void },
  grid: HTMLElement,
  subtitle: HTMLElement,
): Promise<void> {
  progress.setProgress(20);

  const info = await getSarah().getSystemInfo();
  data.system = info;

  progress.setProgress(60);

  // Stagger card appearance
  const entries = Object.entries(info);
  let shown = 0;

  for (const [key, value] of entries) {
    const meta = SYSTEM_LABELS[key];
    if (!meta) continue;

    await delay(150);
    const card = sarahCard({ label: meta.label, value: String(value), icon: meta.icon });
    card.style.animationDelay = `${shown * 0.1}s`;
    grid.appendChild(card);
    shown++;
    progress.setProgress(60 + (shown / entries.length) * 40);
  }

  subtitle.textContent = 'Scan abgeschlossen!';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/steps/step-system-scan.ts
git commit -m "feat: add system scan step with animated card grid"
```

---

## Task 9: Wizard Step 3 — Profile

**Files:**
- Create: `src/renderer/wizard/steps/step-profile.ts`

- [ ] **Step 1: Create profile step**

```ts
import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahInput } from '../../components/sarah-input.js';
import { sarahSelect } from '../../components/sarah-select.js';

export function createProfileStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const form = sarahForm({
    title: 'Dein Profil',
    description: 'Erzähl mir ein bisschen über dich, damit ich dich besser unterstützen kann.',
    children: [
      sarahInput({
        label: 'Wie soll ich dich nennen?',
        placeholder: 'Dein Name',
        required: true,
        value: data.profile.displayName,
        onChange: (value) => { data.profile.displayName = value; },
      }),
      sarahInput({
        label: 'Stadt / Region',
        placeholder: 'z.B. Berlin',
        value: data.profile.city,
        onChange: (value) => { data.profile.city = value; },
      }),
      sarahSelect({
        label: 'Sprache',
        options: [
          { value: 'de', label: 'Deutsch' },
          { value: 'en', label: 'English' },
          { value: 'fr', label: 'Français' },
          { value: 'es', label: 'Español' },
        ],
        value: data.profile.language,
        onChange: (value) => { data.profile.language = value; },
      }),
      sarahSelect({
        label: 'Zeitzone',
        options: getTimezoneOptions(),
        value: data.profile.timezone,
        onChange: (value) => { data.profile.timezone = value; },
      }),
    ],
  });

  container.appendChild(form);
  return container;
}

function getTimezoneOptions(): { value: string; label: string }[] {
  const zones = [
    'Europe/Berlin',
    'Europe/Vienna',
    'Europe/Zurich',
    'Europe/London',
    'Europe/Paris',
    'Europe/Amsterdam',
    'America/New_York',
    'America/Chicago',
    'America/Los_Angeles',
    'Asia/Tokyo',
    'Asia/Shanghai',
    'Australia/Sydney',
  ];
  return zones.map(z => ({ value: z, label: z.replace('_', ' ') }));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/wizard/steps/step-profile.ts
git commit -m "feat: add profile step with name, city, language, timezone"
```

---

## Task 10: Wizard Step 4 — Personalization

**Files:**
- Create: `src/renderer/wizard/steps/step-personalization.ts`

- [ ] **Step 1: Create personalization step**

```ts
import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahSelect } from '../../components/sarah-select.js';

const PERS_CSS = `
  .color-grid {
    display: flex;
    gap: var(--sarah-space-sm);
    flex-wrap: wrap;
  }

  .color-swatch {
    width: 40px;
    height: 40px;
    border-radius: var(--sarah-radius-md);
    border: 2px solid transparent;
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
  }

  .color-swatch:hover {
    transform: scale(1.1);
  }

  .color-swatch.selected {
    border-color: var(--sarah-text-primary);
    box-shadow: 0 0 12px currentColor;
  }

  .color-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    margin-bottom: var(--sarah-space-xs);
    letter-spacing: 0.03em;
  }

  .color-section {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-xs);
  }
`;

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

export function createPersonalizationStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = PERS_CSS;
  container.appendChild(style);

  // Color picker section
  const colorSection = document.createElement('div');
  colorSection.className = 'color-section';

  const colorLabel = document.createElement('div');
  colorLabel.className = 'color-label';
  colorLabel.textContent = 'Akzentfarbe';

  const colorGrid = document.createElement('div');
  colorGrid.className = 'color-grid';

  for (const color of ACCENT_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    if (data.personalization.accentColor === color.value) {
      swatch.classList.add('selected');
    }
    swatch.style.backgroundColor = color.value;
    swatch.style.color = color.value;
    swatch.title = color.label;
    swatch.addEventListener('click', () => {
      data.personalization.accentColor = color.value;
      colorGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');

      // Live preview: update CSS variable
      document.documentElement.style.setProperty('--sarah-accent', color.value);
      const rgb = hexToRgb(color.value);
      if (rgb) {
        document.documentElement.style.setProperty('--sarah-accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
      }
    });
    colorGrid.appendChild(swatch);
  }

  colorSection.appendChild(colorLabel);
  colorSection.appendChild(colorGrid);

  // Voice + speech rate
  const voiceSelect = sarahSelect({
    label: 'Sarahs Stimme',
    options: [
      { value: 'default-female-de', label: 'Standard (Deutsch, weiblich)' },
      { value: 'default-female-en', label: 'Standard (English, female)' },
      { value: 'warm-female-de', label: 'Warm (Deutsch, weiblich)' },
    ],
    value: data.personalization.voice,
    onChange: (value) => { data.personalization.voice = value; },
  });

  const form = sarahForm({
    title: 'Personalisierung',
    description: 'Passe S.A.R.A.H. an deinen Geschmack an. Du kannst alles später in den Einstellungen ändern.',
    children: [colorSection, voiceSelect],
  });

  container.appendChild(form);
  return container;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/wizard/steps/step-personalization.ts
git commit -m "feat: add personalization step with color picker and voice select"
```

---

## Task 11: Wizard Step 5 — Finish

**Files:**
- Create: `src/renderer/wizard/steps/step-finish.ts`

- [ ] **Step 1: Create finish step**

```ts
import type { WizardData } from '../wizard.js';

const FINISH_CSS = `
  .finish {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sarah-space-lg);
    max-width: 500px;
    text-align: center;
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

  .summary {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-sm);
    padding: var(--sarah-space-lg);
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
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .summary-value {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-primary);
  }

  .summary-divider {
    height: 1px;
    background: var(--sarah-border);
    margin: var(--sarah-space-xs) 0;
  }

  .accent-preview {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: inline-block;
    vertical-align: middle;
    margin-left: var(--sarah-space-sm);
    box-shadow: 0 0 8px currentColor;
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
  text.textContent = 'Hier ist eine Zusammenfassung deiner Einstellungen. Du kannst jederzeit zurückgehen und etwas ändern.';

  const summary = document.createElement('div');
  summary.className = 'summary';

  const rows: { label: string; value: string }[] = [
    { label: 'Name', value: data.profile.displayName || '—' },
    { label: 'Stadt', value: data.profile.city || '—' },
    { label: 'Sprache', value: data.profile.language },
    { label: 'Zeitzone', value: data.profile.timezone },
    { label: 'System', value: data.system.os || '—' },
    { label: 'CPU', value: data.system.cpu || '—' },
    { label: 'RAM', value: data.system.totalMemory || '—' },
  ];

  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'summary-row';

    const label = document.createElement('span');
    label.className = 'summary-label';
    label.textContent = row.label;

    const value = document.createElement('span');
    value.className = 'summary-value';
    value.textContent = row.value;

    rowEl.appendChild(label);
    rowEl.appendChild(value);
    summary.appendChild(rowEl);
  }

  // Accent color row
  const colorRow = document.createElement('div');
  colorRow.className = 'summary-row';
  const colorLabel = document.createElement('span');
  colorLabel.className = 'summary-label';
  colorLabel.textContent = 'Akzentfarbe';
  const colorValue = document.createElement('span');
  colorValue.className = 'summary-value';
  const colorDot = document.createElement('span');
  colorDot.className = 'accent-preview';
  colorDot.style.backgroundColor = data.personalization.accentColor;
  colorDot.style.color = data.personalization.accentColor;
  colorValue.textContent = data.personalization.accentColor;
  colorValue.appendChild(colorDot);
  colorRow.appendChild(colorLabel);
  colorRow.appendChild(colorValue);
  summary.appendChild(colorRow);

  finish.appendChild(title);
  finish.appendChild(text);
  finish.appendChild(summary);
  container.appendChild(finish);

  return container;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/wizard/steps/step-finish.ts
git commit -m "feat: add finish step with settings summary"
```

---

## Task 12: Integration — Build, Test, Polish

**Files:**
- All previously created files (verify integration)

- [ ] **Step 1: Verify full build**

Run: `npm run build`
Expected: Both tsconfigs compile without errors. Check that `dist/renderer/` has all expected JS files.

- [ ] **Step 2: Manual test — launch the app**

Run: `npm start`
Expected:
1. Splash screen plays
2. After splash, wizard.html loads (since no config.json exists yet → first run)
3. Stepper appears on left with 5 steps
4. Welcome step shows with animated "S" avatar, title, text
5. "Weiter" button in bottom nav

- [ ] **Step 3: Test each wizard step**

Walk through all 5 steps:
1. Welcome → animated intro, "Weiter" works
2. System-Scan → progress bar, system info cards appear with stagger
3. Profile → form with name, city, language, timezone inputs
4. Personalization → color swatches, voice select, live color preview
5. Finish → summary of all settings, "S.A.R.A.H. starten" button

- [ ] **Step 4: Test config persistence**

Click "S.A.R.A.H. starten" on the finish step.
Expected: Config saved to `%APPDATA%/s-a-r-a-h/config.json`, app navigates to dashboard.html.

- [ ] **Step 5: Test second launch**

Run: `npm start` again.
Expected: After splash, app goes directly to dashboard.html (not wizard), because `setupComplete: true` in config.

- [ ] **Step 6: Fix any issues found during testing**

Address any CSS, layout, or functionality issues. Common things to check:
- CSP errors in DevTools console (open with Ctrl+Shift+I)
- Module loading errors (check script paths)
- Component rendering issues

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete setup wizard — 5-step first-run experience"
```
