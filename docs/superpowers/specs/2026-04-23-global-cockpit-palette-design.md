---
title: Global Cockpit Palette & Font Consolidation
date: 2026-04-23
status: design-phase
---

# Globale Cockpit-Palette und Font-Konsolidierung

## Ziel

Die vier Pages der App (splash, dashboard, cockpit, settings) nutzen ab sofort **eine gemeinsame Farb- und Font-Palette**, abgeleitet von der Cockpit-Designsprache. Dies erzeugt visuelle Kohäsion, ohne Ornamente (Planet, Halo, Chamfer, Grain) in andere Views zu kopieren — nur **Werte + Fonts**.

**Nicht in scope:** Layout-Änderungen, Cockpit-spezifische Effekte, Ornitron-Einsatz außerhalb von HUD-Kontexten.

## Status Quo

Aktuell arbeitet die App mit zwei separaten Token-Welten:

### `--sarah-*` Tokens (overall app)

- `--sarah-bg-primary: #0a0a1a` (dunkles Ultra-Blau)
- `--sarah-bg-secondary: #12122a` (etwas heller, leicht violett)
- `--sarah-bg-surface: rgba(255, 255, 255, 0.03)` (3% Weiß-Overlay)
- `--sarah-bg-surface-hover: rgba(255, 255, 255, 0.06)` (6% Weiß-Overlay)
- `--sarah-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', ...` (System-Fonts)

Konsumenten (17 Files): `base.css`, `dashboard.css`, `wizard.css`, `boot.css`, `chat.css`, alle Component-TS-Dateien (sarah-button, sarah-card, sarah-input, etc.).

### `--cockpit-*` Tokens (nur Cockpit-View)

- `--cockpit-bg-void: #05070d` (noch dunkler, mehr Blau)
- `--cockpit-bg-deep: #0b1220` (Panel-Hintergrund)
- `--cockpit-bg-panel: rgba(11, 18, 32, 0.72)` (Glass-Panel-Effekt)
- `--cockpit-font-heading: 'Orbitron'` (sci-fi HUD-Look)
- `--cockpit-font-body: 'Inter'` (modern, clean)
- `--cockpit-font-mono: 'JetBrains Mono'` (technisch, Numerics)

Konsumenten (6 Files): `cockpit.css`, `sarah-panel.ts`, `hud-select.ts`, `hud-toggle.ts`, `hud-vslider.ts`.

**Problem:** Cockpit hat einen "neuen Anstrich" (feinere Farbnuancen, bessere Font-Wahl), aber der Rest der App nutzt weiterhin die alte Palette. Das erzeugt visuell zwei Apps in einer.

## Lösung: Tokens konsolidieren, Cockpit-Werte globalisieren

### Phase 1: Tokens in `styles/theme.css` reorganisieren

#### Werte updaten (Namen behalten für 17-File-Migration sparen)

```css
:root {
  /* Background — neue Werte ab jetzt Cockpit-Basis */
  --sarah-bg-primary: #05070d; /* war: #0a0a1a */
  --sarah-bg-secondary: #0b1220; /* war: #12122a */
  --sarah-bg-surface: rgba(255, 255, 255, 0.03); /* unverändert */
  --sarah-bg-surface-hover: rgba(255, 255, 255, 0.06); /* unverändert */

  /* Neu: Panel-Hintergrund (für sarah-panel.ts, zukünftige Glass-Panels) */
  --sarah-bg-panel: rgba(11, 18, 32, 0.72);

  /* Typography — neue globale Standard-Fonts */
  --sarah-font-family:
    'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --sarah-font-heading:
    'Orbitron', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --sarah-font-mono: 'JetBrains Mono', 'Consolas', 'Monaco', monospace;

  /* ← löschen: --cockpit-bg-void, --cockpit-bg-deep, --cockpit-bg-panel */
  /* ← löschen: --cockpit-font-heading, --cockpit-font-body, --cockpit-font-mono */
}
```

#### Fonts sind bereits geladen

- `dashboard.html` lädt über Google Fonts Stylesheet: Orbitron, Inter, JetBrains Mono ✓
- `dialog.html` (Settings-Dialog) lädt gleich ✓
- `splash.html` hat eigenes inline-CSS, lädt keine Google Fonts (CSP: `font-src 'self'`)

#### Unangetastet bleiben

