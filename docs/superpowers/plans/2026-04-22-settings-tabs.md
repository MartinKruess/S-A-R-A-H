# Settings Tab-Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Settings into 5 thematische Tabs (Profil / Persönliche Einstellungen / Verwaltung / Bedienung / Sicherheit), ergänzt um Profil-Felder (Nachname, Adresse, Hobbys) und einen Wizard-Footer-Link. Reiner Struktur-Refactor — visuelle Cockpit-Angleichung folgt in separatem Spec.

**Architecture:** Neue `sarah-tabs`-Komponente (horizontaler Strip mit ARIA + Keyboard-Nav). Settings-View wird zum Orchestrator: rendert alle 5 Tab-Panels **einmalig** beim Laden und schaltet via `hidden` Attribut zwischen ihnen um (Hide/Show statt Destroy/Recreate, verhindert Config-Staleness). URL-Hash hält die Tab-Auswahl über Reloads.

**Tech Stack:**
- TypeScript + Web Components (Shadow DOM via `SarahElement` base)
- Vitest (environment: `node` — keine DOM-Tests, Logik in separate `*-logic.ts` Files für Testbarkeit)
- Vanilla DOM, keine Framework-Abhängigkeit
- Zod-Schema bereits vorhanden (`ProfileSchema` hat `lastName`, `address`, `hobbies`)

**Spec:** `docs/superpowers/specs/2026-04-22-settings-tabs-design.md`

**File-Inventar:**

| Datei | Aktion |
|---|---|
| `src/renderer/components/sarah-tabs-logic.ts` | NEU — pure Helpers für Tests |
| `src/renderer/components/sarah-tabs-logic.test.ts` | NEU — Unit-Tests |
| `src/renderer/components/sarah-tabs.ts` | NEU — Custom-Element-Klasse |
| `src/renderer/components/index.ts` | MOD — sarah-tabs registrieren/exportieren |
| `src/renderer/dashboard/views/sections/profile-section.ts` | MOD — Nachname, Adresse, Hobbys einbauen |
| `src/renderer/dashboard/views/settings.ts` | MOD — Orchestrator mit Tabs |
| `styles/dashboard.css` | MOD — `.settings-tabs-wrapper`, `.settings-field-full`, `.settings-footer-link` |

---

## Task 1: `sarah-tabs-logic` — pure Helpers + TDD

**Files:**
- Create: `src/renderer/components/sarah-tabs-logic.ts`
- Create: `src/renderer/components/sarah-tabs-logic.test.ts`

Das Logic-Modul kapselt die deterministischen Teile der Tab-Komponente (Key-Mapping, Index-Arithmetik, Hash-Resolution). Die Custom-Element-Klasse ruft diese Helpers an, enthält aber selbst nur DOM-Glue. So können wir die Logik in Node-Vitest testen, ohne DOM-Setup.

- [ ] **Step 1.1: Failing Tests schreiben**

Erstelle `src/renderer/components/sarah-tabs-logic.test.ts` mit folgendem Inhalt:

