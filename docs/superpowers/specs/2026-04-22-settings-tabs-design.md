# Settings Tab-Refactor — Design Spec

## Überblick

Die Settings-Ansicht (`src/renderer/dashboard/views/settings.ts`) rendert aktuell alle sechs Sektionen (Profil, Dateien & Ordner, Vertrauen, Personalisierung, Steuerung, Audio) untereinander in einer langen Scroll-Liste. Dieser Refactor teilt die Settings in **5 thematische Tabs** auf, führt dafür eine neue `sarah-tabs`-Komponente ein und ergänzt die Profil-Sektion um Felder, die bislang nur im Wizard gepflegt wurden (inkl. `Hobbys`).

**Nicht** Teil dieses Specs: visuelle Angleichung an die Cockpit-Farbsprache (globale `--cockpit-*`-Tokens in Root-Variablen schieben) — eigener Folge-Spec, app-weit, nicht settings-only.

## Motivation

- Die Liste wird mit jedem zusätzlichen Setting länger und schlechter navigierbar.
- Slash-Command-Verwaltung (in `Steuerung`) und PDF-Kategorien (in `Dateien`) sind bereits lange Sub-Listen, die innerhalb einer Scroll-Seite untergehen.
- Thematisch verwandte Settings (Persönliches vs. Bedienung vs. Sicherheit) lassen sich durch Tabs klarer gruppieren.
- Im Schema existierende Profil-Felder (`lastName`, `address`, `hobbies`) sind derzeit nur über den Wizard erreichbar.

## Scope

**In-Scope:**
- Tab-Navigation (5 Tabs) via neuer `sarah-tabs`-Komponente
- Settings-View-Umbau zu Orchestrator (Tab-Strip, selektives Content-Rendering, Hash-State)
- Profil-Sektion: zusätzliche Felder (`lastName`, `address`, `hobbies`) inkl. UI für Hobbys
- „Einrichtung erneut durchführen" als Footer-Link unter den Tabs
- Unit-Tests für `sarah-tabs`

