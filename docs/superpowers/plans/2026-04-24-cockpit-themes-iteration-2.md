# Cockpit Themes — Iteration 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vervollständigung des Theme-Systems: 6 zusätzliche Theme-Paletten (alle 8 verfügbar), Settings-Label-Umbenennung, und Hero-Planet/Halo/Grid werden theme-reaktiv.

**Architecture:** Baut auf Iteration 1 auf (data-theme Attribute + CSS Overrides). Keine neue Infrastruktur — nur mehr `:root[data-theme="..."]` Blöcke + Umstellung der hardcodeten `rgba(...)` Werte im Hero-Bereich auf `color-mix()` basierend auf den theme-reaktiven `--cockpit-accent-*` Tokens.

**Tech Stack:** CSS Custom Properties, `color-mix(in srgb, ...)`, TypeScript (Minimal-Touch).

---

## File Structure

**Modified:**
- `styles/theme.css` — 6 neue `:root[data-theme="..."]` Blöcke
- `styles/cockpit.css` — Hero-Planet, Halo und Grid rgbas auf `color-mix()` umstellen
- `src/renderer/shared/personalization-controls.ts` — 1 Zeile Label-Text

**Keine neuen Tests.** Die `colorToTheme()` Tests aus Iteration 1 decken auch die neuen Theme-Keys schon ab (der Test prüft 8 Hex → 8 Keys; nur die CSS-Overrides sind neu).

---

## Task 1 — theme.css: 6 neue Theme-Blöcke

**Files:** Modify `styles/theme.css`

Appends 6 new `:root[data-theme="..."]` blocks at the end of `styles/theme.css`, nach dem bestehenden `:root[data-theme="orange"]` Block von Iteration 1.

- [ ] **Step 1: Ans Ende der Datei anfügen**

Edit `styles/theme.css`, am Ende der Datei nach dem orange-Block:

```css
/* ── Theme: Blue — kühle Palette ── */
:root[data-theme="blue"] {
  --sarah-accent: #4466ff;
  --cockpit-accent-cyan: #60a5fa;    /* CPU-Ring: sky blue */
  --cockpit-accent-violet: #8b5cf6;  /* GPU-Ring: deep violet */
  --cockpit-accent-pink: #06b6d4;    /* RAM-Ring: cyan-teal */
}

/* ── Theme: Violet — tiefe Purpur-Palette ── */
:root[data-theme="violet"] {
  --sarah-accent: #8855ff;
  --cockpit-accent-cyan: #a78bfa;    /* CPU-Ring: lavender */
  --cockpit-accent-violet: #ec4899;  /* GPU-Ring: magenta */
  --cockpit-accent-pink: #60a5fa;    /* RAM-Ring: sky blue */
}

/* ── Theme: Green — Natur-Palette ── */
:root[data-theme="green"] {
  --sarah-accent: #44ff88;
  --cockpit-accent-cyan: #84cc16;    /* CPU-Ring: lime */
  --cockpit-accent-violet: #0d9488;  /* GPU-Ring: deep teal */
  --cockpit-accent-pink: #fbbf24;    /* RAM-Ring: amber (warm contrast) */
}

/* ── Theme: Pink — lebhafte Palette ── */
:root[data-theme="pink"] {
  --sarah-accent: #ff4488;
  --cockpit-accent-cyan: #fb7185;    /* CPU-Ring: coral-pink */
  --cockpit-accent-violet: #a855f7;  /* GPU-Ring: purple */
  --cockpit-accent-pink: #fb923c;    /* RAM-Ring: orange (warm contrast) */
}

/* ── Theme: Gold — warm-luxuriöse Palette ── */
:root[data-theme="gold"] {
  --sarah-accent: #ffcc00;
  --cockpit-accent-cyan: #fde047;    /* CPU-Ring: bright yellow */
  --cockpit-accent-violet: #fb923c;  /* GPU-Ring: orange */
  --cockpit-accent-pink: #c084fc;    /* RAM-Ring: lavender (cool contrast) */
}

/* ── Theme: Red — intensive Palette ── */
:root[data-theme="red"] {
  --sarah-accent: #ff5555;
  --cockpit-accent-cyan: #fb7185;    /* CPU-Ring: rose */
  --cockpit-accent-violet: #f97316;  /* GPU-Ring: orange */
  --cockpit-accent-pink: #a855f7;    /* RAM-Ring: purple (cool contrast) */
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean exit.

- [ ] **Step 3: Commit**

```bash
git add styles/theme.css
git commit -m "feat(themes): add blue/violet/green/pink/gold/red theme palettes"
```

---

## Task 2 — personalization-controls.ts: Label-Umbenennung

**Files:** Modify `src/renderer/shared/personalization-controls.ts`

Die Settings-Sektion für die Farbwahl heißt aktuell "Akzentfarbe", weil die ursprünglich nur eine Accent-Hex gesetzt hat. Jetzt setzt sie ein ganzes Theme → Label anpassen.

- [ ] **Step 1: Zeile 17 ändern**

Edit `src/renderer/shared/personalization-controls.ts`:

Old:
```ts
  label.textContent = 'Akzentfarbe';