```ts
import { describe, it, expect } from 'vitest';
import {
  keyToTabAction,
  nextTabIndex,
  resolveInitialTabId,
} from './sarah-tabs-logic.js';

describe('keyToTabAction', () => {
  it('maps ArrowRight to next', () => {
    expect(keyToTabAction('ArrowRight')).toBe('next');
  });

  it('maps ArrowLeft to prev', () => {
    expect(keyToTabAction('ArrowLeft')).toBe('prev');
  });

  it('maps Home to first', () => {
    expect(keyToTabAction('Home')).toBe('first');
  });

  it('maps End to last', () => {
    expect(keyToTabAction('End')).toBe('last');
  });

  it('maps Enter and Space to activate', () => {
    expect(keyToTabAction('Enter')).toBe('activate');
    expect(keyToTabAction(' ')).toBe('activate');
  });

  it('returns null for unrelated keys', () => {
    for (const key of ['a', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown']) {
      expect(keyToTabAction(key)).toBeNull();
    }
  });
});

describe('nextTabIndex', () => {
  it('moves forward with wrap-around', () => {
    expect(nextTabIndex(0, 'next', 3)).toBe(1);
    expect(nextTabIndex(1, 'next', 3)).toBe(2);
    expect(nextTabIndex(2, 'next', 3)).toBe(0);
  });

  it('moves backward with wrap-around', () => {
    expect(nextTabIndex(2, 'prev', 3)).toBe(1);
    expect(nextTabIndex(1, 'prev', 3)).toBe(0);
    expect(nextTabIndex(0, 'prev', 3)).toBe(2);
  });

  it('jumps to first and last', () => {
    expect(nextTabIndex(2, 'first', 5)).toBe(0);
    expect(nextTabIndex(0, 'last', 5)).toBe(4);
  });

  it('returns same index for zero-length tab list', () => {
    expect(nextTabIndex(0, 'next', 0)).toBe(0);
    expect(nextTabIndex(0, 'last', 0)).toBe(0);
  });
});

describe('resolveInitialTabId', () => {
  const valid = ['profile', 'personal', 'management', 'control', 'security'];

  it('returns hash value if valid', () => {
    expect(resolveInitialTabId('#personal', 'profile', valid)).toBe('personal');
    expect(resolveInitialTabId('#security', 'profile', valid)).toBe('security');
  });

  it('returns default for unknown hash', () => {
    expect(resolveInitialTabId('#unknown', 'profile', valid)).toBe('profile');
  });

  it('returns default for empty hash', () => {
    expect(resolveInitialTabId('', 'profile', valid)).toBe('profile');
    expect(resolveInitialTabId('#', 'profile', valid)).toBe('profile');
  });

  it('strips leading # from hash', () => {
    expect(resolveInitialTabId('#profile', 'profile', valid)).toBe('profile');
    expect(resolveInitialTabId('profile', 'profile', valid)).toBe('profile');
  });
});
```

- [ ] **Step 1.2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run src/renderer/components/sarah-tabs-logic.test.ts`
Expected: FAIL mit „Cannot find module './sarah-tabs-logic.js'" oder ähnlich (Datei existiert noch nicht).

- [ ] **Step 1.3: Logic-Modul implementieren**

Erstelle `src/renderer/components/sarah-tabs-logic.ts`:

```ts
/**
 * Pure helpers für sarah-tabs.
 *
 * Kapselt Keyboard-Mapping, Index-Arithmetik und URL-Hash-Resolution.
 * DOM-frei, damit in Node-Vitest ohne happy-dom/jsdom testbar.
 */

export type TabAction = 'next' | 'prev' | 'first' | 'last' | 'activate';

/**
 * Ordnet eine Keyboard-Taste einer Tab-Aktion zu.
 * Folgt dem WAI-ARIA Tabs-Pattern:
 *   - ArrowLeft / ArrowRight: Fokus wechseln
 *   - Home / End: zum ersten / letzten Tab springen
 *   - Enter / Space: aktuellen Fokus-Tab aktivieren
 */
export function keyToTabAction(key: string): TabAction | null {
  if (key === 'ArrowRight') return 'next';
  if (key === 'ArrowLeft') return 'prev';
  if (key === 'Home') return 'first';
  if (key === 'End') return 'last';
  if (key === 'Enter' || key === ' ') return 'activate';
  return null;
}

/**
 * Bestimmt den nächsten Tab-Index nach einer Aktion.
 * Wrap-around bei next/prev (letzter → erster, erster → letzter).
 * Bei leerer Tab-Liste (total === 0) wird der aktuelle Index zurückgegeben
 * (darf nicht crashen).
 */
export function nextTabIndex(
  current: number,
  action: 'next' | 'prev' | 'first' | 'last',
  total: number,
): number {
  if (total <= 0) return current;
  switch (action) {
    case 'next':  return (current + 1) % total;
    case 'prev':  return (current - 1 + total) % total;
    case 'first': return 0;
    case 'last':  return total - 1;
  }
}

/**
 * Löst den initial aktiven Tab aus dem URL-Hash auf.
 * Fällt auf `defaultId` zurück, wenn der Hash leer, ungültig oder nicht
 * in `validIds` enthalten ist. Führendes `#` wird optional gestripped.
 */