**Out-of-Scope (separate Specs):**
- Globale Farb-/Visuell-Angleichung an die Cockpit-Sprache
- Programme-Verwaltungs-Panel (Tab „Verwaltung")
- Links-mit-Zweckbeschreibung-Feature (Schema-Erweiterung auf `{url, purpose}`)
- Activities/UsagePurposes im Settings-UI (bleiben Wizard-only)

## Tab-Struktur

| # | Tab-ID       | Tab-Label                | Inhalt                                                                                       |
|---|--------------|--------------------------|----------------------------------------------------------------------------------------------|
| 1 | `profile`    | Profil                   | Erweiterte Profil-Sektion                                                                    |
| 2 | `personal`   | Persönliche Einstellungen| Personalisierung + Audio (zwei `settings-section`s untereinander)                            |
| 3 | `management` | Verwaltung               | Dateien & Ordner (anfangs alleine; Programme/Links folgen in späteren Specs)                 |
| 4 | `control`    | Bedienung                | Steuerung (Voice-Mode, Push-to-Talk, Quiet-Mode, LLM-Leistungsprofil, Slash-Commands)        |
| 5 | `security`   | Sicherheit               | Vertrauen & Sicherheit                                                                       |

**Wizard-Action** („Einrichtung erneut durchführen") sitzt als dezenter Footer-Link **unter** dem Tab-Content, außerhalb der Tabs, auf jedem Tab sichtbar.

## Profil-Sektion — erweiterte Felder

Aktuelle Felder (`profile-section.ts`): `displayName`, `city`, `profession`.

Neu hinzu:

- `lastName` (Input, Label „Nachname")
- `address` (Input, Label „Adresse")
- `hobbies` (`sarahTagSelect` mit `allowCustom: true`, leere `options`-Liste, Label „Hobbys")

Layout:

```
settings-grid (2 Spalten):
  Anzeigename | Nachname
  Stadt       | Adresse
  Beruf       |
(darunter, volle Breite — grid-column: 1 / -1:)
  Hobbys (tag-select)
```

Das Hobbys-Element bekommt Klasse `.settings-field-full` (neu, s. CSS-Ergänzungen), damit `grid-column: 1 / -1` greift und es die Grid-Breite überspannt.

Alle Felder schreiben via bestehendem `save('profile', profile)`-Pattern. Kein neues Save-Routing.

**Bewusst nicht** im Settings-UI:
- `activities` (Aktivitäten) und `usagePurposes` (Nutzungsabsicht) — Wizard-Onboarding-Felder, sind für den Alltag nicht relevant.

## `sarah-tabs` Komponente

Neue Komponente in `src/renderer/components/sarah-tabs.ts`, Pattern analog zu `sarah-stepper`.

### API

```ts
export interface TabItem {
  id: string;
  label: string;
}

export class SarahTabs extends SarahElement {
  setTabs(tabs: TabItem[]): void;
  setActiveId(id: string): void;  // programmatisch aktiven Tab setzen (z. B. durch hashchange)
  // feuert 'tab-change' CustomEvent<{ id: string }>
}

export function sarahTabs(props: {
  tabs: TabItem[];
  activeId?: string;
  onChange?: (id: string) => void;
}): SarahTabs;
```

`setActiveId` löst **kein** `tab-change`-Event aus (programmatischer Setter ist externe Ursache — Event wäre Echo). Nur User-Click feuert das Event.

### Verhalten

- **Rendering:** Horizontaler Strip mit Tab-Labels als klickbare Items. Aktives Tab visuell via Unterstrich + `--sarah-accent` hervorgehoben.
- **Kein Content-Management:** Die Komponente rendert nur den Strip. Die Settings-View verwaltet die Tab-Panels selbst (s.u., „Settings-View-Umbau").
- **Event:** `tab-change` (CustomEvent mit `detail: { id: string }`) — bubbles/composed analog zu `step-click` im Stepper.
- **Keyboard-Navigation:** ← / → wechselt den Fokus zwischen Tabs, Enter/Space aktiviert. `Home`/`End` springt zum ersten/letzten Tab.
- **ARIA:**
  - Container: `role="tablist"` + `aria-orientation="horizontal"`
  - Tab-Items: `role="tab"`, `aria-selected` entsprechend State, `tabindex="0"` auf aktivem / `-1` auf inaktiven Tabs (Roving-Tabindex-Pattern)
  - Panel-Container (von Settings-View gemanaged): `role="tabpanel"` + `aria-labelledby="<tab-id>"`

### Styling

Scoped Shadow-DOM-CSS innerhalb von `sarah-tabs.ts`, Tokens aus `--sarah-*`:
- Flex-Row Container, Gap `--sarah-space-lg`
- Tab-Item: Padding, `color: --sarah-text-secondary`, aktiv: `color: --sarah-text-primary` + 2px Bottom-Border `--sarah-accent`
- Hover auf inaktivem Tab: `color: --sarah-text-primary`
- Focus-Ring: `outline: 2px solid --sarah-accent-hover`

Ca. 40–60 Zeilen CSS.

### Tests

`src/renderer/components/sarah-tabs.test.ts`:

1. Rendert alle Tab-Labels
2. Initial ist der per `activeId` angegebene Tab `aria-selected="true"`
3. Click auf einen anderen Tab → `tab-change`-Event mit richtiger `id` feuert
4. Nach Click ist der neue Tab `aria-selected="true"`, alter `"false"`
5. Keyboard: `ArrowRight` bewegt Fokus nächsten Tab, `ArrowLeft` vorherigen
6. `Home`/`End` springt zum ersten/letzten Tab

## Settings-View-Umbau

`src/renderer/dashboard/views/settings.ts` wird zum Orchestrator:

```
createSettingsView()
├── Page-Title ("Einstellungen")
├── Tab-Strip (sarah-tabs)
├── Tab-Content-Container
│     ├── Panel profile    (role="tabpanel")
│     ├── Panel personal
│     ├── Panel management
│     ├── Panel control
│     └── Panel security   (alle einmalig gerendert, nur aktives sichtbar)
└── Footer-Link ("Einrichtung erneut durchführen")
```

### Render-Logik

**Strategie: Hide/Show statt Destroy/Recreate.** Alle Tab-Panels werden **einmal** beim Initialrender erzeugt und bleiben im DOM. Tab-Wechsel schaltet nur Sichtbarkeit um. Gründe:

- Sections halten Closure-State (`const profile = { ...config.profile }`) plus User-Eingaben, die noch nicht gespeichert sind. Destroy/Recreate würde bei Rückkehr auf einen stale Config-Snapshot zurückfallen (`save()` schreibt zur DB, aber nicht zurück ins in-memory `config`-Objekt).
- ARIA-Tab-Pattern verlangt `aria-hidden`/`hidden` auf inaktiven Panels, nicht DOM-Manipulation.
- Performance: Section-Factories laufen nur einmal, keine Re-Binding-Kosten pro Tab-Wechsel.

**Ablauf:**

1. Config **einmal** laden (`await getSarah().getConfig()`) vor erstem Render.
2. Mapping `tabId → Section-Factories`:
   ```ts
   const TAB_CONTENT: Record<TabId, (cfg: SarahConfig) => HTMLElement[]> = {
     profile:    (c) => [createProfileSection(c)],
     personal:   (c) => [createPersonalizationSection(c), createAudioSection(c)],
     management: (c) => [createFilesSection(c)],
     control:    (c) => [createControlsSection(c)],
     security:   (c) => [createTrustSection(c)],
   };
   ```
3. **Initialrender:** Für jeden Tab ein Panel-Wrapper (`<div role="tabpanel" id="panel-<tabId>" aria-labelledby="tab-<tabId>">`) erzeugen, Sections hineinhängen. Alle Panels in den Content-Container.
4. Aktiver Tab aus `location.hash` (ohne `#`), fallback `profile`. Ungültige Werte → `profile`.
5. Initial nur das aktive Panel sichtbar. Inaktive: `hidden` Attribut gesetzt (keine CSS-Klasse nötig, `hidden` bringt `display: none` + `aria-hidden` semantisch mit).
6. Bei `tab-change`:
   - Bisher aktives Panel: `hidden = true`
   - Neues Panel: `hidden = false`
   - URL-Hash aktualisieren (s. u.) — kein Scroll-Jump
7. `hashchange`-Listener für Browser-Back/Forward: liest Hash, ruft `tabStrip.setActiveId(id)` + führt denselben Hide/Show-Switch durch.

### URL-Hash-Handling

```ts
const url = `${location.pathname}${location.search}#${newId}`;
history.replaceState(null, '', url);
```

**Wichtig:** `pathname + search` muss erhalten bleiben. `dialog.html?view=settings` wäre sonst nach dem ersten Tab-Wechsel zu `dialog.html#personal` degradiert → Reload würde die Settings-View nicht mehr laden.

### Listener-Cleanup

`hashchange`-Listener via `AbortController`:

```ts
const controller = new AbortController();
window.addEventListener('hashchange', handler, { signal: controller.signal });
// Cleanup-Hook für spätere View-Teardown (aktuell: Fenster-Close räumt auf, aber AbortController ist sauberer Pattern)
```

In `createSettingsView` wird der Controller im DOM-Root als WeakRef / data-Attribut hinterlegt oder direkt als Return-Wert exportiert, falls die dialog.ts später Teardown-Logik bekommt. Aktuell: bei Fenster-Close wird alles zerstört — der Controller ist Vorarbeit, kein akuter Fix.

### Footer-Link

Nach dem Tab-Content-Container, außerhalb. Kleines `<a>`-Element mit:
- Text „Einrichtung erneut durchführen"
- Klasse `.settings-footer-link`
- `href="wizard.html"`
- Styling: Farbe `--sarah-text-muted`, hover → `--sarah-accent`, Font-Size `--sarah-font-size-sm`, `text-decoration: none`

Regel in `dashboard.css` (~10 Zeilen).

## File-Struktur

```
src/renderer/
├── components/
│   ├── sarah-tabs.ts              (NEU)
│   ├── sarah-tabs.test.ts         (NEU)
│   └── index.ts                   (+ registerComponents: sarah-tabs)
├── dashboard/views/
│   ├── settings.ts                (umgebaut — Orchestrator)
│   └── sections/
│       ├── profile-section.ts     (+ lastName, address, hobbies)
│       ├── personalization-section.ts  (unverändert)
│       ├── audio-section.ts            (unverändert)
│       ├── files-section.ts            (unverändert)
│       ├── controls-section.ts         (unverändert)
│       └── trust-section.ts            (unverändert)
styles/
└── dashboard.css                   (+ .settings-tabs-wrapper, .settings-footer-link)
```

**Section-APIs bleiben unverändert.** Nur die Komposition in `settings.ts` ändert sich. Das hält den Diff klein und vermeidet Kollateralschäden.

## CSS-Ergänzungen in `dashboard.css`

```css
.settings-tabs-wrapper {
  margin-bottom: var(--sarah-space-xl);
  border-bottom: 1px solid var(--sarah-border);
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

Der bestehende `.settings-page-title`-Margin bleibt, damit der Titel oberhalb des Tab-Strips sitzt.

## State & Persistenz

- **Tab-Wahl persistiert über Reload** via URL-Hash (`dialog.html?view=settings#personal`). Keine `localStorage`-Nutzung nötig.
- Config-Saves bleiben unverändert (bestehendes `save()`-Pattern aus `settings-utils.ts`).

## Abgrenzung

- Visuelle Cockpit-Angleichung (Palette, Fonts, Chamfered Panels) wird **explizit nicht** Teil dieses Specs. Die Tabs nutzen `--sarah-*`-Tokens, damit der spätere Farb-Spec (globaler `--cockpit-*`-Rollout) ohne Settings-Änderung greift.
- Programme-Verwaltungs-Panel und Links-Feature fallen in separate Specs; der Tab `management` bleibt anfangs nur mit „Dateien & Ordner" bestückt.
- Keine neuen Tests für bestehende Section-Dateien — unverändert, kein Test-Schulden-Aufbau ohne Anlass.
