# Splash Screen Animation - Design Spec

## Overview

Animated splash/intro screen that plays on app launch before transitioning to the dashboard.

## Visual Design

### Text
- **Title:** "S.A.R.A.H." — system sans-serif font, large, centered
- **Subtitle:** "Smart Assistant for Resource and Administration Handling" — Dancing Script font (bundled locally as woff2), small, centered below title

### Light Animation
- **Shape:** Smiley-mouth arc (similar to TUI logo), curving downward beneath the text
- **Appearance:** Gleaming warmwhite/silver shooting star with trailing glow
- **Path:** Arc from 15% left to 65% left (35% from right), bowing downward under the text
- **Duration:** 2.5s

### Particle Dissolution
- After a short pause, all visible elements (text + light remnants) break apart into glowing particles
- Particles drift outward and fade to transparent
- Dashboard fades in behind

## Animation Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| 1. Title fade-in | 0.5s | "S.A.R.A.H." fades in, centered |
| 2. Subtitle fade-in | 0.5s | Dancing Script subtitle fades in (0.3s delay after title) |
| 3. Light streak | 2.5s | Smiley-mouth arc glides under the text, warmwhite/silver with glow trail |
| 4. Pause | 0.5s | Hold complete composition |
| 5. Particle dissolve | 1.5s | All elements break into luminous particles that scatter and fade |
| 6. Dashboard fade-in | 0.5s | Empty dashboard page appears |

**Total duration:** ~6s

## Technical Approach

### Rendering
- **Text:** HTML/CSS with opacity transitions for fade-in
- **Light streak + particles:** Canvas 2D overlay
- **Rationale:** Three.js is planned for the future 3D avatar but is overkill for this 2D effect. Canvas 2D gives full control over the light trail and particle physics without adding a heavy dependency.

### File Structure
- `src/splash.ts` — Canvas 2D logic: light streak animation, particle system, dissolution effect
- `src/renderer.ts` — Orchestrates splash → dashboard transition, manages page state
- `assets/fonts/DancingScript-Regular.woff2` — Locally bundled Google Font
- `splash.html` — Splash screen page (loaded by Electron on start)
- `dashboard.html` — Empty dashboard page (post-splash destination)

### Font Loading
- Dancing Script font downloaded and stored in `assets/fonts/`
- Loaded via `@font-face` in CSS — no external network requests at runtime

### Page Flow
1. Electron main process loads `splash.html`
2. Splash animation plays to completion
3. `renderer.ts` signals main process via IPC when animation finishes
4. Main process loads `dashboard.html` (or renderer swaps content in single-page approach)

### Single-Page vs Multi-Page
Using two separate HTML files (splash.html + dashboard.html) keeps concerns cleanly separated. The main process handles the page switch via `mainWindow.loadFile()` after receiving an IPC message from the splash renderer.

## Future Considerations
- Three.js will be added later for a 3D avatar (realistic or stylized, with lip-sync)
- The splash screen does not need Three.js and should remain Canvas 2D
- Dashboard will eventually host the avatar and UI controls