export function resolveInitialTabId(
  hash: string,
  defaultId: string,
  validIds: readonly string[],
): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return defaultId;
  return validIds.includes(raw) ? raw : defaultId;
}
```

- [ ] **Step 1.4: Tests laufen — müssen passen**

Run: `npx vitest run src/renderer/components/sarah-tabs-logic.test.ts`
Expected: alle Tests PASS (15 Assertions).

- [ ] **Step 1.5: Commit**

```bash
git add src/renderer/components/sarah-tabs-logic.ts src/renderer/components/sarah-tabs-logic.test.ts
git commit -m "feat(components): add sarah-tabs pure logic module with tests"
```

---

## Task 2: `sarah-tabs` Custom-Element-Klasse

**Files:**
- Create: `src/renderer/components/sarah-tabs.ts`

Die Klasse rendert den horizontalen Tab-Strip, verdrahtet Click- und Keyboard-Handler (Roving-Tabindex-Pattern), feuert `tab-change`-Event nur bei User-Interaktion. Keine Tests direkt an der DOM-Klasse — die deterministische Logik ist bereits in Task 1 getestet.

- [ ] **Step 2.1: Datei anlegen**

Erstelle `src/renderer/components/sarah-tabs.ts`:

```ts
import { SarahElement } from './base.js';
import { keyToTabAction, nextTabIndex } from './sarah-tabs-logic.js';

const CSS = `
  .tablist {
    display: flex;
    flex-direction: row;
    gap: var(--sarah-space-lg);
    border-bottom: 1px solid var(--sarah-border);
    padding: 0;
    margin: 0;
  }

  .tab {
    appearance: none;
    background: none;
    border: none;
    padding: var(--sarah-space-sm) 0;
    margin-bottom: -1px;
    color: var(--sarah-text-secondary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-md);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color var(--sarah-transition-fast), border-color var(--sarah-transition-fast);
  }

  .tab:hover {
    color: var(--sarah-text-primary);
  }

  .tab[aria-selected="true"] {
    color: var(--sarah-accent);
    border-bottom-color: var(--sarah-accent);
  }

  .tab:focus-visible {
    outline: 2px solid var(--sarah-accent-hover);
    outline-offset: 4px;
    border-radius: var(--sarah-radius-sm);
  }
`;

export interface TabItem {
  id: string;
  label: string;
}

export class SarahTabs extends SarahElement {
  private _tabs: TabItem[] = [];
  private _activeId: string | null = null;
  private container!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    this.container = document.createElement('div');
    this.container.className = 'tablist';
    this.container.setAttribute('role', 'tablist');
    this.container.setAttribute('aria-orientation', 'horizontal');
    this.root.appendChild(this.container);

    this.render();
  }

  setTabs(tabs: TabItem[]): void {
    this._tabs = tabs;
    if (this._activeId === null && tabs.length > 0) {
      this._activeId = tabs[0].id;
    }
    if (this.container) this.render();
  }

  /**
   * Programmatisch den aktiven Tab setzen.
   * Feuert KEIN `tab-change`-Event (Setter = externe Ursache, Event wäre Echo).
   */
  setActiveId(id: string): void {
    if (!this._tabs.some(t => t.id === id)) return;
    this._activeId = id;
    if (this.container) this.render();
  }

  getActiveId(): string | null {
    return this._activeId;
  }

  private render(): void {
    this.container.innerHTML = '';
    this._tabs.forEach((tab) => {
      const button = document.createElement('button');
      button.className = 'tab';
      button.type = 'button';
      button.id = `tab-${tab.id}`;
      button.textContent = tab.label;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `panel-${tab.id}`);
      const isActive = tab.id === this._activeId;
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      button.tabIndex = isActive ? 0 : -1;

      button.addEventListener('click', () => this.activate(tab.id));
      button.addEventListener('keydown', (e) => this.handleKey(e, tab.id));

      this.container.appendChild(button);
    });
  }

  private activate(id: string): void {
    if (id === this._activeId) return;
    this._activeId = id;
    this.render();
    this.focusTab(id);
    this.dispatchEvent(new CustomEvent('tab-change', {
      detail: { id },
      bubbles: true,
      composed: true,
    }));
  }

  private handleKey(e: KeyboardEvent, currentId: string): void {
    const action = keyToTabAction(e.key);
    if (action === null) return;
    e.preventDefault();

    if (action === 'activate') {
      this.activate(currentId);
      return;
    }

    const currentIndex = this._tabs.findIndex(t => t.id === currentId);
    if (currentIndex < 0) return;
    const nextIndex = nextTabIndex(currentIndex, action, this._tabs.length);
    const nextId = this._tabs[nextIndex].id;
    this.activate(nextId);
  }

  private focusTab(id: string): void {
    const btn = this.root.querySelector<HTMLElement>(`#tab-${id}`);
    btn?.focus();
  }
}