```

New:
```ts
  label.textContent = 'Theme';
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean exit.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/shared/personalization-controls.ts
git commit -m "refactor(settings): rename 'Akzentfarbe' label to 'Theme'"
```

---

## Task 3 — cockpit.css: Hero-Planet, Halo, Grid theme-reaktiv

**Files:** Modify `styles/cockpit.css`

Der CSS-gemalte Hero-Planet in der Cockpit-Mitte plus der drehende Halo-Ring und das Starfield-Grid nutzen aktuell hardcoded `rgba(R, G, B, α)` Werte für Cyan/Violet/Pink. Unter non-cyan Themes bleibt der Planet darum immer cyan-violett — optisch inkonsistent. Die RGB-Werte sind exakt die Defaults der `--cockpit-accent-*` Tokens, also können wir eins-zu-eins auf `color-mix(in srgb, var(--cockpit-accent-*) X%, transparent)` umstellen.

**Nicht angefasst** (bleibt hardcoded):
- `rgba(216, 241, 255, ...)` Stars im Grid (entspricht `--cockpit-text-hud`, Starfield soll neutral weiß bleiben).
- `rgba(11, 18, 32, 0.95)` Planeten-Kern und `rgba(5, 7, 13, 0.8)` Inset-Shadow (sind BG-Farben, nicht theme-spezifisch).
- `rgba(0, 229, 255, 0)` Conic-Gradient-Stops (werden zu `transparent`).

- [ ] **Step 1: `.cockpit-hero-planet` background — pink-glow an 30% 30% (Zeile 115)**

Old:
```css
    radial-gradient(circle at 30% 30%, rgba(255, 47, 209, 0.4) 0%, transparent 35%),
```

New:
```css
    radial-gradient(circle at 30% 30%, color-mix(in srgb, var(--cockpit-accent-pink) 40%, transparent) 0%, transparent 35%),
```

- [ ] **Step 2: `.cockpit-hero-planet` background — violet-glow an 70% 70% (Zeile 116)**

Old:
```css
    radial-gradient(circle at 70% 70%, rgba(124, 58, 237, 0.35) 0%, transparent 45%),
```

New:
```css
    radial-gradient(circle at 70% 70%, color-mix(in srgb, var(--cockpit-accent-violet) 35%, transparent) 0%, transparent 45%),
```

- [ ] **Step 3: `.cockpit-hero-planet` background — cyan-mid Stop (Zeile 117)**

Old:
```css
    radial-gradient(circle at 50% 50%, var(--cockpit-accent-cyan) 0%, rgba(0, 229, 255, 0.6) 25%, rgba(11, 18, 32, 0.95) 70%);
```

New:
```css
    radial-gradient(circle at 50% 50%, var(--cockpit-accent-cyan) 0%, color-mix(in srgb, var(--cockpit-accent-cyan) 60%, transparent) 25%, rgba(11, 18, 32, 0.95) 70%);
```

(Der letzte Stop `rgba(11, 18, 32, 0.95)` bleibt — ist die dunkle Planeten-Mitte.)

- [ ] **Step 4: `.cockpit-hero-planet` box-shadow cyan (Zeile 119)**

Old:
```css
    0 0 60px rgba(0, 229, 255, 0.35),
```

New:
```css
    0 0 60px color-mix(in srgb, var(--cockpit-accent-cyan) 35%, transparent),
```

- [ ] **Step 5: `.cockpit-hero-planet` box-shadow violet (Zeile 120)**

Old:
```css
    0 0 120px rgba(124, 58, 237, 0.25),
```

New:
```css
    0 0 120px color-mix(in srgb, var(--cockpit-accent-violet) 25%, transparent),
```

(Die `inset 0 0 40px rgba(5, 7, 13, 0.8)` Zeile bleibt — dark-anchor Shadow.)

- [ ] **Step 6: `.cockpit-hero-halo` conic-gradient (Zeilen 132-136)**

Old:
```css
  background: conic-gradient(
    from 0deg,
    rgba(0, 229, 255, 0) 0deg,
    rgba(0, 229, 255, 0.4) 90deg,
    rgba(124, 58, 237, 0.35) 180deg,
    rgba(255, 47, 209, 0.3) 270deg,
    rgba(0, 229, 255, 0) 360deg
  );
