---
title: Cockpit Themes — Accent-gekoppelte Palette
date: 2026-04-23
status: approved
---

# Cockpit Themes — Accent-gekoppelte Palette

## Problem

Der User-Accent wird aktuell nur als **eine** Farbe angewendet (`--sarah-accent`, Slider + Hero-Caption). Wenn der User Rot als Accent wählt, bleiben CPU/GPU/RAM-Ringe weiterhin cyan/violet/pink — das Cockpit fühlt sich nicht nach "seiner Farbe" an. Gleichzeitig hat die hardgecodete Panel-Palette (cyan/violet/pink/mint) im Cockpit semantische Bedeutung (Ring-Zuordnung, Listening-State), die man nicht einfach durch User-Hex ersetzen kann, ohne Verwirrung zu stiften ("rote CPU = Alarm?").

## Ziel

Jeder der 8 Accent-Presets wird zu einem **Theme**: ein kleines Paket aus 4-5 koordinierten "leuchtenden" Farben. Für den User bleibt die UX identisch — er klickt ein farbiges Kästchen in Settings, und das Cockpit passt sich harmonisch an. Backgrounds, Text-Farben und Listening-State bleiben konstant (semantische Anker).

**Technisch:** Accent-Auswahl setzt zusätzlich zu `--sarah-accent` jetzt auch ein `data-theme`-Attribut auf `<html>`, das die restlichen Theme-Tokens via CSS-Overrides austauscht.

## Scope — was ändert sich pro Theme

**Pro Theme werden getauscht (Pflicht):**

| Token | Rolle | Bleibt heute |
|---|---|---|
| `--sarah-accent` | User-Signatur-Spot (Slider, Hero-Caption, Border-Focus) | #00d4ff |
| `--cockpit-accent-cyan` | Primary Cockpit-Farbe, CPU-Ring, Speaking-State | #00e5ff |
| `--cockpit-accent-violet` | Secondary Cockpit-Farbe, GPU-Ring, Processing-State | #7c3aed |
| `--cockpit-accent-pink` | Tertiary Cockpit-Farbe, RAM-Ring | #ff2fd1 |

**Card-Border-Gradients UND Glows in `sarah-panel.ts`** werden themenabhängig:

1. **Gradients** (4 Stück): Aktuell sind 4 Gradients hart einkodiert (cyan→violet, violet→pink, pink→cyan, mint→cyan). Diese werden durch CSS-Variablen `--sarah-panel-accent-gradient-cyan/violet/pink/mint` ersetzt, jeweils theme-spezifisch definiert.

2. **Box-Shadows** (8 Stück — 4 idle + 4 hover): Aktuell hardcoded RGBA (z.B. `rgba(0, 229, 255, 0.15)` für Cyan). Die RGB-Werte entsprechen exakt den `--cockpit-accent-*` Defaults. Umstellen auf `color-mix()`:

   ```css
   /* vorher */
   box-shadow: 0 0 20px rgba(0, 229, 255, 0.15);
   /* nachher */
   box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-cyan) 15%, transparent);
   ```

   Analog für violet/pink/mint, jeweils idle (15%) und hover (30%). Vorteil: keine zusätzlichen Tokens nötig — die Glows folgen automatisch den theme-abhängigen `--cockpit-accent-*` Werten.

   **Nicht ändern:** Der Error-Glow (`rgba(255, 59, 59, 0.25)`) bleibt hardcoded — Error-Rot ist themenunabhängig.

**Optional, evtl. Iteration 2:**

- `--sarah-bg-secondary` (Zentrum der Page-Fade) — möglich, aber erstmal nicht. Wird im Visual-Review entschieden.

**Nicht im Scope — bleibt über alle Themes gleich:**