export function sarahTabs(props: {
  tabs: TabItem[];
  activeId?: string;
  onChange?: (id: string) => void;
}): SarahTabs {
  const el = document.createElement('sarah-tabs') as SarahTabs;
  el.setTabs(props.tabs);
  if (props.activeId) el.setActiveId(props.activeId);
  if (props.onChange) {
    el.addEventListener('tab-change', ((e: CustomEvent) => {
      props.onChange!(e.detail.id);
    }) as EventListener);
  }
  return el;
}
```

- [ ] **Step 2.2: Typecheck laufen lassen**

Run: `npm run typecheck:renderer`
Expected: kein Fehler in `sarah-tabs.ts`.

- [ ] **Step 2.3: Commit**

```bash
git add src/renderer/components/sarah-tabs.ts
git commit -m "feat(components): add sarah-tabs custom element"
```

---

## Task 3: Component-Registry erweitern

**Files:**
- Modify: `src/renderer/components/index.ts`

- [ ] **Step 3.1: Import + Export + Register ergänzen**

In `src/renderer/components/index.ts`:

Füge den Import am oberen Rand bei den anderen Component-Imports ein:

```ts
import { SarahTabs } from './sarah-tabs.js';
```

Füge den Export-Block hinzu (nach `SarahStepper`-Block, vor `SarahSlide`):

```ts
export { SarahTabs, sarahTabs } from './sarah-tabs.js';
export type { TabItem } from './sarah-tabs.js';
```

Füge in `registerComponents()` einen weiteren `customElements.define`-Aufruf ein (nach `sarah-stepper`):

```ts
customElements.define('sarah-tabs', SarahTabs);
```

- [ ] **Step 3.2: Typecheck**

Run: `npm run typecheck:renderer`
Expected: kein Fehler.

- [ ] **Step 3.3: Commit**

```bash
git add src/renderer/components/index.ts
git commit -m "feat(components): register sarah-tabs in component index"
```

---

## Task 4: CSS-Ergänzungen in `dashboard.css`

**Files:**
- Modify: `styles/dashboard.css`

- [ ] **Step 4.1: Regeln am Ende der Datei einfügen**

Hänge folgenden Block **ans Ende** von `styles/dashboard.css` (nach dem `#genesis-overlay`-Block und den `body:not(.boot-mode)` Regeln):

```css
/* ── Settings Tabs Layout ── */
.settings-tabs-wrapper {
  margin-bottom: var(--sarah-space-xl);
}

.settings-grid .settings-field-full {
  grid-column: 1 / -1;
}

.settings-footer-link {
  display: inline-block;
  margin-top: var(--sarah-space-xl);
  color: var(--sarah-text-muted);
  font-size: var(--sarah-font-size-sm);
  text-decoration: none;
  transition: color var(--sarah-transition-fast);
}

.settings-footer-link:hover {
  color: var(--sarah-accent);
}
```

**Hinweis:** Kein zusätzlicher `border-bottom` auf `.settings-tabs-wrapper` — die Border kommt bereits aus `sarah-tabs` selbst (`.tablist { border-bottom: ... }` im Shadow-DOM).

- [ ] **Step 4.2: Commit**

```bash
git add styles/dashboard.css
git commit -m "feat(styles): add settings tabs wrapper, field-full, footer-link rules"
```

---

## Task 5: Profile-Section erweitern

**Files:**
- Modify: `src/renderer/dashboard/views/sections/profile-section.ts`

Ergänze Nachname- und Adress-Felder (schon im `ProfileSchema`, aber bisher nicht im Settings-UI) und binde das Hobbys-Tag-Select ein.

- [ ] **Step 5.1: Datei komplett ersetzen**

Ersetze den gesamten Inhalt von `src/renderer/dashboard/views/sections/profile-section.ts` durch:

```ts
import { sarahInput } from '../../../components/sarah-input.js';
import { sarahTagSelect } from '../../../components/sarah-tag-select.js';
import { getSarah, showSaved, createSectionHeader, save } from '../../../shared/settings-utils.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

export function createProfileSection(config: SarahConfig): HTMLElement {
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
    label: 'Nachname',
    value: profile.lastName || '',
    onChange: (val) => { profile.lastName = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahInput({
    label: 'Stadt',
    value: profile.city || '',
    onChange: (val) => { profile.city = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahInput({
    label: 'Adresse',
    value: profile.address || '',
    onChange: (val) => { profile.address = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahInput({
    label: 'Beruf',
    value: profile.profession || '',
    onChange: (val) => { profile.profession = val; save('profile', profile); showSaved(feedback); },
  }));

  // Hobbys spannt volle Breite des Grids via .settings-field-full
  const hobbyOptions = (profile.hobbies || []).map((h) => ({ value: h, label: h }));
  const hobbies = sarahTagSelect({
    label: 'Hobbys',
    options: hobbyOptions,
    selected: profile.hobbies || [],
    allowCustom: true,
    onChange: (values) => {
      profile.hobbies = values;
      save('profile', profile);
      showSaved(feedback);
    },
  });
  hobbies.classList.add('settings-field-full');
  grid.appendChild(hobbies);

  section.appendChild(grid);
  return section;
}

// getSarah wird bereits transitively genutzt, aber für zukünftige Helpers hier re-exportiert
void getSarah;
```

**Hinweis zu Hobbys:** `allowCustom: true` lässt den User eigene Tags tippen. Bestehende Hobbys aus der Config werden als Tag-Options vorbelegt (und als `selected` markiert), damit sie sichtbar sind — `sarahTagSelect` rendert nur Tags aus `options`, nicht aus `selected` allein. `void getSarah` unterdrückt unused-import-Warnings, falls die Helper hier temporär nicht direkt verwendet werden.

- [ ] **Step 5.2: Typecheck**

Run: `npm run typecheck:renderer`
Expected: kein Fehler.

- [ ] **Step 5.3: Commit**

```bash
git add src/renderer/dashboard/views/sections/profile-section.ts
git commit -m "feat(settings): add lastName, address, hobbies to profile section"
```

---

## Task 6: Settings-View zum Orchestrator umbauen

**Files:**
- Modify: `src/renderer/dashboard/views/settings.ts`

Die bisherige lineare Liste wird ersetzt durch Tab-Strip + Panel-Container + Footer. Alle 5 Panels werden einmal initialisiert, `hidden`-Attribut schaltet Sichtbarkeit.

- [ ] **Step 6.1: Datei komplett ersetzen**

Ersetze den gesamten Inhalt von `src/renderer/dashboard/views/settings.ts` durch:

```ts
import { sarahTabs, type TabItem } from '../../components/sarah-tabs.js';
import { getSarah } from '../../shared/settings-utils.js';
import { resolveInitialTabId } from '../../components/sarah-tabs-logic.js';
import { createProfileSection } from './sections/profile-section.js';
import { createFilesSection } from './sections/files-section.js';
import { createTrustSection } from './sections/trust-section.js';
import { createPersonalizationSection } from './sections/personalization-section.js';
import { createControlsSection } from './sections/controls-section.js';
import { createAudioSection } from './sections/audio-section.js';
import type { SarahConfig } from '../../../core/config-schema.js';

type TabId = 'profile' | 'personal' | 'management' | 'control' | 'security';

const TABS: TabItem[] = [
  { id: 'profile',    label: 'Profil' },
  { id: 'personal',   label: 'Persönliche Einstellungen' },
  { id: 'management', label: 'Verwaltung' },
  { id: 'control',    label: 'Bedienung' },
  { id: 'security',   label: 'Sicherheit' },
];

const VALID_IDS = TABS.map(t => t.id);

function buildPanelContent(id: TabId, config: SarahConfig): HTMLElement[] {
  switch (id) {
    case 'profile':    return [createProfileSection(config)];
    case 'personal':   return [createPersonalizationSection(config), createAudioSection(config)];
    case 'management': return [createFilesSection(config)];
    case 'control':    return [createControlsSection(config)];
    case 'security':   return [createTrustSection(config)];
  }
}

export async function createSettingsView(): Promise<HTMLElement> {
  const container = document.createElement('div');

  const pageTitle = document.createElement('div');
  pageTitle.className = 'home-greeting settings-page-title';
  pageTitle.textContent = 'Einstellungen';
  container.appendChild(pageTitle);

  const config = await getSarah().getConfig();

  // Tab-Strip
  const initialId = resolveInitialTabId(location.hash, 'profile', VALID_IDS) as TabId;
  const tabStripWrapper = document.createElement('div');
  tabStripWrapper.className = 'settings-tabs-wrapper';
  const tabStrip = sarahTabs({
    tabs: TABS,
    activeId: initialId,
    onChange: (id) => showPanel(id as TabId),
  });
  tabStripWrapper.appendChild(tabStrip);
  container.appendChild(tabStripWrapper);

  // Panels — alle einmal rendern, inaktive verstecken
  const panelContainer = document.createElement('div');
  const panels: Record<TabId, HTMLElement> = {} as Record<TabId, HTMLElement>;
  for (const tab of TABS) {
    const panel = document.createElement('div');
    panel.id = `panel-${tab.id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `tab-${tab.id}`);
    for (const section of buildPanelContent(tab.id as TabId, config)) {
      panel.appendChild(section);
    }
    if (tab.id !== initialId) panel.hidden = true;
    panelContainer.appendChild(panel);
    panels[tab.id as TabId] = panel;
  }
  container.appendChild(panelContainer);

  // Footer-Link
  const footerLink = document.createElement('a');
  footerLink.className = 'settings-footer-link';
  footerLink.href = 'wizard.html';
  footerLink.textContent = 'Einrichtung erneut durchführen';
  container.appendChild(footerLink);

  // Tab-Switching
  let currentId: TabId = initialId;
  function showPanel(id: TabId): void {
    if (id === currentId) return;
    panels[currentId].hidden = true;
    panels[id].hidden = false;
    currentId = id;
    const url = `${location.pathname}${location.search}#${id}`;
    history.replaceState(null, '', url);
  }

  // Hash-Sync für Browser-Back/Forward
  const controller = new AbortController();
  window.addEventListener('hashchange', () => {
    const id = resolveInitialTabId(location.hash, 'profile', VALID_IDS) as TabId;
    if (id !== currentId) {
      tabStrip.setActiveId(id);
      panels[currentId].hidden = true;
      panels[id].hidden = false;
      currentId = id;
    }
  }, { signal: controller.signal });

  return container;
}
```

**Wichtige Details:**
- `panels[currentId].hidden = true; panels[id].hidden = false` — `hidden` Attribut bringt `display: none` und ARIA-Semantik automatisch.
- `history.replaceState(null, '', url)` mit `pathname + search + hash` — verhindert, dass `?view=settings` verloren geht.
- `AbortController` für den `hashchange`-Listener als Cleanup-Pattern (aktuell keine externe Teardown-Logik, aber sauber).
- Im `hashchange`-Handler ruft `tabStrip.setActiveId(id)` **keinen** `tab-change`-Event hervor — sonst entstünde Infinite-Loop zwischen Hash-Change und Tab-Activation.

- [ ] **Step 6.2: Typecheck**

Run: `npm run typecheck:renderer`
Expected: kein Fehler.

- [ ] **Step 6.3: Commit**

```bash
git add src/renderer/dashboard/views/settings.ts
git commit -m "refactor(settings): split into 5 tabs with hash-driven panel switching"
```

---

## Task 7: Vollständige Verifikation

**Files:**
- Keine Änderungen — nur Build + Test + manuelle Prüfung.

- [ ] **Step 7.1: Typecheck gesamter Renderer + Main**

Run: `npm run typecheck`
Expected: Keine Fehler.

- [ ] **Step 7.2: Vitest komplett laufen lassen**

Run: `npm run test:run`
Expected: alle bestehenden Tests + die neuen `sarah-tabs-logic`-Tests grün. Keine Regressionen.

- [ ] **Step 7.3: Renderer-Build verifizieren**

Run: `npm run build:renderer`
Expected: `esbuild` kompiliert `dialog.ts` (und damit transitiv `settings.ts`, `sarah-tabs.ts`) ohne Fehler.

- [ ] **Step 7.4: Manuelle UI-Prüfung durch Martin**

**Dieser Schritt ist Martin-Hand-Off — nicht automatisiert.**

Build+Electron starten: `npm start`

Martin öffnet die Settings-View (Sidebar → Settings-Icon) und prüft folgende Szenarien:

1. **Initial-Tab:** Default-Tab „Profil" ist aktiv (cyan Unterstrich, aria-selected sichtbar im Inspector).
2. **Neue Profil-Felder:** Nachname, Adresse sichtbar; Hobbys-Tag-Select zeigt bereits bestehende Hobbys (falls via Wizard gepflegt). Eingabe eines neuen Hobbys persistiert.
3. **Tab-Klick:** Wechsel zu „Persönliche Einstellungen" zeigt Personalisierung + Audio zwei-geteilt untereinander. Zurück zu „Profil" zeigt die **vorher eingegebenen Werte** (Staleness-Test).
4. **URL-Hash:** Nach Tab-Wechsel enthält die URL `?view=settings#personal` (oder entsprechend). Reload behält den Tab.
5. **Tastatur-Nav:** Fokus auf einem Tab, `ArrowRight` wechselt zum nächsten (wrap-around am Ende zum ersten Tab). `Home`/`End` springt zum ersten/letzten.
6. **Footer-Link:** „Einrichtung erneut durchführen" navigiert zur Wizard.html.
7. **Sicherheit-Tab:** Memory-Toggle, Exclusions, Dateizugriff, Bestätigungen sichtbar (bisheriger Trust-Section-Inhalt).

