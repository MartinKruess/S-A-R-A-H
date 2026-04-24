# Metallic Shimmer (Chrom-Jitter) — Design Spec

**Datum:** 2026-04-24
**Branch:** `feat/cockpit-themes`
**Status:** Draft — wartet auf User-Review vor Implementation-Plan

## Ziel

Panels in der Cockpit-UI sollen einen **subtilen, organischen Schimmer-Effekt** bekommen, der simuliert, wie Licht auf einer leicht vibrierenden spiegelnden Metalloberfläche reflektiert. Ziel ist, dass die UI "lebendig" wirkt statt statisch, ohne aufdringlich zu sein.

**Wichtig:** Diese Spec behandelt **ausschließlich den Bewegungs-Mechanismus** (den "Jitter"). Der eigentliche Chrom-Rahmen-Look (metallische Highlight-Streifen, Eckakzente, brushed-metal-Oberflächenfarbe) ist ein **separater Brainstorm** in einer folgenden Iteration ("Phase 2").

## Kern-Entscheidungen (aus Brainstorming)

| Entscheidung | Wert |
|---|---|
| Effekt-Typ | **Jitter** (Hotspots wandern um Ruheposition), nicht Sheen (Licht zieht vorbei) |
| Horizontale Amplitude | 4px (±4px vom Zentrum) |
| Vertikale Amplitude | 2px (±2px vom Zentrum) → elliptische Bewegung, keine reine Kreisbewegung |
| Zyklus-Dauer | 16s |
| Easing | `linear` (kontinuierliche Geschwindigkeit, kein Pendel) |
| Synchronität | **Asynchron** — jedes Panel hat einen zufälligen Phasen-Offset |
| Listening-State (mint) | Jitter läuft normal weiter (Option A — schneller/langsamer als Forward-Looking-TODO notiert) |
| Reduced-Motion | `prefers-reduced-motion: reduce` stoppt die Animation komplett |
| Umsetzungs-Technik | CSS `background-position`-Animation auf dem bestehenden Panel-Gradient-Hintergrund |

## Scope — Welche Bereiche bekommen den Effekt?

| Bereich | `--jitter-scale` | Effekt |
|---|---|---|
| **Cockpit** (`dashboard/views/home.ts`) | `1` (Default) | 4px / 2px elliptische Bewegung auf allen `<sarah-panel>`-Instanzen |
| **Settings** (`dashboard/views/settings.ts`) | `0.5` | 2px / 1px — subliminal, kaum merkbar |
| **Wizard** (`wizard/wizard.ts` Root) | `0` | Animation läuft, Bewegung null — Wizard soll ruhig/fokussiert wirken |
| **Boot-Sequence** | — | Kein Handling nötig, läuft nur Sekunden und hat eigene Animationen |
| **Zukünftige Sarah-View/Chat** | `0.5` (TODO) | Subliminal wie Settings, wenn die View gebaut wird |

## Architektur

Der Jitter wird **ausschließlich** im `sarah-panel.ts` Web Component implementiert. Der Component lebt im Shadow DOM — externes CSS kann den Shadow nicht erreichen. CSS Custom Properties vererben aber durch die Shadow-DOM-Grenze, also wird die Scope-Steuerung von außen via **Custom Properties** realisiert.

**Änderungs-Umfang (Files):**

| Datei | Art der Änderung |
|---|---|
| `src/renderer/components/sarah-panel.ts` | Shadow-DOM-CSS erweitern (Jitter-Keyframes, background-image-Refactor), eine Zeile im `connectedCallback` für Phase-Randomisierung |
| `src/renderer/dashboard/views/settings.ts` | Eine Zeile: `container.style.setProperty('--jitter-scale', '0.5')` am Root-Container |
| `src/renderer/wizard/wizard.ts` (oder analoger Wizard-Root-Init) | Eine Zeile: `--jitter-scale: 0` am Wizard-Root. Konkreter Einbau-Punkt im Implementation-Plan festzulegen. |

**Keine neuen Dateien. Keine Änderungen an `styles/cockpit.css` oder `styles/theme.css`.**

## Technische Umsetzung

### Custom Properties Interface

Diese können von außen via Vererbung überschrieben werden:

| Property | Default | Zweck |
|---|---|---|
| `--jitter-scale` | `1` | Amplituden-Multiplikator. `0.5` = halb so stark (subliminal), `0` = Animation läuft, Bewegung null |
| `--jitter-phase` | `0s` | Wird pro Panel-Instanz im `connectedCallback` auf einen zufälligen negativen Wert gesetzt, damit Panels asynchron laufen |

