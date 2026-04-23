# Cockpit Themes — Iteration 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Einführen einer `data-theme` basierten Theme-Infrastruktur im Cockpit und Implementierung des ersten neuen Themes "orange" neben dem bestehenden Cyan-Default.

**Architecture:** Accent-Farbe triggert per Mapping ein `data-theme`-Attribut auf `<html>`. CSS-Overrides per `:root[data-theme="..."]` tauschen die 4 "leuchtenden" Cockpit-Tokens (`--sarah-accent` + 3 Cockpit-Ring-Accents). Card-Border-Gradients werden per neuer CSS-Variables theme-reaktiv; Box-Shadow-Glows werden per `color-mix()` aus denselben Cockpit-Accents computed.

**Tech Stack:** CSS Custom Properties (Variables), TypeScript, Vitest (environment: node — DOM-Code wird über pure-function Helper testbar gemacht).

---

## File Structure

**Modified:**
- `styles/theme.css` — `:root` gradient var defaults + `:root[data-theme="orange"]` Block
- `src/renderer/components/sarah-panel.ts` — Gradients via Vars, Shadows via `color-mix`
- `src/renderer/shared/accent.ts` — pure `colorToTheme()` + `applyAccentColor()` setzt `data-theme`
- `src/renderer/dashboard/dialog.ts` — Skip-Guard `color !== '#00d4ff'` entfernen
- `src/renderer/dashboard/dashboard.ts` — selben Skip-Guard entfernen

**Created:**
- `src/renderer/shared/accent.test.ts` — Tests für pure `colorToTheme()` Funktion

**No test harness changes needed** — `colorToTheme` ist reine Logik, Vitest `environment: node` reicht.

---

## Task 1 — theme.css: Gradient-Variable-Defaults in `:root`

**Files:**
- Modify: `styles/theme.css`

Diese Task ist rein vorbereitend. Die neuen Vars werden definiert aber noch nicht verwendet — kein visueller Effekt. Sie müssen 1:1 die aktuellen hartkodierten Gradients in `sarah-panel.ts` abbilden (Default-Cyan-Theme muss identisch aussehen).

- [ ] **Step 1: `theme.css` lesen um die Stelle für die neuen Vars zu finden**

Run: Read `styles/theme.css`
Expected: Der `:root { ... }` Block. Neue Vars werden am Ende des Backgrounds-Abschnitts eingefügt (nach `--sarah-bg-panel`).

- [ ] **Step 2: Die 4 Gradient-Vars einfügen**

Edit `styles/theme.css`, direkt nach dem `--sarah-bg-surface-hover` token, vor dem `--sarah-bg-page` token (oder direkt nach `--sarah-bg-page` — Reihenfolge ist egal, aber halte sie im Background-Block zusammen).

```css
  --sarah-panel-accent-gradient-cyan:
    linear-gradient(135deg, var(--cockpit-accent-cyan), var(--cockpit-accent-violet));
  --sarah-panel-accent-gradient-violet:
    linear-gradient(135deg, var(--cockpit-accent-violet), var(--cockpit-accent-pink));
  --sarah-panel-accent-gradient-pink:
    linear-gradient(135deg, var(--cockpit-accent-pink), var(--cockpit-accent-cyan));
  --sarah-panel-accent-gradient-mint:
    linear-gradient(135deg, var(--cockpit-accent-mint), var(--cockpit-accent-cyan));
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean exit (keine Output, exit code 0).

- [ ] **Step 4: Commit**

```bash
git add styles/theme.css
git commit -m "feat(themes): add sarah-panel gradient CSS variables"
```

---

## Task 2 — sarah-panel.ts: Gradients via CSS-Vars

**Files:**
- Modify: `src/renderer/components/sarah-panel.ts`

Ersetzt die 4 hartkodierten `linear-gradient()` Werte durch Referenzen auf die neuen CSS-Vars. **Visuell identisch** zu vorher — die Vars haben denselben Default-Wert.

- [ ] **Step 1: Datei lesen um die exakten Stellen zu lokalisieren**

Run: Read `src/renderer/components/sarah-panel.ts`
Expected: Die CSS-Template-String-Regeln in Zeilen 37, 50, 59, 68 (jeweils `.panel-wrapper` / `:host([accent="violet"])` / `:host([accent="pink"])` / `:host([accent="mint"])`).

- [ ] **Step 2: Cyan-Gradient ersetzen**

Edit `src/renderer/components/sarah-panel.ts`:

Old:
```
    background: var(--panel-accent, linear-gradient(135deg, var(--cockpit-accent-cyan), var(--cockpit-accent-violet)));