- `--cockpit-accent-cyan`, `--cockpit-accent-violet`, `--cockpit-accent-pink`, `--cockpit-accent-mint`, `--cockpit-accent-red`
- `--cockpit-text-hud`, `--cockpit-text-dim`
- `--cockpit-border-glow`
- `--cockpit-font-hud-xs`, `--cockpit-font-hud-sm`, `--cockpit-font-hud-md`, `--cockpit-font-hud-lg`, `--cockpit-font-hud-xl`

(Diese sind Cockpit-spezifisch und sollen dort bleiben.)

### Phase 2: Find/Replace in Files mit `--cockpit-*` Referenzen

**Datei: `styles/cockpit.css`**

| Suche                         | Ersetze                     | Grund                                |
| ----------------------------- | --------------------------- | ------------------------------------ |
| `var(--cockpit-bg-void)`      | `var(--sarah-bg-primary)`   | Cockpit nutzt fortan globale Palette |
| `var(--cockpit-bg-deep)`      | `var(--sarah-bg-secondary)` | —                                    |
| `var(--cockpit-font-heading)` | `var(--sarah-font-heading)` | —                                    |
| `var(--cockpit-font-body)`    | `var(--sarah-font-family)`  | —                                    |
| `var(--cockpit-font-mono)`    | `var(--sarah-font-mono)`    | —                                    |

**Datei: `src/renderer/components/sarah-panel.ts`**

| Suche                    | Ersetze                |
| ------------------------ | ---------------------- |
| `--cockpit-bg-panel`     | `--sarah-bg-panel`     |
| `--cockpit-font-heading` | `--sarah-font-heading` |
| `--cockpit-font-body`    | `--sarah-font-family`  |
| `--cockpit-font-mono`    | `--sarah-font-mono`    |

**Dateien: `src/renderer/components/hud-select.ts`, `hud-toggle.ts`, `hud-vslider.ts`**

| Suche                    | Ersetze                |
| ------------------------ | ---------------------- |
| `--cockpit-font-heading` | `--sarah-font-heading` |
| `--cockpit-font-body`    | `--sarah-font-family`  |
| `--cockpit-font-mono`    | `--sarah-font-mono`    |

### Phase 3: `splash.html` — nur BG updaten

Splash lädt keine externen Fonts (CSP-Policy), nutzt aber System-Font für Title. Nur die hardcoded BG-Farbe anpassen:

```html
<style>
  body {
    background: #05070d;  /* war: #0a0a1a */
    overflow: hidden;
    ...
  }
</style>
```

Title-Font bleibt System-Stack. Inter-Integration im Splash erfordert Font-Bundling oder CSP-Anpassung → separater Task später.

## Erwartete visuelle Effekte

| Element                              | Vorher                            | Nachher                  | Grund                                |
| ------------------------------------ | --------------------------------- | ------------------------ | ------------------------------------ |
| Dashboard/Settings/Wizard Background | `#0a0a1a` (warm-schwarz)          | `#05070d` (kühl-schwarz) | Cockpit-Blauton überall              |
| Card/Panel Bg                        | `#12122a` + rgba-Overlay          | `#0b1220` (präziser)     | Cockpit-Tiefton                      |
| Body-Text (Dashboard, Settings)      | System-Sans (Segoe UI)            | Inter (cleaner)          | Cockpit-Schriftart                   |
| Splash                               | `#0a0a1a` (warm)                  | `#05070d` (kühl)         | Konsistenz                           |
| Cockpit                              | **Unverändert** (nur Token-Namen) | **Unverändert**          | Tokens zeigen auf neue globale Namen |

### Farbliche Konvergenz

- **Dunkelheit:** Alle Pages nutzen jetzt das tiefere `#05070d` als Basis (war teils `#0a0a1a`).
- **Ton:** Der starke Cyan-/Blau-Schimmer von Cockpit breitet sich jetzt subtil über Settings/Wizard aus (weniger Violett, mehr Cyan).
- **Panel-Fläche:** `#0b1220` wird überall konsistent als Secondary-Background genommen.

### Font-Wirkung

- **Inter als Body:** Text wird leicht kompakter und moderner. Kein Spacing-Shift erwartet (Inter hat ähnliche Metrics wie Segoe UI in Größe 1rem).
- **Orbitron & JetBrains Mono:** Liegen vor, werden aber erst später auf Headings/Numerics angewendet (separater Task).

