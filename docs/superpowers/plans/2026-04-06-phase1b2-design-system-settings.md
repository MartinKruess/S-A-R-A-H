# Phase 1B-2: Design System Expansion + Settings View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the design system tokens, build a functional dashboard with sidebar navigation, and create a Settings view that lets users edit everything they configured in the wizard.

**Architecture:** Dashboard uses the same sidebar+content layout pattern as the wizard (CSS layout, not a component). The dashboard entry point (`dashboard.ts`) manages view routing via a simple `showView(name)` function. Settings loads config via `sarah.getConfig()` and saves changes per-section via `sarah.saveConfig()`. Existing components (form, input, select, toggle, tag-select, path-picker, button) are reused — no new components needed.

**Tech Stack:** TypeScript renderer (ES2022), Shadow DOM Web Components, CSS Custom Properties

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `styles/theme.css` | Add shadow, z-index, and sidebar tokens |
| Create | `styles/dashboard.css` | Dashboard layout (sidebar + content area) |
| Modify | `dashboard.html` | Wire up stylesheet and dashboard entry script |
| Create | `src/renderer/dashboard/dashboard.ts` | Dashboard entry point, sidebar nav, view routing |
| Create | `src/renderer/dashboard/views/home.ts` | Dashboard home view (welcome + summary cards) |
| Create | `src/renderer/dashboard/views/settings.ts` | Settings view with editable sections |

---

### Task 1: Expand theme tokens

**Files:**
- Modify: `styles/theme.css`

- [ ] **Step 1: Add shadow, z-index, and sidebar tokens**

Add the following tokens to the `:root` block in `styles/theme.css`, after the existing `--sarah-radius-lg` line and before the `/* Transitions */` comment:

```css
  /* Shadows */
  --sarah-shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
  --sarah-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --sarah-shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
  --sarah-shadow-glow: 0 0 20px var(--sarah-glow-subtle);

  /* Z-index layers */
  --sarah-z-base: 1;
  --sarah-z-sidebar: 10;
  --sarah-z-overlay: 100;
  --sarah-z-modal: 200;
  --sarah-z-toast: 300;

  /* Sidebar */
  --sarah-sidebar-width: 240px;
  --sarah-sidebar-bg: var(--sarah-bg-secondary);
```

- [ ] **Step 2: Verify compilation**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add styles/theme.css
git commit -m "feat(theme): add shadow, z-index, and sidebar tokens"
```

---

### Task 2: Dashboard layout CSS

**Files:**
- Create: `styles/dashboard.css`

- [ ] **Step 1: Create dashboard.css**

Create `styles/dashboard.css`:

```css
@import url('./base.css');

.dashboard-layout {
  display: flex;
  width: 100vw;
  height: 100vh;
}

.dashboard-sidebar {
  width: var(--sarah-sidebar-width);
  flex-shrink: 0;
  background: var(--sarah-sidebar-bg);
  border-right: 1px solid var(--sarah-border);
  display: flex;
  flex-direction: column;
  z-index: var(--sarah-z-sidebar);
}

.sidebar-header {
  padding: var(--sarah-space-lg);
  border-bottom: 1px solid var(--sarah-border);
}

.sidebar-title {
  font-size: var(--sarah-font-size-lg);
  font-weight: 400;
  color: var(--sarah-accent);
  letter-spacing: 0.05em;
}

.sidebar-nav {
  flex: 1;
  padding: var(--sarah-space-sm) 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--sarah-space-sm);
  padding: var(--sarah-space-sm) var(--sarah-space-lg);
  color: var(--sarah-text-secondary);
  font-size: var(--sarah-font-size-md);
  cursor: pointer;
  transition: all var(--sarah-transition-fast);
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  font-family: var(--sarah-font-family);
}

.nav-item:hover {
  color: var(--sarah-text-primary);
  background: var(--sarah-bg-surface-hover);
}

.nav-item.active {
  color: var(--sarah-accent);
  background: rgba(var(--sarah-accent-rgb), 0.08);
  border-right: 2px solid var(--sarah-accent);
}

.nav-item-icon {
  font-size: 1.1rem;
  width: 24px;
  text-align: center;
}

.sidebar-footer {
  padding: var(--sarah-space-md) var(--sarah-space-lg);
  border-top: 1px solid var(--sarah-border);
  font-size: var(--sarah-font-size-sm);
  color: var(--sarah-text-muted);
}