```

New:
```
    background: var(--panel-accent, var(--sarah-panel-accent-gradient-cyan));
```

- [ ] **Step 3: Violet-Gradient ersetzen**

Edit `src/renderer/components/sarah-panel.ts`:

Old:
```
    background: var(--panel-accent, linear-gradient(135deg, var(--cockpit-accent-violet), var(--cockpit-accent-pink)));
```

New:
```
    background: var(--panel-accent, var(--sarah-panel-accent-gradient-violet));
```

- [ ] **Step 4: Pink-Gradient ersetzen**

Edit `src/renderer/components/sarah-panel.ts`:

Old:
```
    background: var(--panel-accent, linear-gradient(135deg, var(--cockpit-accent-pink), var(--cockpit-accent-cyan)));
```

New:
```
    background: var(--panel-accent, var(--sarah-panel-accent-gradient-pink));
```

- [ ] **Step 5: Mint-Gradient ersetzen**

Edit `src/renderer/components/sarah-panel.ts`:

Old:
```
    background: var(--panel-accent, linear-gradient(135deg, var(--cockpit-accent-mint), var(--cockpit-accent-cyan)));
```

New:
```
    background: var(--panel-accent, var(--sarah-panel-accent-gradient-mint));
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/sarah-panel.ts
git commit -m "refactor(panel): use CSS vars for accent gradients"
```

---

## Task 3 — sarah-panel.ts: Shadows via `color-mix`

**Files:**
- Modify: `src/renderer/components/sarah-panel.ts`

Ersetzt die 8 hartkodierten `rgba(...)` Box-Shadows (4 idle @ 15% + 4 hover @ 30%) durch `color-mix()` Expressions die auf den theme-abhängigen `--cockpit-accent-*` Variablen aufbauen. **Visuell identisch** — die RGB-Werte entsprechen exakt den aktuellen Defaults.

Der Error-State-Shadow (`rgba(255, 59, 59, 0.25)`) bleibt **unverändert** — Error ist themenunabhängig.

- [ ] **Step 1: Cyan idle-Shadow ersetzen (Zeile ~38)**

Edit `src/renderer/components/sarah-panel.ts`:

Old:
```
    box-shadow: 0 0 20px rgba(0, 229, 255, 0.15);
```

New:
```
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-cyan) 15%, transparent);
```

- [ ] **Step 2: Cyan hover-Shadow ersetzen (Zeile ~46)**

Old:
```
    box-shadow: 0 0 40px rgba(0, 229, 255, 0.3);
```

New:
```
    box-shadow: 0 0 40px color-mix(in srgb, var(--cockpit-accent-cyan) 30%, transparent);
```

- [ ] **Step 3: Violet idle-Shadow (Zeile ~51)**

Old:
```
    box-shadow: 0 0 20px rgba(124, 58, 237, 0.15);
```

New:
```
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-violet) 15%, transparent);
```

- [ ] **Step 4: Violet hover-Shadow (Zeile ~55)**

Old:
```
    box-shadow: 0 0 40px rgba(124, 58, 237, 0.3);
```

New:
```
    box-shadow: 0 0 40px color-mix(in srgb, var(--cockpit-accent-violet) 30%, transparent);
```

- [ ] **Step 5: Pink idle-Shadow (Zeile ~60)**

Old:
```
    box-shadow: 0 0 20px rgba(255, 47, 209, 0.15);
```

New:
```
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-pink) 15%, transparent);
```

- [ ] **Step 6: Pink hover-Shadow (Zeile ~64)**

Old:
```
    box-shadow: 0 0 40px rgba(255, 47, 209, 0.3);
```

New:
```
    box-shadow: 0 0 40px color-mix(in srgb, var(--cockpit-accent-pink) 30%, transparent);
```

- [ ] **Step 7: Mint idle-Shadow (Zeile ~69)**

Old:
```
    box-shadow: 0 0 20px rgba(34, 255, 192, 0.15);