Wenn alles passt: `- [ ] Step 7.4` abhaken und weiter.

- [ ] **Step 7.5: PR vorbereiten**

Nur, wenn Schritt 7.4 grün ist. Branch pushen und PR gegen `dev` öffnen:

```bash
git push -u origin refactor/settings
gh pr create --base dev --title "refactor(settings): split into 5 thematic tabs" --body "$(cat <<'EOF'
## Summary
- Settings aufgeteilt in 5 thematische Tabs (Profil / Persönliche Einstellungen / Verwaltung / Bedienung / Sicherheit)
- Neue `sarah-tabs`-Komponente (Web Component, ARIA-konform, Keyboard-Nav)
- Profil-Sektion um Nachname, Adresse und Hobbys (neu im UI) erweitert
- Wizard-Action als dezenter Footer-Link unter den Tabs
- URL-Hash persistiert Tab-Auswahl über Reloads

## Architektur-Entscheidung
Alle 5 Tab-Panels werden einmalig beim Initial-Render erzeugt und via `hidden`-Attribut umgeschaltet (Hide/Show statt Destroy/Recreate). Grund: Sections halten Closure-State, ein Recreate würde auf den stale Config-Snapshot zurückfallen.

## Out-of-Scope (Folge-Specs)
- Visuelle Cockpit-Angleichung (globale `--cockpit-*`-Tokens)
- Programme-Verwaltungs-Panel im „Verwaltung"-Tab
- Links-mit-Zweckbeschreibung-Feature (`resources.favoriteLinks`-Schema-Erweiterung)

## Test plan
- [ ] Typecheck grün (`npm run typecheck`)
- [ ] Vitest grün (`npm run test:run`) — inkl. neuer `sarah-tabs-logic`-Tests
- [ ] Manuelle UI-Prüfung laut Plan-Step 7.4 durchgeführt

Spec: `docs/superpowers/specs/2026-04-22-settings-tabs-design.md`
Plan: `docs/superpowers/plans/2026-04-22-settings-tabs.md`
EOF
)"
```

---

## Abschluss-Checks

- Alle Tasks abgehakt? ✓
- `npm run typecheck` grün?
- `npm run test:run` grün?
- Manueller UI-Check (Step 7.4) durch Martin bestätigt?
- PR gegen `dev` offen?

Wenn ja — Plan abgeschlossen. Nach Merge: Memory-Eintrag `project_settings_tabs.md` aktualisieren (Tab-Refactor erledigt, visuelle Angleichung als Next-Up notiert).