.dashboard-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--sarah-space-xl);
  min-width: 0;
}

.dashboard-content > * {
  max-width: 800px;
}

/* Settings sections */
.settings-section {
  margin-bottom: var(--sarah-space-xl);
}

.settings-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sarah-space-lg);
}

.settings-section-title {
  font-size: var(--sarah-font-size-lg);
  color: var(--sarah-text-primary);
  font-weight: 400;
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sarah-space-md);
}

@media (max-width: 900px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}

/* Home view */
.home-greeting {
  font-size: var(--sarah-font-size-xl);
  font-weight: 300;
  color: var(--sarah-text-primary);
  margin-bottom: var(--sarah-space-sm);
}

.home-subtitle {
  font-size: var(--sarah-font-size-md);
  color: var(--sarah-text-secondary);
  margin-bottom: var(--sarah-space-xl);
}

.home-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--sarah-space-md);
}

/* Save feedback */
.save-feedback {
  color: var(--sarah-accent);
  font-size: var(--sarah-font-size-sm);
  opacity: 0;
  transition: opacity var(--sarah-transition-fast);
}

.save-feedback.visible {
  opacity: 1;
}
```

- [ ] **Step 2: Commit**

```bash
git add styles/dashboard.css
git commit -m "feat(styles): add dashboard layout CSS"
```

---

### Task 3: Dashboard home view

**Files:**
- Create: `src/renderer/dashboard/views/home.ts`

- [ ] **Step 1: Create home.ts**

Create `src/renderer/dashboard/views/home.ts`:

```typescript
import { sarahCard } from '../../components/sarah-card.js';

function getSarah(): any {
  return (window as any).__sarah;
}

export async function createHomeView(): Promise<HTMLElement> {
  const container = document.createElement('div');

  const config = await getSarah().getConfig();
  const profile = config.profile || {};
  const resources = config.resources || {};

  // Greeting
  const greeting = document.createElement('div');
  greeting.className = 'home-greeting';
  const name = profile.displayName || 'Nutzer';
  greeting.textContent = `Hallo, ${name}!`;
  container.appendChild(greeting);

  const subtitle = document.createElement('div');
  subtitle.className = 'home-subtitle';
  subtitle.textContent = 'Willkommen zurück bei S.A.R.A.H.';
  container.appendChild(subtitle);

  // Summary cards
  const cards = document.createElement('div');
  cards.className = 'home-cards';

  const programCount = Array.isArray(resources.programs) ? resources.programs.length : 0;
  const folderCount = Array.isArray(resources.importantFolders) ? resources.importantFolders.filter((f: string) => f).length : 0;

  cards.appendChild(sarahCard({ icon: '📦', label: 'Programme', value: String(programCount) }));
  cards.appendChild(sarahCard({ icon: '📁', label: 'Ordner', value: String(folderCount) }));
  cards.appendChild(sarahCard({ icon: '🎨', label: 'Akzentfarbe', value: config.personalization?.accentColor || '#00d4ff' }));
  cards.appendChild(sarahCard({ icon: '🔒', label: 'Dateizugriff', value: config.trust?.fileAccess || 'Nicht gesetzt' }));

  container.appendChild(cards);

  return container;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc -p tsconfig.renderer.json --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/dashboard/views/home.ts
git commit -m "feat(dashboard): add home view with greeting and summary cards"
```

---

### Task 4: Settings view

**Files:**
- Create: `src/renderer/dashboard/views/settings.ts`

This is the main feature — an editable view for all wizard-configured data.

- [ ] **Step 1: Create settings.ts**

Create `src/renderer/dashboard/views/settings.ts`:

```typescript
import { sarahForm } from '../../components/sarah-form.js';
import { sarahInput } from '../../components/sarah-input.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahButton } from '../../components/sarah-button.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';

function getSarah(): any {
  return (window as any).__sarah;
}

function showSaved(feedback: HTMLElement): void {
  feedback.classList.add('visible');
  setTimeout(() => feedback.classList.remove('visible'), 2000);
}

function createProfileSection(config: Record<string, any>): HTMLElement {
  const profile = config.profile || {};
  const section = document.createElement('div');
  section.className = 'settings-section';

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Profil';
  const feedback = document.createElement('span');
  feedback.className = 'save-feedback';
  feedback.textContent = 'Gespeichert!';
  header.appendChild(title);
  header.appendChild(feedback);
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

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Dateien & Ordner';
  const feedback = document.createElement('span');
  feedback.className = 'save-feedback';
  feedback.textContent = 'Gespeichert!';
  header.appendChild(title);
  header.appendChild(feedback);
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

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Vertrauen & Sicherheit';
  const feedback = document.createElement('span');
  feedback.className = 'save-feedback';
  feedback.textContent = 'Gespeichert!';
  header.appendChild(title);
  header.appendChild(feedback);
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

function createPersonalizationSection(config: Record<string, any>): HTMLElement {
  const personalization = config.personalization || {};
  const section = document.createElement('div');
  section.className = 'settings-section';

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Personalisierung';
  const feedback = document.createElement('span');
  feedback.className = 'save-feedback';
  feedback.textContent = 'Gespeichert!';
  header.appendChild(title);
  header.appendChild(feedback);
  section.appendChild(header);

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
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc -p tsconfig.renderer.json --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/dashboard/views/settings.ts
git commit -m "feat(dashboard): add settings view with editable profile, resources, trust, personalization"
```

---

### Task 5: Dashboard entry point and wiring

**Files:**
- Create: `src/renderer/dashboard/dashboard.ts`
- Modify: `dashboard.html`

- [ ] **Step 1: Create dashboard.ts**

Create `src/renderer/dashboard/dashboard.ts`:

```typescript
import { registerComponents } from '../components/index.js';
import { createHomeView } from './views/home.js';
import { createSettingsView } from './views/settings.js';

declare const sarah: {
  version: string;
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  selectFolder: (title?: string) => Promise<string | null>;
};

(window as any).__sarah = sarah;

registerComponents();

type ViewName = 'home' | 'settings';

const views: Record<ViewName, () => Promise<HTMLElement>> = {
  home: createHomeView,
  settings: createSettingsView,
};

let activeView: ViewName = 'home';

const contentArea = document.getElementById('content-area')!;
const navButtons = document.querySelectorAll<HTMLButtonElement>('.nav-item');

function setActiveNav(view: ViewName): void {
  navButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

async function showView(name: ViewName): Promise<void> {
  activeView = name;
  setActiveNav(name);
  contentArea.innerHTML = '';
  const el = await views[name]();
  contentArea.appendChild(el);
}

// Wire up nav clicks
navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view as ViewName;
    if (view && view !== activeView) {
      showView(view);
    }
  });
});

