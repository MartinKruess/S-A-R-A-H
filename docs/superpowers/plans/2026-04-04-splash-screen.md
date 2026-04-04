# Splash Screen Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Animated splash intro that plays on app launch — text fade-in, light streak arc, particle dissolution — then transitions to an empty dashboard.

**Architecture:** Two-page Electron app. Main process loads splash.html first, splash renderer runs Canvas 2D animation, signals completion via IPC, main process then loads dashboard.html. All animation logic lives in a single splash.ts renderer file.

**Tech Stack:** Electron 41, TypeScript 6, Canvas 2D API, IPC (main ↔ renderer)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `assets/fonts/DancingScript-Regular.woff2` | Create | Bundled Google Font |
| `splash.html` | Create | Splash page: text elements + canvas overlay |
| `dashboard.html` | Create | Empty dashboard placeholder |
| `src/splash.ts` | Create | Renderer entry: light streak, particles, animation timeline, IPC signal |
| `src/preload.ts` | Modify | Expose `splashDone` IPC call to renderer |
| `src/main.ts` | Modify | Load splash first, listen for IPC, switch to dashboard |
| `index.html` | Delete | Replaced by splash.html + dashboard.html |
| `tsconfig.json` | Modify | Add DOM lib for renderer-side code |

---

### Task 1: Project Setup — Font + TypeScript Config

**Files:**
- Create: `assets/fonts/DancingScript-Regular.woff2`
- Modify: `tsconfig.json`
- Delete: `index.html`

- [ ] **Step 1: Download Dancing Script font**

Download the woff2 file from Google Fonts and save to `assets/fonts/`:

```bash
mkdir -p assets/fonts
curl -L -o assets/fonts/DancingScript-Regular.woff2 "https://fonts.gstatic.com/s/dancingscript/v25/If2RXTr6YS-zF4S-kcSWSVi_szLgiuE.woff2"
```

Verify the file exists and is non-empty (should be ~30-70KB).

- [ ] **Step 2: Add DOM types to tsconfig.json**

Change the `lib` array from `["ES2022"]` to `["ES2022", "DOM"]` so renderer-side code can use Canvas, Document, and other DOM APIs:

```json
"lib": ["ES2022", "DOM"],
```

- [ ] **Step 3: Delete index.html**

Remove the old `index.html` — it's replaced by `splash.html` and `dashboard.html`.

```bash
rm index.html
```

- [ ] **Step 4: Verify TypeScript still compiles**

```bash
npx tsc
```

Expected: compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add assets/fonts/DancingScript-Regular.woff2 tsconfig.json
git rm index.html
git commit -m "chore: add Dancing Script font, update tsconfig for DOM, remove index.html"
```

---

### Task 2: Splash HTML Page

**Files:**
- Create: `splash.html`

- [ ] **Step 1: Create splash.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'" />
    <title>S.A.R.A.H.</title>
    <style>
      @font-face {
        font-family: "Dancing Script";
        src: url("assets/fonts/DancingScript-Regular.woff2") format("woff2");
        font-weight: 400;
        font-style: normal;
        font-display: block;
      }

      * { margin: 0; padding: 0; box-sizing: border-box; }

      body {
        background: #0a0a1a;
        overflow: hidden;
        width: 100vw;
        height: 100vh;
      }

      #splash-container {
        position: absolute;
        top: 0; left: 0;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        z-index: 10;
      }

      #splash-title {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 4rem;
        font-weight: 300;
        letter-spacing: 0.3em;
        color: #e8e8f0;
        opacity: 0;
        transition: opacity 0.5s ease-in;
      }

      #splash-subtitle {
        font-family: "Dancing Script", cursive;
        font-size: 1.15rem;
        color: #a0a0b8;
        margin-top: 0.5rem;
        opacity: 0;
        transition: opacity 0.5s ease-in;
      }

      #splash-title.visible,
      #splash-subtitle.visible {
        opacity: 1;
      }

      #splash-canvas {
        position: absolute;
        top: 0; left: 0;
        width: 100%;
        height: 100%;
        z-index: 20;
        pointer-events: none;
      }
    </style>
  </head>
  <body>
    <div id="splash-container">
      <div id="splash-title">S.A.R.A.H.</div>
      <div id="splash-subtitle">Smart Assistant for Resource and Administration Handling</div>
    </div>
    <canvas id="splash-canvas"></canvas>
    <script src="dist/splash.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Verify file renders (quick check)**

Temporarily add a minimal `src/splash.ts`:

```typescript
console.log("splash loaded");
```

Run `npx tsc` then `npx electron .` (after Task 4 updates main.ts to load splash.html — for now just verify the HTML is valid by checking tsc compiles).

- [ ] **Step 3: Commit**

```bash
git add splash.html src/splash.ts
git commit -m "feat: add splash.html with text layout and canvas overlay"
```

---

### Task 3: Dashboard HTML Page

**Files:**
- Create: `dashboard.html`

- [ ] **Step 1: Create dashboard.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
    <title>S.A.R.A.H.</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }

      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #0a0a1a;
        color: #e0e0e0;
        width: 100vw;
        height: 100vh;
        display: flex;
        justify-content: center;
        align-items: center;
      }

      .placeholder {
        font-size: 1.2rem;
        color: #555;
      }
    </style>
  </head>
  <body>
    <div class="placeholder">Dashboard</div>
  </body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add dashboard.html
git commit -m "feat: add empty dashboard.html placeholder"
```