- `--sarah-bg-primary` (Außen-BG der Page-Fade) — alle Themes dark, einheitlicher Anker.
- `--sarah-bg-panel`, `--sarah-bg-surface`, `--sarah-bg-surface-hover`.
- Alle `--sarah-text-*` (Kontrast garantiert, keine Lesbarkeits-Risiken).
- `--sarah-border`, Shadows, Radii, Spacing.
- `--cockpit-accent-mint` (Listening-State — semantisches UX-Signal, Grün/Mint universal als "aktiv").
- `--cockpit-accent-red` (Error-Farbe, immer rot).
- `--cockpit-text-hud`, `--cockpit-text-dim`.
- 3D-Orb (`sarahHexOrb`) — nutzt weiterhin nur `accentColor` aus der Config.

## Die 8 Themes

Zuordnung Preset → Theme ist 1:1. **Theme-Keys in Englisch** (CLAUDE.md: code in English), UI-Labels bleiben deutsch:

| UI-Label (deutsch) | Hex | Theme-Key (englisch) |
|---|---|---|
| Cyan (default) | #00d4ff | `cyan` |
| Blau | #4466ff | `blue` |
| Violett | #8855ff | `violet` |
| Orange | #ff8844 | `orange` |
| Grün | #44ff88 | `green` |
| Pink | #ff4488 | `pink` |
| Gold | #ffcc00 | `gold` |
| Rot | #ff5555 | `red` |

Jedes Theme definiert die 4 Pflicht-Tokens oben + die 4 Card-Border-Gradients, in sich harmonisch.

## Implementierung

### `styles/theme.css`

Default-Werte bleiben in `:root` (= Cyan-Theme). Für die anderen 7 Themes werden `:root[data-theme="..."]` Blöcke hinzugefügt.

**Default-Values (Cyan-Theme, in `:root`):** müssen 1:1 dem aktuellen hartkodierten Panel-Look entsprechen:

```css
:root {
  /* ... existing tokens ... */
  --sarah-panel-accent-gradient-cyan:   linear-gradient(135deg, var(--cockpit-accent-cyan),   var(--cockpit-accent-violet));
  --sarah-panel-accent-gradient-violet: linear-gradient(135deg, var(--cockpit-accent-violet), var(--cockpit-accent-pink));
  --sarah-panel-accent-gradient-pink:   linear-gradient(135deg, var(--cockpit-accent-pink),   var(--cockpit-accent-cyan));
  --sarah-panel-accent-gradient-mint:   linear-gradient(135deg, var(--cockpit-accent-mint),   var(--cockpit-accent-cyan));
}
```

Dadurch passen sich die Default-Gradients automatisch an theme-abhängige `--cockpit-accent-*` Werte an. Die konkreten Accent-Hex-Werte werden pro Theme im Implementation-Plan kuratiert:

```css
:root[data-theme="red"] {
  --sarah-accent: #ff5555;
  --cockpit-accent-cyan: #ff8844;        /* CPU-Ring wird orange */
  --cockpit-accent-violet: #cc4466;      /* GPU-Ring wird rose */
  --cockpit-accent-pink: #ffaa55;        /* RAM-Ring wird amber */
  /* Gradients erben aus :root-Defaults, ziehen jetzt aber die neuen Accent-Werte */
}
```

Falls ein Theme abweichende Gradient-Reihenfolgen braucht, können die 4 Gradient-Variablen explizit überschrieben werden.

### `shared/accent.ts`

```ts
type ThemeKey = 'cyan' | 'blue' | 'violet' | 'orange' | 'green' | 'pink' | 'gold' | 'red';

const ACCENT_TO_THEME: Record<string, ThemeKey> = {
  '#00d4ff': 'cyan',
  '#4466ff': 'blue',
  '#8855ff': 'violet',
  '#ff8844': 'orange',
  '#44ff88': 'green',
  '#ff4488': 'pink',
  '#ffcc00': 'gold',
  '#ff5555': 'red',
};

export function applyAccentColor(hex: string): void {
  // existing: set --sarah-accent / -rgb / -hover
  const theme = ACCENT_TO_THEME[hex] ?? 'cyan';
  document.documentElement.setAttribute('data-theme', theme);
}
```