### CSS-Block (innerhalb `sarah-panel.ts`)

**Basis — Änderung der bestehenden `.panel-wrapper`-Regel:**

```css
.panel-wrapper {
  /* bestehende Props bleiben: position, padding, box-shadow, clip-path, height, transition */
  background-image: var(--panel-accent, var(--sarah-panel-accent-gradient-cyan));
  background-size: calc(100% + 16px) calc(100% + 16px);
  background-position: 50% 50%;
  animation:
    cockpit-panel-breathe 6s ease-in-out infinite,
    cockpit-panel-jitter 16s linear infinite;
  animation-delay: 0s, var(--jitter-phase, 0s);
}
```

**Accent-Overrides:** Alle `:host([accent="..."]) .panel-wrapper`-Blöcke wechseln von `background:` auf `background-image:`, damit `background-size`/`background-position` nicht durch das Shorthand zurückgesetzt werden:

```css
:host([accent="violet"]) .panel-wrapper { background-image: var(--panel-accent, var(--sarah-panel-accent-gradient-violet)); }
:host([accent="pink"])   .panel-wrapper { background-image: var(--panel-accent, var(--sarah-panel-accent-gradient-pink)); }
:host([accent="mint"])   .panel-wrapper { background-image: var(--panel-accent, var(--sarah-panel-accent-gradient-mint)); }
```

**Error-State:** Solid color statt Gradient — `background-color` + `background-image: none`, damit kein Gradient-Overlay zurückbleibt:

```css
:host([state="error"]) .panel-wrapper {
  background-color: var(--cockpit-accent-red);
  background-image: none;
}
```

**Neuer Keyframes-Block (elliptische 4-Punkt-Bewegung + Loop-Close):**

```css
@keyframes cockpit-panel-jitter {
  0% {
    background-position:
      calc(50% + 4px * var(--jitter-scale, 1))
      50%;
  }
  25% {
    background-position:
      50%
      calc(50% + 2px * var(--jitter-scale, 1));
  }
  50% {
    background-position:
      calc(50% - 4px * var(--jitter-scale, 1))
      50%;
  }
  75% {
    background-position:
      50%
      calc(50% - 2px * var(--jitter-scale, 1));
  }
  100% {
    background-position:
      calc(50% + 4px * var(--jitter-scale, 1))
      50%;
  }
}
```

**Reduced-Motion:** Der bestehende `@media (prefers-reduced-motion: reduce)`-Block am Ende der Shadow-CSS braucht **keine Erweiterung** — `animation: none` resettet bereits alle Animationen des Elements (breathe + jitter).

### TypeScript-Änderung im `connectedCallback`

In `sarah-panel.ts`, nach dem existierenden `setAttribute('state', ...)`-Block, **eine Zeile** einfügen:

```ts
this.style.setProperty('--jitter-phase', `${-Math.random() * 16}s`);
```

**Wirkung:** Jedes Panel bekommt beim Mounten einen einmaligen zufälligen Negativ-Delay zwischen `-16s` und `0s`. Der Browser interpretiert den negativen Delay als "Animation hat schon X Sekunden gelaufen" und startet bei entsprechender Frame-Position. Ergebnis: 8 Panels laufen an 8 verschiedenen Positionen in der 16s-Ellipse.

### Scope-Overrides (Inline-Style an Root-Containern)

**In `dashboard/views/settings.ts`** — direkt nach `const container = document.createElement('div')` (Zeile 35):

```ts
container.style.setProperty('--jitter-scale', '0.5');
```

**Im Wizard-Root** (konkreter Ort in Implementation zu finden — entweder in `wizard.ts` beim Setup oder als Style-Attribut in `wizard.html`):

```ts
wizardRoot.style.setProperty('--jitter-scale', '0');
```

**Cockpit:** Keine Änderung — Default `1` greift ohne Eingriff.

## Kompatibilitäts-Matrix

| Attribut / State | Verhalten mit Jitter |
|---|---|
| `accent="cyan"` (Default) | Jitter läuft normal |
| `accent="violet"` / `"pink"` / `"mint"` | Gleiches Verhalten — accent tauscht nur das Gradient-Image, `background-size`/`background-position` bleiben durch longhand-Nutzung erhalten |
| Listening (accent="mint") | Jitter läuft normal weiter — Entscheidung Option A aus Brainstorming |
| `state="error"` | Solid roter Hintergrund, kein Gradient → Animation läuft, aber Bewegung ist visuell unsichtbar (Solid-Color hat keine inneren Hotspots). Gewünscht: Error soll klar/statisch wirken. |
| `state="loading"` / `"stale"` | Ändern nur Kind-Opacity, kein Konflikt mit background-position |
| `:hover` | Ändert nur `box-shadow`, kein Konflikt |
| `prefers-reduced-motion: reduce` | Bestehender `animation: none`-Reset stoppt beide Animationen (breathe + jitter) |
| Koexistenz mit `cockpit-panel-breathe` (6s opacity) | Orthogonal — unterschiedliche CSS-Properties, kein Konflikt |

