# Spec-Review: `2026-04-24-metallic-shimmer-design.md`

**Reviewer:** Prüfende Instanz  
**Datum:** 2026-04-25  
**Branch:** `feat/cockpit-themes`  
**Fazit:** 2 blocking Fehler, 1 Design-Schwäche, Rest ist solide

---

## ❌ BLOCKING #1 — Settings & Wizard Scope ist Dead Code

**Wo:** Tabelle "Scope — Welche Bereiche bekommen den Effekt?" + Abschnitt "Scope-Overrides"

**Befund:** `sarah-panel` / `sarahPanel()` wird im gesamten Renderer **ausschließlich in `home.ts`** (Cockpit-View) benutzt. Settings und Wizard verwenden plain `<div>`-Elemente.

Beweis via Grep — alle `sarahPanel`-Importe/Aufrufe:
```
src/renderer/dashboard/views/home.ts  ← 6× verwendet
src/renderer/components/sarah-panel.ts  ← Definition
src/renderer/components/index.ts  ← Re-Export
```

Settings (`createSettingsView`) rendert Tab-`<div>`-Container mit Section-Factories. Wizard-Steps rendern Form-Elemente in `#slide-area`. **Keine dieser Stellen instanziiert ein `<sarah-panel>` Custom Element.**

**Konsequenz:** Das Setzen von `--jitter-scale: 0.5` in `settings.ts` und `--jitter-scale: 0` im Wizard-Root ist vollständig wirkungslos. Tote Property-Sets, die keinen Empfänger haben.

**Fix-Optionen:**
- A) Scope-Tabelle bereinigen: Settings = `—` (kein Panel), Wizard = `—`. Nur Cockpit ist der echte Scope.
- B) Spec als "Future Scope wenn settings.ts je sarah-panel bekommt" klar markieren und die Code-Änderungen aus dem Implementation-Plan für Settings/Wizard herausstreichen.

Option A ist ehrlicher.

---

## ❌ BLOCKING #2 — Wizard hat keinen JS-Root-Container

**Wo:** Abschnitt "Scope-Overrides" → "Im Wizard-Root"

**Befund:** `wizard.ts` erstellt keinen Root-Container mit `document.createElement`. Die Architektur ist:

```ts
// wizard.ts
const controller = new WizardController(
  wizardData,
  STEPS,
  {
    sidebar: document.getElementById('sidebar')!,
    slideArea: document.getElementById('slide-area')!,
    navArea: document.getElementById('nav-area')!,
  },
  sarah,
);
```

Der Wizard arbeitet direkt mit statischen `<div>`-Elementen aus `wizard.html`. Es gibt keine Variable `wizardRoot`, auf der man `style.setProperty(...)` aufrufen könnte. Der Einbau-Punkt "entweder in `wizard.ts` beim Setup oder als Style-Attribut in `wizard.html`" beschreibt zwar beide echten Optionen, aber nur `wizard.html` wäre tatsächlich umsetzbar:

```html
<body style="--jitter-scale: 0">
```

Relevant aber: Auch das ist wegen Blocking #1 ein No-Op, da Wizard keine Panels hat. Dieser Punkt fällt also weg, sobald Blocking #1 behoben ist.

---

## ⚠️ DESIGN-SCHWÄCHE — `connectedCallback` ohne Doppel-Mount-Guard

**Wo:** TypeScript-Änderung im `connectedCallback`

**Befund:** `connectedCallback` hat keinen Guard gegen mehrfache Ausführung. Wird ein `<sarah-panel>` Element disconnected und reconnected (z.B. durch DOM-Mutations bei View-Wechseln), laufen folgende Operationen erneut:

1. `this.injectStyles(CSS)` → ein weiteres `<style>`-Tag im Shadow Root
2. `this.wrapperEl = document.createElement('div')` → ein neues `panel-wrapper` wird erzeugt und angehängt
3. `this.style.setProperty('--jitter-phase', ...)` → Phase wird neu randomisiert → sichtbarer Sprung in der laufenden Animation