**Wichtig — Skip-Guard an ZWEI Stellen fixen:**

`applyAccentColor` wird aktuell beim Page-Load übersprungen wenn `color === '#00d4ff'` (Default-Cyan). Das heißt: Default-Cyan-User kriegen kein `data-theme="cyan"` gesetzt. Muss an **beiden** Stellen gefixt werden:

- `src/renderer/dashboard/dialog.ts` Zeile 19 (Settings + Cockpit-Dialog)
- `src/renderer/dashboard/dashboard.ts` Zeile 19 (Main App / Cockpit-Hauptfenster)

In beiden: Den `color !== '#00d4ff'`-Guard entfernen, `applyAccentColor` immer aufrufen.

### `src/renderer/components/sarah-panel.ts`

Die aktuell hartkodierten Gradients werden durch CSS-Variable-Referenzen ersetzt:

```ts
// vorher:
background: var(--panel-accent, linear-gradient(135deg, var(--cockpit-accent-cyan), var(--cockpit-accent-violet)));

// nachher:
background: var(--panel-accent, var(--sarah-panel-accent-gradient-cyan));
```

Analog für die 3 anderen `accent`-Varianten. Default-Werte der neuen Gradient-Variables landen in `theme.css` (Cyan-Theme).

## Rollout — iterativ

**Iteration 1** (dieser Task): **2 Themes** — Cyan-default (bleibt wie ist) + `orange` (UI-Label: "Orange").
Warum Orange zuerst? Maximaler visueller Kontrast zum Cyan-Default → bester Stresstest für das Konzept.

**Iteration 2** (separater Task nach Visual-Review): auf **4-6 Themes** ausbauen. Prioritäten nach User-Feedback.

**Iteration 3** (falls nötig): alle **8 Themes** komplett.

Nach jeder Iteration Visual-Check: Sind die Farben harmonisch? Kontrast-Issues? Dann Entscheidung ob nächste Iteration sinnvoll.

## Testing

- Typecheck + Unit-Tests grün.
- Für jedes implementierte Theme: in Electron durchklicken, alle Cockpit-Elemente checken — besonders System-Load-Ringe, Voice-Panel-States, Card-Borders, Slider, Hero-Caption.
- Edge-Case: Theme-Wechsel bei laufender Voice-Session (Listening-Bar muss mint bleiben).
- Cyan-Default-Pfad: `applyAccentColor('#00d4ff')` muss `data-theme="cyan"` setzen (nicht skippen).

## Risks

| Risk | Mitigation |
|---|---|
| Theme-Farben nicht harmonisch | Iterativ, 1 Theme polishen bevor nächstes startet. Visual-Review nach Iteration 1. |
| sarah-panel.ts Gradient-Umbau bricht Panel-Look | Default-Values in theme.css 1:1 zu heutigem Stand → Cyan-Theme sieht identisch aus. |
| `data-theme` wird bei Default-Cyan-User nicht gesetzt | `applyAccentColor` wird für **alle** Color-Werte aufgerufen (Fix in `dialog.ts` und `dashboard.ts`). |
| User wechselt Theme live — sieht man den Wechsel ruckeln? | CSS-Vars sind Transition-fähig, aber wir lassen Transitions erstmal aus. Im Zweifel nachrüsten. |

## Nicht im Scope

- Light-Themes (alles bleibt dark).
- Text-Farben theme-abhängig (Kontrast bleibt wie heute).
- Page-Fade-BG theme-abhängig (`--sarah-bg-primary` + `-secondary` bleiben). Evtl. Iteration 2.
- Orb-Sekundärfarben theme-abhängig (Orb nutzt nur accentColor wie bisher).
- Theme-Picker als separates UI-Feature (Accent-Picker bleibt die einzige User-Facing-Control).

## Next Step

`writing-plans` anwerfen → Implementation-Plan für Iteration 1 (Cyan-default + Orange).
