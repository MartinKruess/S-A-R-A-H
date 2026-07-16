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

**Wichtig:** `<sarah-panel>` ist im aktuellen Renderer **ausschließlich** im Cockpit instanziiert (6 Aufrufe in `dashboard/views/home.ts`). Settings-View, Wizard und Boot-Sequence verwenden plain `<div>`-Elemente — dort existiert kein Empfänger für `--jitter-scale`-Overrides. Bis diese Views sarah-panel adoptieren, ist der effektive Scope der Jitter-Animation = Cockpit.

| Bereich | `--jitter-scale` | Effekt |
|---|---|---|
| **Cockpit** (`dashboard/views/home.ts`) | `1` (Default) | 4px / 2px elliptische Bewegung auf allen `<sarah-panel>`-Instanzen |
| **Settings** (`dashboard/views/settings.ts`) | — | Kein `<sarah-panel>` vorhanden. Falls Settings später zu Panels migriert wird: Root-Container `--jitter-scale: 0.5` (subliminal). |
| **Wizard** | — | Kein `<sarah-panel>` vorhanden. Falls Wizard später Panels nutzt: Root `--jitter-scale: 0` (Animation tickt, Bewegung null). |
| **Boot-Sequence** | — | Kein `<sarah-panel>` vorhanden, läuft nur Sekunden |
| **Zukünftige Sarah-View/Chat** | `0.5` (geplant) | Subliminal, wenn die View gebaut wird **und** `<sarah-panel>` nutzt |

## Architektur

Der Jitter wird **ausschließlich** im `sarah-panel.ts` Web Component implementiert. Der Component lebt im Shadow DOM — externes CSS kann den Shadow nicht erreichen. CSS Custom Properties vererben aber durch die Shadow-DOM-Grenze, also wird die Scope-Steuerung von außen via **Custom Properties** realisiert.

**Änderungs-Umfang (Files):**

| Datei | Art der Änderung |
|---|---|
| `src/renderer/components/sarah-panel.ts` | Shadow-DOM-CSS erweitern (Jitter-Keyframes, background-image-Refactor), eine Zeile im `connectedCallback` für Phase-Randomisierung |

**Nur eine Datei.** Keine neuen Dateien, keine Änderungen an `styles/cockpit.css`, `styles/theme.css`, `settings.ts` oder Wizard-Files. Cockpit nutzt den Default-Wert `--jitter-scale: 1` ohne Eingriff — überall wo `<sarah-panel>` gerendert wird (derzeit nur Cockpit), läuft der Effekt automatisch.

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

### Scope-Overrides — in dieser Iteration nicht nötig

Weil `<sarah-panel>` aktuell nur im Cockpit existiert, greift der Default-Wert `--jitter-scale: 1` direkt ohne jede zusätzliche Kodierung.

Wenn Settings oder eine zukünftige Sarah-View später zu `<sarah-panel>` migriert werden, kann der Override am jeweiligen Root-Container per Inline-Style nachgereicht werden:

```ts
// Beispiel, falls Settings je Panels verwendet:
container.style.setProperty('--jitter-scale', '0.5');
```

CSS Custom Properties vererben durch die Shadow-DOM-Grenze, der Panel-Component reagiert ohne Anpassung.

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
- Bei 6 Panels × 16s-Animation (sysload, voicein, voiceout, termine, wetter, media): je Panel ≈ 60 fps × 0,4 % Box-Paint-Delta — messbarer Overhead vernachlässigbar
- `connectedCallback`-Zeile: 1× `Math.random()` + 1× `setProperty` pro Panel-Mount — vernachlässigbar
- Auf Ziel-Hardware (RTX 3050, Sarah läuft parallel zu Ollama/Voice-Last): kein spürbarer Impact erwartet; falls Benchmarks in der Implementation-Phase anders ausfallen, kann `will-change: background-position` den Compositor-Layer forcieren

## Forward-Looking (nicht in dieser Iteration)

1. **Listening-State C/D (schneller/langsamer im aktiven Zuhör-Modus)** — Einzeiler wenn später gewünscht: `:host([accent="mint"][state="listening"]) .panel-wrapper { animation-duration: 6s, 24s; }`. Aktuell läuft mint-Panel im Standard-16s-Tempo (Option A).