## Nicht im Scope

1. **Orbitron-Einsatz in anderen Views:** Headings in Settings/Wizard/Boot bleiben vorerst System-Font oder fahren mit Inter. Orbitron-Anwendung auf h1/h2/h3 kommt später ("Besprechen wir danach nochmal direkt").
2. **Cockpit-Effekte außerhalb:** Planet, Halo, Grain-Overlay, Chamfered Borders bleiben Cockpit-exklusiv.
3. **Surface-Token Feintuning:** `--sarah-bg-surface` (3% Weiß) könnte auf dunklerer Base schwächer wirken. Erst nach visuellem Check in Electron prüfen.
4. **Splash-Font-Upgrade:** Inter im Splash braucht entweder Font-Bundling (`.woff2` lokal) oder CSP-Anpassung. Später.

## Implementierung: Checklist

- [ ] `styles/theme.css` updaten (Werte + neue Tokens + Löschungen)
- [ ] `styles/cockpit.css` Find/Replace (`--cockpit-*` → `--sarah-*`)
- [ ] `src/renderer/components/sarah-panel.ts` Find/Replace
- [ ] `src/renderer/components/hud-select.ts` Find/Replace
- [ ] `src/renderer/components/hud-toggle.ts` Find/Replace
- [ ] `src/renderer/components/hud-vslider.ts` Find/Replace
- [ ] `splash.html` BG-Farbe updaten
- [ ] Grep nach hardcoded `#0a0a1a` / `#12122a` (Falls noch welche rumfliegen)
- [ ] TypeScript typecheck + Unit-Tests laufen lassen
- [ ] Visueller Walkthrough (Electron): Splash → Boot → Cockpit → Dashboard → Settings → Wizard
  - Surface-Overlay `rgba(255,255,255,0.03)` auf neuer Base bewerten
  - Font-Wirkung (Inter) checken
  - Farbton-Konsistenz prüfen

## Risks & Mitigations

| Risk                                                      | Mitigation                                                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Irgendwo hardcoded `#0a0a1a` statt Token                  | Grep-Scan vor Commit: `grep -r "#0a0a1a" src/` + `grep -r "#12122a" src/`                                                               |
| `--sarah-bg-surface` 3%-Weiß ist auf `#05070d` zu schwach | Erst nach Visual Check bewerten. Falls nötig: auf 5–6% erhöhen oder auf Cockpit-Panel-Basis (`rgba(11,18,32,0.15)`) umstellen.          |
| Google Fonts laden nicht (CSP?)                           | CSP in `dashboard.html` + `dialog.html` erlaubt bereits `https://fonts.googleapis.com` + `https://fonts.gstatic.com`. No change needed. |
| `sarah-panel.ts` nutzt noch andere `--cockpit-*` Tokens   | Schnellcheck beim Find/Replace: grep `--cockpit-` in sarah-panel.ts vor Abschluss.                                                      |
| Cockpit visuell ändert sich unerwünscht                   | Tokens zeigen auf exakt die gleichen RGB-Werte, nur neue Namen. Visuell 1:1 identisch.                                                  |

## Success Criteria

✅ Alle 17 Files mit `--sarah-bg-primary/secondary` sehen die neuen Werte automatisch.
✅ Cockpit lädt (token-technisch) aus der globalen Palette, nicht aus separaten `--cockpit-*` Tokens.
✅ `tsc` + Unit-Tests laufen grün.
✅ Visual Walkthrough zeigt konsistente, cooler-tonige Palette überall.
✅ Keine Rendering-Brüche oder unerwartete Font-Fallbacks.
✅ Splash wird dunkler, bleibt aber funktional.

## Nächste Schritte (nach diesem Task)

1. **Orbitron + JetBrains Mono Einsatz:** User trifft Entscheidung wo (h1/h2, Numerics, Timestamps, etc.). Neuer Task.
2. **Inter im Splash:** Font-Bundling oder CSP-Anpassung. Separater Task.
3. **Surface-Wirkung:** Nach Live-Check eventuell Transparenz feintunen.
4. **Visual Alignment Rest der App:** Memory sagt "Wizard, Boot, Sarah-View später optisch ans Cockpit angleichen" — mit dieser Basis können wir später gezielter arbeiten.