```

New:
```css
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    color-mix(in srgb, var(--cockpit-accent-cyan) 40%, transparent) 90deg,
    color-mix(in srgb, var(--cockpit-accent-violet) 35%, transparent) 180deg,
    color-mix(in srgb, var(--cockpit-accent-pink) 30%, transparent) 270deg,
    transparent 360deg
  );
```

- [ ] **Step 7: `.cockpit-hero-grid` mint-dot (Zeile 157)**

Old:
```css
    radial-gradient(1.5px 1.5px at 85% 25%, rgba(34, 255, 192, 0.5), transparent),
```

New:
```css
    radial-gradient(1.5px 1.5px at 85% 25%, color-mix(in srgb, var(--cockpit-accent-mint) 50%, transparent), transparent),
```

- [ ] **Step 8: `.cockpit-hero-grid` pink-dot (Zeile 158)**

Old:
```css
    radial-gradient(1px 1px at 15% 80%, rgba(255, 47, 209, 0.4), transparent);
```

New:
```css
    radial-gradient(1px 1px at 15% 80%, color-mix(in srgb, var(--cockpit-accent-pink) 40%, transparent), transparent);
```

(Die 3 weißen Star-Dots mit `rgba(216, 241, 255, ...)` bleiben unverändert — sind neutrale Starfield-Dekoration.)

- [ ] **Step 9: Verify — nur die erwarteten rgbas bleiben**

Run: `grep -n "rgba(" styles/cockpit.css`
Expected: EXAKT 5 Matches:
- `rgba(11, 18, 32, 0.95)` (Planet-Kern)
- `rgba(5, 7, 13, 0.8)` (Planet-Inset-Shadow)
- 3× `rgba(216, 241, 255, ...)` (Starfield-Dots)

Keine Matches für `rgba(0, 229, 255, ...)`, `rgba(124, 58, 237, ...)`, `rgba(255, 47, 209, ...)`, `rgba(34, 255, 192, ...)` — die sind alle auf color-mix umgestellt.

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean exit.

- [ ] **Step 11: Commit**

```bash
git add styles/cockpit.css
git commit -m "refactor(cockpit): make hero planet, halo, grid theme-reactive via color-mix"
```

---

## Task 4 — Verifikation

**Files:** keine Änderungen.

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 2: Tests**

Run: `npx vitest run`
Expected: Alle Tests grün (ggf. minus die 15 bekannten sqlite-native-Fails, unrelated).

- [ ] **Step 3: Manual Visual Test**

1. `npm start`
2. Cockpit öffnen, DevTools → `data-theme="cyan"` checken
3. Alle 8 Theme-Presets durchklicken:
   - cyan (unverändert zum Iteration-1-Stand)
   - blue
   - violet
   - orange (unverändert zum Iteration-1-Stand)
   - green
   - pink
   - gold
   - red
4. Für jeden Theme prüfen:
   - Page-Fade bleibt dunkel (war nicht in Scope)
   - Slider-Thumb & Hero-Caption zeigen das `--sarah-accent` des Themes
   - 3 System-Load-Ringe zeigen die 3 theme-spezifischen Farben
   - **Hero-Planet**, Halo und Starfield-Dots passen zum Theme (neu — Task 3)
   - Listening-State (mint) bleibt immer mint — semantischer Anker
   - Error-States bleiben rot
5. Settings-Label oben in der Farbauswahl zeigt jetzt "Theme" statt "Akzentfarbe"

- [ ] **Step 4: User signs off**

Nach positivem Visual-Test: Farben der 6 neuen Themes ggf. feintunen (separate Commits), dann über `superpowers:finishing-a-development-branch` mergen/PR erstellen.

---

## Spec-Coverage-Check

| Anforderung | Tasks |
|---|---|
| 6 neue Theme-Paletten | Task 1 |
| Settings-Label "Theme" statt "Akzentfarbe" | Task 2 |
| Hero-Planet/Halo/Grid theme-reaktiv (I1 aus Iteration-1-Review) | Task 3 |
| Keine Regression für cyan/orange (Iteration 1) | Alle Tasks: cyan-default bleibt via `:root`, orange bleibt via bestehendem Block |

**Was NICHT in Iteration 2 ist** (Forward-Looking aus Reviewer-Feedback, Iteration 3 falls gewünscht):
- **I2:** `--cockpit-border-glow` Token hat noch hardcoded Hex-Werte. Eigener Task wenn der Glow theme-reaktiv sein soll.
- **I3:** `--sarah-accent-rgb`/`-hover` werden nur via JS-Setter gefüllt. Nicht kritisch weil defaults in `:root` stehen.
- Feintuning der Theme-Hex-Werte nach dem Visual-Test.

## Rollback

Wie Iteration 1: Jeder Task ist file-lokal und klein, einzelne Commits reverten ist trivial.