2. **SVG `feTurbulence`-Upgrade (Ansatz 3 aus Brainstorming)** — Falls die sinus-basierte Ellipse später als "zu regelmäßig" empfunden wird, kann auf `feTurbulence` + `feDisplacementMap` umgestellt werden für echte Pseudo-Zufalls-Noise-Verzerrung. Höhere Paint-Kosten, aber visuell deutlich organischer. Kein Commitment, nur Upgrade-Pfad.

3. **Sarah-View / Chat** — Wenn die geplante Haupt-Chat-Seite gebaut wird (siehe `project_visual_alignment.md`), bekommt sie am Root-Container `style.setProperty('--jitter-scale', '0.5')` für subliminalen Effekt auf In/Out-Feld + Buttons.

4. **Phase 2 — Chrom-Rahmen-Look** — Der eigentliche metallic Gradient (Highlight-Streifen oben/unten, Eckakzente, brushed-metal-Oberflächenfarbe) wird in einem eigenen Design/Brainstorming-Zyklus entworfen. Dieser Jitter-Mechanismus ist so gebaut, dass der Rahmen-Look unabhängig davon umgestaltet werden kann — jeder zukünftige Gradient, der in `--panel-accent` bzw. den `--sarah-panel-accent-gradient-*` Tokens landet, wird automatisch jitter-fähig.

5. **Eventuelles Settings-UI zur Jitter-Intensität** — Falls Nutzer den Effekt individuell stellen wollen, kann später ein Settings-Slider `--jitter-scale` zur Laufzeit ändern. Nicht im aktuellen Scope.

6. **Settings-View / Wizard Panel-Migration** — Wenn eine dieser Views später auf `<sarah-panel>` umgestellt wird (siehe `project_visual_alignment.md` — "Rest der App optisch ans Cockpit angleichen"), greift der vorbereitete `--jitter-scale`-Mechanismus automatisch. Root-Container einfach per Inline-Style auf `0.5` (Settings) bzw. `0` (Wizard) setzen.

7. **`connectedCallback` Doppel-Mount-Guard** — `sarah-panel.ts` hat aktuell keinen Guard gegen mehrfaches `connectedCallback` (pre-existing Tech-Debt). Wird das Panel disconnect/reconnect durchlaufen, entstehen doppelte Style-Tags, ein weiterer `.panel-wrapper` wird angehängt, und die Jitter-Phase springt neu. In der Praxis niedriges Risiko (Cockpit-Panels sind statisch während der Laufzeit), aber wenn der Implementation-Plan ohnehin im `connectedCallback` editiert, ist ein `if (this.wrapperEl) return;` am Anfang die pragmatische Kosten-Nutzen-Entscheidung.

## Risiken

- **`background` → `background-image` Refactor:** Kleine aber essenzielle Änderung in 5 Stellen des Component-CSS. Ohne diese wird beim ersten accent-Switch das `background-size`/`background-position` resettet und der Jitter bricht. Test: Alle 4 Accents + Error-State nach Implementierung durchklicken.

- **Pre-existing Doppel-Mount-Verhalten:** Das bestehende `connectedCallback` in `sarah-panel.ts` hat keinen Guard — bei reconnect würde der neue `--jitter-phase`-Setter ebenfalls mehrfach laufen und einen sichtbaren Animation-Sprung verursachen. In der aktuellen App-Architektur (Cockpit-Panels statisch gemountet) tritt das nicht auf. Implementation-Plan sollte einen Guard `if (this.wrapperEl) return;` am Anfang von `connectedCallback` hinzufügen — das ist "kostenloser" Tech-Debt-Fix, weil wir die Stelle ohnehin anfassen.

## Rollback

Alle Änderungen konzentrieren sich auf eine einzige Datei:
- `sarah-panel.ts` — CSS-Refactor, neue Keyframes und `connectedCallback`-Zeilen in einem Commit, einfach revertbar

Der Implementation-Plan sollte die Änderungen in **atomische Commits** aufsplitten (z.B. 1. `background` → `background-image` Refactor, 2. Keyframes + Animation, 3. `connectedCallback` Phase-Randomizer + optionaler Doppel-Mount-Guard), damit bei Bedarf einzelne Aspekte selektiv revertbar sind.