```

New:
```
    box-shadow: 0 0 20px color-mix(in srgb, var(--cockpit-accent-mint) 15%, transparent);
```

- [ ] **Step 8: Mint hover-Shadow (Zeile ~73)**

Old:
```
    box-shadow: 0 0 40px rgba(34, 255, 192, 0.3);
```

New:
```
    box-shadow: 0 0 40px color-mix(in srgb, var(--cockpit-accent-mint) 30%, transparent);
```

- [ ] **Step 9: Verifizieren dass Error-Shadow NICHT angefasst wurde**

Run: `grep -n "rgba(255, 59, 59" src/renderer/components/sarah-panel.ts`
Expected: 1 match — der Error-Shadow bleibt bestehen.

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean exit.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/components/sarah-panel.ts
git commit -m "refactor(panel): compute accent glows via color-mix from cockpit accent tokens"
```

---

## Task 4 — accent.test.ts: Tests für `colorToTheme` (TDD)

**Files:**
- Create: `src/renderer/shared/accent.test.ts`

TDD-Ansatz: wir schreiben den Test zuerst (schlägt fehl), implementieren dann in Task 5. Die Funktion `colorToTheme(hex)` ist eine reine Mapping-Funktion und daher in Node-Environment testbar.

- [ ] **Step 1: Test-Datei anlegen**

Create `src/renderer/shared/accent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { colorToTheme } from './accent.js';

describe('colorToTheme', () => {
  it('maps the 8 preset hex values to their theme keys', () => {
    expect(colorToTheme('#00d4ff')).toBe('cyan');
    expect(colorToTheme('#4466ff')).toBe('blue');
    expect(colorToTheme('#8855ff')).toBe('violet');
    expect(colorToTheme('#ff8844')).toBe('orange');
    expect(colorToTheme('#44ff88')).toBe('green');
    expect(colorToTheme('#ff4488')).toBe('pink');
    expect(colorToTheme('#ffcc00')).toBe('gold');
    expect(colorToTheme('#ff5555')).toBe('red');
  });

  it('falls back to "cyan" for unknown hex values', () => {
    expect(colorToTheme('#123456')).toBe('cyan');
    expect(colorToTheme('#000000')).toBe('cyan');
  });

  it('is case-insensitive for the hex input', () => {
    expect(colorToTheme('#FF8844')).toBe('orange');
    expect(colorToTheme('#Ff5555')).toBe('red');
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FEHLER**

Run: `npx vitest run src/renderer/shared/accent.test.ts`
Expected: FAIL, "colorToTheme is not a function" oder "does not provide an export named colorToTheme".

- [ ] **Step 3: Commit (failing test)**

```bash
git add src/renderer/shared/accent.test.ts
git commit -m "test(themes): add colorToTheme unit tests"
```

---

## Task 5 — accent.ts: `colorToTheme` implementieren + `applyAccentColor` erweitern

**Files:**
- Modify: `src/renderer/shared/accent.ts`

- [ ] **Step 1: `accent.ts` komplett lesen um die aktuelle Struktur zu sehen**

Run: Read `src/renderer/shared/accent.ts`
Expected: 22 Zeilen: `hexToRgb`, `lighten`, `applyAccentColor`.

- [ ] **Step 2: `ThemeKey` Typ + Mapping + `colorToTheme` hinzufügen, `applyAccentColor` erweitern**

Edit `src/renderer/shared/accent.ts` komplett ersetzen durch:

```ts
export type ThemeKey = 'cyan' | 'blue' | 'violet' | 'orange' | 'green' | 'pink' | 'gold' | 'red';

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

export function colorToTheme(hex: string): ThemeKey {
  return ACCENT_TO_THEME[hex.toLowerCase()] ?? 'cyan';
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) };
}

function lighten(r: number, g: number, b: number, amount = 0.2): string {
  const lr = Math.min(255, Math.round(r + (255 - r) * amount));
  const lg = Math.min(255, Math.round(g + (255 - g) * amount));
  const lb = Math.min(255, Math.round(b + (255 - b) * amount));
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
}