// Initial view
showView('home');
```

- [ ] **Step 2: Update dashboard.html**

Replace the entire content of `dashboard.html` with:

```html
<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
    <title>S.A.R.A.H.</title>
    <link rel="stylesheet" href="styles/dashboard.css" />
  </head>
  <body>
    <div class="dashboard-layout">
      <div class="dashboard-sidebar">
        <div class="sidebar-header">
          <div class="sidebar-title">S.A.R.A.H.</div>
        </div>
        <nav class="sidebar-nav">
          <button class="nav-item active" data-view="home">
            <span class="nav-item-icon">🏠</span>
            Dashboard
          </button>
          <button class="nav-item" data-view="settings">
            <span class="nav-item-icon">⚙️</span>
            Einstellungen
          </button>
        </nav>
        <div class="sidebar-footer">
          v<span id="version">1.0</span>
        </div>
      </div>
      <div class="dashboard-content" id="content-area"></div>
    </div>
    <script type="module" src="dist/renderer/dashboard/dashboard.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Verify full build and manual test**

Run: `npm run build`
Expected: No errors.

Run: `npm start`
Expected: After splash, if wizard was completed, dashboard loads with sidebar (Dashboard + Einstellungen), home view shows greeting and summary cards. Clicking "Einstellungen" shows editable profile, resources, trust, and personalization settings.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/dashboard/dashboard.ts dashboard.html
git commit -m "feat(dashboard): add dashboard entry point with sidebar navigation and view routing"
```

---

## Summary

| Change | What it does |
|--------|-------------|
| `theme.css` expanded | Shadow, z-index, sidebar tokens for consistent styling |
| `dashboard.css` | Layout for sidebar + content, settings grid, home cards |
| `dashboard.html` | Wired up with proper structure, stylesheet, script |
| `dashboard.ts` | Entry point with simple view routing |
| `home.ts` | Welcome greeting + summary cards from config |
| `settings.ts` | Editable sections: Profile, Resources, Trust, Personalization |

No new components needed — all existing sarah-* components are reused. The Settings view auto-saves each change and shows a brief "Gespeichert!" feedback.