Das ist ein **pre-existing Bug** in `sarah-panel.ts`, den diese Spec nicht verursacht. Die Spec schreibt aber `connectedCallback` an und sollte das Problem nicht verschweigen oder verschlimmern.

**Risiko in der Praxis:** Niedrig. Das Cockpit-Grid ist für die App-Laufzeit statisch — Panels werden nicht disconnected. Trotzdem: falls der Implementation-Plan einen Guard hinzufügt (den man hier "kostenlos" mitschreiben könnte), wäre die Codequalität besser.

**Empfehlung:** In der Forward-Looking-Sektion als bekannten Tech-Debt notieren oder im Implementation-Plan einen `if (this.wrapperEl) return;`-Guard am Anfang von `connectedCallback` vorschlagen.

---

## ✅ BESTÄTIGTE KORREKTE ANNAHMEN

Die folgenden Annahmen wurden gegen den echten Code verifiziert:

| Annahme | Ergebnis |
|---|---|
| `--sarah-panel-accent-gradient-*` Tokens existieren in `theme.css` | ✓ Alle 4 Varianten vorhanden |
| `--sarah-bg-panel` bereits migriert (Palette-Spec implementiert) | ✓ `sarah-panel.ts` nutzt `var(--sarah-bg-panel)` |
| `background:` Shorthand auf `.panel-wrapper` und allen Accent-Overrides | ✓ Bestätigt — Refactor zu `background-image:` notwendig und korrekt |
| `var()` in `@keyframes` für `background-position` (Chromium/Electron) | ✓ Funktioniert in modernem Chromium, keine Einschränkungen |
| CSS Custom Properties erben durch Shadow DOM Boundary | ✓ Standard-Verhalten, wird von `sarah-panel.ts` bereits genutzt |
| `prefers-reduced-motion` mit `animation: none` stoppt beide Animationen | ✓ Der bestehende Block resettet alle Animation-Sub-Properties |
| `background-size: calc(100% + 16px)` — ±4px Bewegung bleibt im 8px-Overflow | ✓ Mathe stimmt: Overflow = 8px pro Seite, Max-Amplitude = 4px |
| `cockpit-panel-breathe` (opacity) und `cockpit-panel-jitter` (background-position) sind orthogonal | ✓ Unterschiedliche CSS-Properties, kein Konflikt |
| Error-State: `background-image: none` macht Animation visuell unsichtbar | ✓ Solid Color hat keine Hotspots — gewolltes Verhalten |
| `this.style.setProperty('--jitter-phase', ...)` auf Host überschreibt Vererbung | ✓ Inline-Style hat höchste Cascade-Priorität, Panel-Wert schlägt immer durch |
| `animation-delay: 0s, var(--jitter-phase, 0s)` als separate Property nach Shorthand | ✓ Valides CSS, Shorthand-Delay wird korrekt überschrieben |

---

## ZUSAMMENFASSUNG FÜR IMPLEMENTATION-PLAN

**Was rausgestrichen werden kann:**
- `settings.ts` — die eine `style.setProperty`-Zeile (kein Empfänger)
- Wizard-Root-Scope-Override komplett (kein Empfänger, kein eindeutiger Container)
- Zeile in der Scope-Tabelle für Settings und Wizard (oder mit Notiz "aktuell no-op, für spätere Panel-Migration")

**Was korrekt bleibt und direkt implementierbar ist:**
- Alles in `sarah-panel.ts`: CSS-Refactor, Keyframes, `connectedCallback`-Zeile
- Cockpit Default `--jitter-scale: 1` ohne Eingriff ✓
- Der ganze technische Kern der Spec ist solide

**Änderungsaufwand** nach den Fixes: minimal — es entfällt eher Arbeit (zwei "Zeilen" werden gestrichen), der Kern bleibt.