export function applyAccentColor(hex: string): void {
  document.documentElement.style.setProperty('--sarah-accent', hex);
  const rgb = hexToRgb(hex);
  if (rgb) {
    document.documentElement.style.setProperty('--sarah-accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    document.documentElement.style.setProperty('--sarah-accent-hover', lighten(rgb.r, rgb.g, rgb.b));
  }
  document.documentElement.setAttribute('data-theme', colorToTheme(hex));
}
```

- [ ] **Step 3: Test laufen lassen — erwartet PASS**

Run: `npx vitest run src/renderer/shared/accent.test.ts`
Expected: PASS, alle 3 Testfälle grün.

- [ ] **Step 4: Full typecheck**

Run: `npx tsc --noEmit`
Expected: Clean exit.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/shared/accent.ts
git commit -m "feat(themes): add colorToTheme mapping and data-theme attribute setter"
```

---

## Task 6 — dialog.ts + dashboard.ts: Skip-Guard entfernen

**Files:**
- Modify: `src/renderer/dashboard/dialog.ts`
- Modify: `src/renderer/dashboard/dashboard.ts`

Aktuell wird `applyAccentColor` beim Page-Load übersprungen wenn der User den Default-Cyan gewählt hat. Damit `data-theme="cyan"` auch für Default-User gesetzt wird, muss der Guard raus.

Beide Files haben identisch denselben Pattern — beide in einem Commit.

- [ ] **Step 1: `dialog.ts` anpassen**

Edit `src/renderer/dashboard/dialog.ts`:

Old:
```ts
// Apply saved accent color
sarah.getConfig().then((config) => {
  const color = config.personalization?.accentColor;
  if (color && color !== '#00d4ff') {
    applyAccentColor(color);
  }
});
```

New:
```ts
// Apply accent color on load — always, so data-theme gets set even for default cyan
sarah.getConfig().then((config) => {
  const color = config.personalization?.accentColor ?? '#00d4ff';
  applyAccentColor(color);
});
```

- [ ] **Step 2: `dashboard.ts` anpassen (gleiches Pattern)**

Edit `src/renderer/dashboard/dashboard.ts`:

Old:
```ts
// Apply saved accent color on load
sarah.getConfig().then((config) => {
  const color = config.personalization?.accentColor;
  if (color && color !== '#00d4ff') {
    applyAccentColor(color);
  }
});
```

New:
```ts
// Apply accent color on load — always, so data-theme gets set even for default cyan
sarah.getConfig().then((config) => {
  const color = config.personalization?.accentColor ?? '#00d4ff';
  applyAccentColor(color);
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean exit.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/dashboard/dialog.ts src/renderer/dashboard/dashboard.ts
git commit -m "fix(themes): always apply accent on load to set data-theme attribute"
```

---

## Task 7 — theme.css: Orange-Theme-Block

**Files:**
- Modify: `styles/theme.css`

Fügt den `:root[data-theme="orange"]` Block hinzu, der 4 Tokens überschreibt. Der Rest der Theme-Palette (text, bg, mint-listening) bleibt durch die Default-Werte in `:root` aktiv.

- [ ] **Step 1: `theme.css` am Ende des `:root` Blocks die Theme-Overrides einfügen**

Edit `styles/theme.css`. Nach der schließenden `}` von `:root`, folgenden Block anhängen:

```css
/* ── Theme: Orange — warm accent palette ── */
:root[data-theme="orange"] {
  --sarah-accent: #ff8844;           /* User signature (Slider, Hero-Caption) */
  --cockpit-accent-cyan: #ffd23f;    /* CPU-Ring: golden yellow */
  --cockpit-accent-violet: #e76f51;  /* GPU-Ring: coral */
  --cockpit-accent-pink: #f94144;    /* RAM-Ring: warm red */
  /* --cockpit-accent-mint bleibt mint (Listening-State semantischer Anker) */
  /* --sarah-bg-primary / -secondary bleiben (dark anchor) */
  /* Gradients erben aus :root — ziehen automatisch neue --cockpit-accent-* Werte */
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean exit.

- [ ] **Step 3: Commit**

```bash
git add styles/theme.css
git commit -m "feat(themes): add orange theme palette"
```

---

## Task 8 — Verifikation (Build + Tests + Visual)

**Files:** keine Änderungen.

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit`
Expected: Clean exit.

- [ ] **Step 2: Alle Unit-Tests laufen lassen**

Run: `npx vitest run`
Expected: Alle bestehenden Tests + die 3 neuen `colorToTheme` Tests grün. Sqlite-native-module-Fails (wenn noch vorhanden) sind nicht relevant für dieses Feature.

- [ ] **Step 3: Grep-Check — keine hardcoded Panel-Gradient-Farben mehr in sarah-panel.ts**

Run: `grep -n "linear-gradient(135deg, var(--cockpit-accent" src/renderer/components/sarah-panel.ts`
Expected: 0 Matches (Gradients laufen jetzt alle über die neuen CSS-Vars).

- [ ] **Step 4: Grep-Check — keine hardcoded RGBA-Shadows mehr in sarah-panel.ts (außer Error)**

Run: `grep -n "rgba(" src/renderer/components/sarah-panel.ts`
Expected: 2 Matches (Error-Shadow `rgba(255, 59, 59, 0.25)` und sein hover `rgba(255, 59, 59, 0.5)`). Alle anderen sind verschwunden.

- [ ] **Step 5: Visual-Test — Electron starten und Theme-Wechsel durchklicken**

Manuell durch den User, nicht automatisierbar:

1. `npm start` → Cockpit öffnen
2. Prüfen: Default-Cyan-Theme sieht identisch zum Stand vor diesem Plan aus (System-Load-Ringe cyan/violet/pink, Panels mit cyan/violet/pink/mint Gradients).
3. DevTools öffnen, `<html>` Element inspizieren → Attribut `data-theme="cyan"` muss gesetzt sein.
4. In Settings-Dialog öffnen, Accent-Farbe auf **Orange** umstellen.
5. Cockpit erneut öffnen. Erwartung:
   - `<html>` hat jetzt `data-theme="orange"`.
   - CPU-Ring: gold-gelb (#ffd23f).
   - GPU-Ring: coral (#e76f51).
   - RAM-Ring: warm red (#f94144).
   - Voice-Listening-State: immer noch mint.
   - Slider/Hero-Caption: orange (#ff8844).
   - Card-Border-Gradients: passen sich der neuen Accent-Palette an.
6. Auf **Cyan** zurückstellen → alles wieder wie in Schritt 2.
7. Edge-Case: Theme-Wechsel bei laufender Voice-Session testen — Listening-Bar muss durchgehend mint bleiben.

- [ ] **Step 6: User signs off — kein automatischer Commit**

Nach positivem Visual-Test: User entscheidet ob er alle 6-7 Commits (dieser Plan + die bereits aufgestauten von vorherigen Runden) in einem squash-commit oder einzeln mergen will. Keine weiteren Änderungen nötig.

---

## Spec-Coverage-Check

Alle Anforderungen aus `docs/superpowers/specs/2026-04-23-cockpit-themes-design.md`:

| Spec-Anforderung | Tasks |
|---|---|
| `--sarah-accent` per Theme getauscht | Task 5 (Setter), Task 7 (Orange-Override) |
| `--cockpit-accent-cyan/violet/pink` per Theme getauscht | Task 7 |
| `--cockpit-accent-mint` bleibt über alle Themes | Task 7 (explizit nicht überschrieben) |
| Card-Border-Gradients theme-reaktiv | Task 1 + Task 2 |
| Panel-Box-Shadows theme-reaktiv via `color-mix` | Task 3 |
| `data-theme` auf `<html>` per `applyAccentColor` | Task 5 |
| Skip-Guard in dialog.ts entfernt | Task 6 |
| Skip-Guard in dashboard.ts entfernt | Task 6 |
| Error-Glow bleibt themenunabhängig | Task 3 Step 9 (Verifikation) |
| Text-Farben + BG unverändert | alle Tasks — werden nie angefasst |
| Iteration 1: Cyan + Orange | Task 7 (Cyan bleibt Default in `:root`, Orange neu) |

**Keine offenen Gaps.**

## Rollback

Falls nach Visual-Test ein Fix nötig ist, einzelne Commits reverten ist trivial (jeder Commit ist file-lokal und klein). Kein komplexer Rollback-Plan nötig.

## Next Step After Iteration 1

Nach erfolgreichem Visual-Test für Iteration 1: separater Plan für **Iteration 2** (4-6 Themes). Die Farben für Violet/Red/Blue/etc. können dann kuratiert werden basierend auf den Lessons aus Iteration 1.