## Performance-Erwartung

- `background-position` gehört nicht zu den klassischen compositor-only Properties (`transform`/`opacity`), erzeugt also pro Frame technisch Paint-Arbeit
- Bei statischem Gradient-Bild und Amplitude ≤ 4px bleibt die Paint-Region aber winzig — Chromium cached den Gradient und resamplet nur die Sichtfenster-Position
- Bei 8 Panels × 16s-Animation: je Panel ≈ 60 fps × 0,4 % Box-Paint-Delta — messbarer Overhead vernachlässigbar
- `connectedCallback`-Zeile: 1× `Math.random()` + 1× `setProperty` pro Panel-Mount — vernachlässigbar
- Auf Ziel-Hardware (RTX 3050, Sarah läuft parallel zu Ollama/Voice-Last): kein spürbarer Impact erwartet; falls Benchmarks in der Implementation-Phase anders ausfallen, kann `will-change: background-position` den Compositor-Layer forcieren

## Forward-Looking (nicht in dieser Iteration)

1. **Listening-State C/D (schneller/langsamer im aktiven Zuhör-Modus)** — Einzeiler wenn später gewünscht: `:host([accent="mint"][state="listening"]) .panel-wrapper { animation-duration: 6s, 24s; }`. Aktuell läuft mint-Panel im Standard-16s-Tempo (Option A).

2. **SVG `feTurbulence`-Upgrade (Ansatz 3 aus Brainstorming)** — Falls die sinus-basierte Ellipse später als "zu regelmäßig" empfunden wird, kann auf `feTurbulence` + `feDisplacementMap` umgestellt werden für echte Pseudo-Zufalls-Noise-Verzerrung. Höhere Paint-Kosten, aber visuell deutlich organischer. Kein Commitment, nur Upgrade-Pfad.

3. **Sarah-View / Chat** — Wenn die geplante Haupt-Chat-Seite gebaut wird (siehe `project_visual_alignment.md`), bekommt sie am Root-Container `style.setProperty('--jitter-scale', '0.5')` für subliminalen Effekt auf In/Out-Feld + Buttons.

4. **Phase 2 — Chrom-Rahmen-Look** — Der eigentliche metallic Gradient (Highlight-Streifen oben/unten, Eckakzente, brushed-metal-Oberflächenfarbe) wird in einem eigenen Design/Brainstorming-Zyklus entworfen. Dieser Jitter-Mechanismus ist so gebaut, dass der Rahmen-Look unabhängig davon umgestaltet werden kann — jeder zukünftige Gradient, der in `--panel-accent` bzw. den `--sarah-panel-accent-gradient-*` Tokens landet, wird automatisch jitter-fähig.

5. **Eventuelles Settings-UI zur Jitter-Intensität** — Falls Nutzer den Effekt individuell stellen wollen, kann später ein Settings-Slider `--jitter-scale` zur Laufzeit ändern. Nicht im aktuellen Scope.

## Risiken

- **`background` → `background-image` Refactor:** Kleine aber essenzielle Änderung in 5 Stellen des Component-CSS. Ohne diese wird beim ersten accent-Switch das `background-size`/`background-position` resettet und der Jitter bricht. Test: Alle 4 Accents + Error-State nach Implementierung durchklicken.

- **Wizard-Root-Klassifizierung:** Noch nicht 100% klar wo der Wizard-Root-Container beim Setup erstellt wird (nicht in `wizard-controller.ts`, vermutlich in `wizard.ts` oder direkt als HTML-Element in `wizard.html`). Während Implementation-Plan-Phase zu lokalisieren.

## Rollback

Alle Änderungen sind klein und file-lokal:
- `sarah-panel.ts` — die neuen Props/Keyframes und die `connectedCallback`-Zeile in einem Commit, einfach revertbar
- `settings.ts` — 1-Zeilen-Änderung, trivial revertbar
- Wizard-Root — analog 1 Zeile

Einzelne Commits sollten atomisch sein (pro File), damit bei Rollback keine Inkonsistenz entsteht.