---

### Task 4: Preload IPC Bridge

**Files:**
- Modify: `src/preload.ts`

- [ ] **Step 1: Update preload.ts to expose splashDone**

Replace the entire file content with:

```typescript
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sarah", {
  version: process.versions.electron,
  splashDone: () => ipcRenderer.send("splash-done"),
});
```

This exposes `window.sarah.splashDone()` to the renderer, which sends an IPC message to the main process.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/preload.ts
git commit -m "feat: expose splashDone IPC in preload bridge"
```

---

### Task 5: Main Process — Splash → Dashboard Flow

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Update main.ts to load splash first and handle IPC transition**

Replace the entire file content with:

```typescript
import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    backgroundColor: "#0a0a1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "splash.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
}

ipcMain.on("splash-done", () => {
  if (mainWindow) {
    mainWindow.loadFile(path.join(__dirname, "..", "dashboard.html"));
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
```

Key changes from original:
- `show: false` + `ready-to-show` prevents white flash on startup
- `backgroundColor` matches the splash background
- Loads `splash.html` instead of `index.html`
- Listens for `splash-done` IPC to switch to `dashboard.html`

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc
```

Expected: no errors.

- [ ] **Step 3: Quick smoke test**

```bash
npm start
```

Expected: Window opens showing the splash text (no animation yet). Close manually.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: main process loads splash first, transitions to dashboard on IPC"
```

---

### Task 6: Light Streak Animation

**Files:**
- Create: `src/splash.ts` (replace placeholder from Task 2)

This is the core animation. The light streak is a glowing arc that follows a quadratic bezier path under the text, shaped like a smiley mouth. It has a bright warmwhite head and a fading silver trail.

- [ ] **Step 1: Write the light streak module in splash.ts**

Replace `src/splash.ts` with:

```typescript
// --- Type declarations for preload-exposed API ---
interface SarahAPI {
  version: string;
  splashDone: () => void;
}

declare global {
  interface Window {
    sarah: SarahAPI;
  }
}

// --- Canvas setup ---
const canvas = document.getElementById("splash-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function resizeCanvas(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// --- Bezier path utilities ---
function quadraticBezier(
  t: number,
  p0: [number, number],
  p1: [number, number],
  p2: [number, number]
): [number, number] {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

// --- Light streak ---
interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

const STREAK_DURATION = 2500; // ms
const TRAIL_LENGTH = 35;
const trail: TrailPoint[] = [];

function getStreakPath(): {
  start: [number, number];
  control: [number, number];
  end: [number, number];
} {
  const w = canvas.width;
  const h = canvas.height;
  const centerY = h * 0.5;
  const arcDepth = h * 0.12;

  return {
    start: [w * 0.15, centerY + arcDepth * 0.3],
    control: [w * 0.4, centerY + arcDepth],
    end: [w * 0.65, centerY + arcDepth * 0.3],
  };
}

function drawStreakHead(x: number, y: number): void {
  // Outer glow
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 30);
  glow.addColorStop(0, "rgba(255, 248, 235, 0.9)");
  glow.addColorStop(0.3, "rgba(255, 240, 220, 0.4)");
  glow.addColorStop(1, "rgba(255, 240, 220, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, 30, 0, Math.PI * 2);
  ctx.fill();

  // Bright core
  const core = ctx.createRadialGradient(x, y, 0, x, y, 6);
  core.addColorStop(0, "rgba(255, 255, 255, 1)");
  core.addColorStop(1, "rgba(255, 248, 235, 0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
}

function drawTrail(): void {
  if (trail.length < 2) return;

  for (let i = 1; i < trail.length; i++) {
    const prev = trail[i - 1]!;
    const curr = trail[i]!;
    const life = 1 - curr.age / TRAIL_LENGTH;
    const alpha = life * life * 0.6;
    const width = life * 4;

    ctx.strokeStyle = `rgba(255, 245, 230, ${alpha})`;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(curr.x, curr.y);
    ctx.stroke();
  }
}

function updateTrail(x: number, y: number): void {
  trail.unshift({ x, y, age: 0 });
  for (let i = 0; i < trail.length; i++) {
    trail[i]!.age++;
  }
  while (trail.length > TRAIL_LENGTH) {
    trail.pop();
  }
}

function fadeOutTrail(): void {
  for (let i = 0; i < trail.length; i++) {
    trail[i]!.age += 2;
  }
  while (trail.length > 0 && trail[trail.length - 1]!.age > TRAIL_LENGTH) {
    trail.pop();
  }
}

// --- Exported for use in animation timeline (Task 7) ---
export {
  ctx,
  canvas,
  resizeCanvas,
  quadraticBezier,
  getStreakPath,
  drawStreakHead,
  drawTrail,
  updateTrail,
  fadeOutTrail,
  trail,
  STREAK_DURATION,
};
```

Wait — since this is a single-file renderer script loaded by a `<script>` tag, we can't use ES module exports. The entire splash logic (streak + particles + timeline) must live in one file. Let me restructure.

- [ ] **Step 1 (revised): Write the complete splash.ts with light streak, particles, and timeline**

Replace `src/splash.ts` entirely with the following. This is the complete file:

```typescript
// --- Type declarations for preload-exposed API ---
interface SarahAPI {
  version: string;
  splashDone: () => void;
}

declare global {
  interface Window {
    sarah: SarahAPI;
  }
}

// ============================================================
// Canvas setup
// ============================================================
const canvas = document.getElementById("splash-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function resizeCanvas(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// ============================================================
// Bezier path utility
// ============================================================
function quadraticBezier(
  t: number,
  p0: [number, number],
  p1: [number, number],
  p2: [number, number]
): [number, number] {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

function getStreakPath(): {
  start: [number, number];
  control: [number, number];
  end: [number, number];
} {
  const w = canvas.width;
  const h = canvas.height;
  const centerY = h * 0.52;
  const arcDepth = h * 0.10;

  return {
    start: [w * 0.15, centerY],
    control: [w * 0.4, centerY + arcDepth],
    end: [w * 0.65, centerY],
  };
}

// ============================================================
// Light streak
// ============================================================
interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

const STREAK_DURATION = 2500;
const TRAIL_MAX_AGE = 35;
const trail: TrailPoint[] = [];

function drawStreakHead(x: number, y: number): void {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 30);
  glow.addColorStop(0, "rgba(255, 248, 235, 0.9)");
  glow.addColorStop(0.3, "rgba(255, 240, 220, 0.4)");
  glow.addColorStop(1, "rgba(255, 240, 220, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, 30, 0, Math.PI * 2);
  ctx.fill();

  const core = ctx.createRadialGradient(x, y, 0, x, y, 6);
  core.addColorStop(0, "rgba(255, 255, 255, 1)");
  core.addColorStop(1, "rgba(255, 248, 235, 0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
}

function drawTrail(): void {
  if (trail.length < 2) return;
  for (let i = 1; i < trail.length; i++) {
    const prev = trail[i - 1]!;
    const curr = trail[i]!;
    const life = 1 - curr.age / TRAIL_MAX_AGE;
    if (life <= 0) continue;
    const alpha = life * life * 0.6;
    const width = life * 4;
    ctx.strokeStyle = `rgba(255, 245, 230, ${alpha})`;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(curr.x, curr.y);
    ctx.stroke();
  }
}

function updateTrail(x: number, y: number): void {
  trail.unshift({ x, y, age: 0 });
  for (let i = 0; i < trail.length; i++) {
    trail[i]!.age++;
  }
  while (trail.length > TRAIL_MAX_AGE) {
    trail.pop();
  }
}

function fadeOutTrail(): boolean {
  for (let i = 0; i < trail.length; i++) {
    trail[i]!.age += 2;
  }
  while (trail.length > 0 && trail[trail.length - 1]!.age > TRAIL_MAX_AGE) {
    trail.pop();
  }
  return trail.length > 0;
}

// ============================================================
// Particle system
// ============================================================
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  decay: number;
  size: number;
  color: string;
}

const particles: Particle[] = [];

function spawnParticlesFromElement(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const count = Math.floor(rect.width * rect.height / 120);
  const style = window.getComputedStyle(el);
  const color = style.color;

  for (let i = 0; i < count; i++) {
    const x = rect.left + Math.random() * rect.width;
    const y = rect.top + Math.random() * rect.height;
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.5 + Math.random() * 2.5;

    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      decay: 0.008 + Math.random() * 0.012,
      size: 1 + Math.random() * 2.5,
      color,
    });
  }
}

function spawnParticlesFromTrail(): void {
  for (const point of trail) {
    if (Math.random() > 0.5) continue;
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.3 + Math.random() * 1.5;
    particles.push({
      x: point.x,
      y: point.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      decay: 0.01 + Math.random() * 0.015,
      size: 1 + Math.random() * 2,
      color: "rgba(255, 245, 230, 1)",
    });
  }
}

function updateAndDrawParticles(): boolean {
  let alive = false;
  for (const p of particles) {
    if (p.life <= 0) continue;
    alive = true;
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    p.vx *= 0.995;
    p.vy *= 0.995;

    const alpha = Math.max(0, p.life);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return alive;
}

// ============================================================
// Animation timeline
// ============================================================
const title = document.getElementById("splash-title")!;
const subtitle = document.getElementById("splash-subtitle")!;

type Phase = "fade-in" | "streak" | "streak-fade" | "pause" | "dissolve" | "done";

let phase: Phase = "fade-in";
let phaseStart = 0;
let streakProgress = 0;

function startPhase(newPhase: Phase): void {
  phase = newPhase;
  phaseStart = performance.now();
}

function elapsed(): number {
  return performance.now() - phaseStart;
}

function tick(now: number): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  switch (phase) {
    case "fade-in": {
      const t = elapsed();
      if (t < 50) {
        title.classList.add("visible");
      }
      if (t > 300) {
        subtitle.classList.add("visible");
      }
      if (t > 1000) {
        startPhase("streak");
      }
      break;
    }

    case "streak": {
      const t = elapsed();
      streakProgress = Math.min(t / STREAK_DURATION, 1);
      const eased = streakProgress < 0.5
        ? 2 * streakProgress * streakProgress
        : 1 - Math.pow(-2 * streakProgress + 2, 2) / 2;

      const path = getStreakPath();
      const [x, y] = quadraticBezier(eased, path.start, path.control, path.end);
      updateTrail(x, y);
      drawTrail();
      drawStreakHead(x, y);

      if (streakProgress >= 1) {
        startPhase("streak-fade");
      }
      break;
    }

    case "streak-fade": {
      const hasTrail = fadeOutTrail();
      drawTrail();
      if (!hasTrail) {
        startPhase("pause");
      }
      break;
    }

    case "pause": {
      if (elapsed() > 500) {
        // Spawn particles from text elements
        spawnParticlesFromElement(title);
        spawnParticlesFromElement(subtitle);
        spawnParticlesFromTrail();

        // Hide text elements
        title.style.transition = "opacity 0.3s";
        subtitle.style.transition = "opacity 0.3s";
        title.style.opacity = "0";
        subtitle.style.opacity = "0";

        startPhase("dissolve");
      }
      break;
    }

    case "dissolve": {
      const alive = updateAndDrawParticles();
      if (!alive) {
        startPhase("done");
      }
      break;
    }

    case "done": {
      window.sarah.splashDone();
      return; // Stop the animation loop
    }
  }

  requestAnimationFrame(tick);
}

// --- Start ---
requestAnimationFrame(tick);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/splash.ts
git commit -m "feat: implement splash animation — light streak, particles, timeline"
```

---

### Task 7: Wire Everything Together + Smoke Test

**Files:** No new files — this is integration verification.

- [ ] **Step 1: Verify all files compile**

```bash
npx tsc
```

Expected: no errors.

- [ ] **Step 2: Run the app**

```bash
npm start
```

Expected:
1. Window opens with dark background
2. "S.A.R.A.H." fades in (large, system font)
3. Subtitle fades in (Dancing Script)
4. Warmwhite light arc glides under text (2.5s)
5. Short pause
6. Everything dissolves into particles
7. Dashboard page appears ("Dashboard" placeholder text)

- [ ] **Step 3: Commit if any tweaks were needed**

```bash
git add -A
git commit -m "fix: splash animation integration tweaks"
```

(Skip this step if no changes were needed.)
