# Splash Phase 2 — Boot Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After Phase 1 text animation, show a real boot sequence with status messages, router-gated orb reveal, "Willkommen!" chat bubble, and TTS-triggered break effect.

**Architecture:** The main process preloads providers during Phase 1, then activates them sequentially after Phase 1 ends. Each activation step sends a `boot-status` IPC to the renderer, which shows status messages, triggers orb reveal on router-ready, and triggers break + TTS on piper-ready. The `splash.ts` animation loop gains new phases that react to IPC events instead of fixed timers.

**Tech Stack:** Electron IPC, TypeScript, Canvas 2D, Three.js (SarahHexOrb), Piper TTS

**Important for execution:** Always read the current state of a file before editing. Never rely on line numbers — search for code snippets to locate edit positions. The codebase may have changed since this plan was written.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/sarah-api.ts` | Modify | Add `BootStatus` type + `onBootStatus`, `bootReady` to `SarahApi` |
| `src/core/ipc-contract.ts` | Modify | Add `boot-status` to IPC contract |
| `src/core/bus-events.ts` | Modify | Add `boot:status` bus event |
| `src/preload.ts` | Modify | Wire `onBootStatus` and `bootReady` IPC bridges |
| `src/main.ts` | Modify | Restructure service init: preload during splash, activate sequentially after `boot-ready`, send `boot-status` events, add `splash-tts` IPC handler |
| `splash.html` | Modify | Add status message container + chat bubble container |
| `src/splash.ts` | Modify | Replace `hold`/`done` phases with boot-sequence phases, render status messages, chat bubble, break timing, TTS trigger |
| `src/sarahHexOrb.ts` | Modify | Remove click-listener for break in splash (keep `triggerBreak()` public) |

---

### Task 1: Add Boot-Status IPC Contract + Types

**Files:**
- Modify: `src/core/sarah-api.ts`
- Modify: `src/core/bus-events.ts`
- Modify: `src/core/ipc-contract.ts`

- [ ] **Step 1: Add BootStatus type to sarah-api.ts**

In `src/core/sarah-api.ts`, add the type before `SarahVoiceApi`:

```typescript
/** Boot sequence status sent from main to splash renderer */
export type BootStatus = {
  step: 'whisper' | 'router' | 'router-ready' | 'piper' | 'piper-ready';
  message?: string;
};
```

Add to `SarahApi` interface after `splashDone():

```typescript
  bootReady(): void;
  revealDone(): void;
  onBootStatus(cb: (data: BootStatus) => void): () => void;
  splashTts(text: string): Promise<void>;
```

**Important:** Task 2 (preload.ts) depends on this — the `api` object is typed as `SarahApi`, so these must exist in the interface before they can be added to the implementation. Task 1 must be complete before Task 2.

- [ ] **Step 2: Add boot:status bus event to bus-events.ts**

In `src/core/bus-events.ts`, add to the `BusEvents` type:

```typescript
  'boot:status':         { step: string; message?: string };
```

- [ ] **Step 3: Add boot channels to ipc-contract.ts**

In `src/core/ipc-contract.ts`, the existing structure is:
- `IpcCommands` — invoke/handle (request-response)
- `IpcEvents` — main→renderer (one-way)
- `IpcSendEvents` — renderer→main (one-way)

Add `splash-tts` to `IpcCommands`:

```typescript
  'splash-tts':          { input: { text: string }; output: void };
```

Add `boot-status` to `IpcEvents`:

```typescript
  'boot-status':         BusEvents['boot:status'];
```

Add `boot-ready` and `reveal-done` to `IpcSendEvents`:

```typescript
  'boot-ready': void;
  'reveal-done': void;
```

- [ ] **Step 4: Commit**

```bash
git add src/core/sarah-api.ts src/core/bus-events.ts src/core/ipc-contract.ts
git commit -m "feat: add boot-status IPC contract and BootStatus type"
```

---

### Task 2: Wire Preload IPC Bridges

**Files:**
- Modify: `src/preload.ts`

- [ ] **Step 1: Add bootReady, onBootStatus, splashTts to preload**

In `src/preload.ts`, add these to the `api` object after `splashDone`:

```typescript
  bootReady: () => ipcRenderer.send('boot-ready'),
  revealDone: () => ipcRenderer.send('reveal-done'),
  onBootStatus: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { step: string; message?: string }) => callback(data as any);
    ipcRenderer.on('boot-status', handler);
    return () => ipcRenderer.removeListener('boot-status', handler);
  },
  splashTts: (text) => ipcRenderer.invoke('splash-tts', text),
```

- [ ] **Step 2: Commit**

```bash
git add src/preload.ts
git commit -m "feat: wire boot-status and splash-tts preload bridges"
```

---

### Task 3: Restructure Main Process Service Init

**Files:**
- Modify: `src/main.ts`

This is the biggest change. The current flow is: create providers → register services → `initAll()` in background → on `splash-done` load dashboard. The new flow is: create providers → start Whisper + Router init **immediately** (parallel to Phase 1) → buffer results → on `boot-ready` flush buffered status + continue with Piper → on `splash-done` transition. This eliminates the race condition where services finish before Phase 1.

- [ ] **Step 1: Extract provider creation into separate variables accessible to boot handler**

Move the provider imports and creation to happen right after `bootstrap()` but store providers in module-level variables so the boot handler can access them. In `src/main.ts`, after `appContext = await bootstrap(...)` and config error dialog (line 189), replace everything from line 191 to line 235 with:

```typescript
  // --- Preload: create providers (fast, no activation) ---
  const { llm: llmConfig } = appContext.parsedConfig;
  const routerProvider = new OllamaProvider(llmConfig.baseUrl, llmConfig.routerModel, { ...llmConfig.options, num_ctx: 2048 });
  const numGpu = PERFORMANCE_PROFILE_MAP[llmConfig.performanceProfile] ?? PERFORMANCE_PROFILE_MAP.normal;
  const workerOptions = {
    ...llmConfig.options,
    num_ctx: llmConfig.workerOptions.num_ctx,
    num_gpu: numGpu,
  };
  const workerProvider = new OllamaProvider(llmConfig.baseUrl, llmConfig.workerModel, workerOptions);
  const routerService = new RouterService(appContext, routerProvider, workerProvider);
  appContext.registry.register(routerService);

  const { AudioManager } = await import('./services/voice/audio-manager.js');
  const { HotkeyManager } = await import('./services/voice/hotkey-manager.js');
  const { FasterWhisperProvider } = await import('./services/voice/providers/faster-whisper-provider.js');
  const { PiperProvider } = await import('./services/voice/providers/piper-provider.js');
  const { PorcupineProvider } = await import('./services/voice/providers/porcupine-provider.js');

  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', 'resources');
  const picovoiceKey = process.env.PICOVOICE_ACCESS_KEY ?? '';
  const whisperProvider = new FasterWhisperProvider(resourcesPath);
  const piperProvider = new PiperProvider(resourcesPath);
  const porcupineProvider = new PorcupineProvider(resourcesPath, picovoiceKey);
  const audioManager = new AudioManager();
  const hotkeyManager = new HotkeyManager();

  const voiceService = new VoiceService(
    appContext,
    whisperProvider,
    piperProvider,
    porcupineProvider,
    audioManager,
    hotkeyManager,
  );
  appContext.registry.register(voiceService);

  // --- Start heavy inits immediately (parallel to Phase 1) ---
  // Buffer results so we can flush status to renderer after boot-ready
  let whisperDone = false;
  let whisperError = false;
  let routerDone = false;
  let routerError = false;
  let bootReady = false;

  const send = (step: string, message?: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('boot-status', { step, message });
    }
  };

  // Fire-and-forget: Whisper init
  whisperProvider.init()
    .then(() => { whisperDone = true; })
    .catch((err) => {
      console.error('[Boot] Whisper init failed:', err);
      whisperDone = true;
      whisperError = true;
    });

  // Fire-and-forget: Router init
  routerService.init()
    .then(() => { routerDone = true; })
    .catch((err) => {
      console.error('[Boot] Router init failed:', err);
      routerDone = true;
      routerError = true;
    });
```

- [ ] **Step 2: Add boot-ready handler that flushes buffered state + continues**

After the provider setup and fire-and-forget inits, add the boot-ready IPC handler:

```typescript
  ipcMain.on('boot-ready', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    bootReady = true;

    try {
      // Step 1: Whisper — show status, wait if still loading
      send('whisper', 'Spracherkennung wird aktiviert ...');
      if (!whisperDone) {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (whisperDone) { clearInterval(check); resolve(); }
          }, 50);
        });
      }

      // Step 2: Router — show status, wait if still loading
      send('router', 'Sarah Protokoll wird initialisiert ...');
      if (!routerDone) {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (routerDone) { clearInterval(check); resolve(); }
          }, 50);
        });
      }

      // Signal router ready — renderer starts orb reveal (even if router errored)
      send('router-ready');

      // Step 3: Wait for reveal animation to finish (renderer sends reveal-done IPC)
      await new Promise<void>((resolve) => {
        ipcMain.once('reveal-done', () => resolve());
        // Fallback: if renderer never sends reveal-done, continue after 8s
        setTimeout(resolve, 8000);
      });

      send('piper', 'Sprachprotokolle werden geladen ...');
      await piperProvider.init().catch((err) => {
        console.error('[Boot] Piper init failed:', err);
      });

      // Signal piper ready — renderer starts break + TTS
      send('piper-ready');

      // Remaining optional inits
      await porcupineProvider.init().catch(() => {});
    } catch (err) {
      console.error('[Boot] Activation failed:', err);
      // Ensure splash doesn't hang — send piper-ready as fallback
      send('piper-ready');
    }
  });
```

- [ ] **Step 3: Add splash-tts IPC handler**

Add handler for TTS from splash (uses Piper directly since VoiceService isn't fully wired yet):

```typescript
  ipcMain.handle('splash-tts', async (_event, { text }: { text: string }) => {
    try {
      const audio = await piperProvider.speak(text);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voice:play-audio', {
          audio: Array.from(audio),
          sampleRate: 22050,
        });
      }
    } catch (err) {
      console.error('[Boot] Splash TTS failed:', err);
    }
  });
```

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: restructure service init for boot-sequence activation"
```

---

### Task 4: Add HTML Containers for Status Messages + Chat Bubble

**Files:**
- Modify: `splash.html`

- [ ] **Step 1: Add status container and chat bubble to splash.html**

In `splash.html`, add CSS inside the existing `<style>` block (before `</style>`):

```css
    /* Boot status message — bottom left */
    #boot-status {
      position: absolute;
      bottom: 24px;
      left: 28px;
      z-index: 30;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 0.75rem;
      color: #a0a0b8;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
    }

    #boot-status.visible {
      opacity: 1;
    }

    /* Chat bubble — positioned above orb center */
    #splash-bubble {
      position: absolute;
      top: 35%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 30;
      max-width: 85%;
      padding: 8px 16px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.03);
      color: #e8e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 0.85rem;
      line-height: 1.5;
      opacity: 0;
      transition: opacity 0.4s ease;
      pointer-events: none;
    }

    #splash-bubble.visible {
      opacity: 1;
    }
```

Add the HTML elements in the `<body>`, after `<canvas id="splash-canvas">` and before `<script>`:

```html
    <div id="boot-status"></div>
    <div id="splash-bubble"></div>
```

- [ ] **Step 2: Commit**

```bash
git add splash.html
git commit -m "feat: add boot status and chat bubble containers to splash HTML"
```

---

### Task 5: Remove Click-to-Break from Splash Orb

**Files:**
- Modify: `src/splash.ts`

- [ ] **Step 1: Remove the click listener in splash.ts**

In `src/splash.ts`, read the file first, then find and remove the click-to-break listener block. Search for this code and delete it:

```typescript
// Click triggers break effect for testing
orbContainer.addEventListener('click', () => {
  orb.triggerBreak();
});
```

**Important:** Read the current file before editing — do not rely on line numbers, search for the code snippet above.

- [ ] **Step 2: Commit**

```bash
git add src/splash.ts
git commit -m "fix: remove click-to-break from splash orb"
```

---

### Task 6: Implement Boot Sequence in splash.ts

**Files:**
- Modify: `src/splash.ts`

This is the core change. The `hold` and `done` phases are replaced by boot-sequence phases that react to IPC events.

- [ ] **Step 1: Update SarahAPI interface in splash.ts**

**Note:** `splash.ts` has its own local `SarahAPI` interface (a `declare` for the preload-injected global). This is separate from `src/core/sarah-api.ts`. The local interface must match what the splash actually uses — including `voice` for TTS playback. Search for the existing `interface SarahAPI` block and replace it:

```typescript
// --- Type declarations for preload-exposed API ---
interface BootStatus {
  step: 'whisper' | 'router' | 'router-ready' | 'piper' | 'piper-ready';
  message?: string;
}

interface SarahAPI {
  version: string;
  splashDone: () => void;
  bootReady: () => void;
  revealDone: () => void;
  onBootStatus: (cb: (data: BootStatus) => void) => () => void;
  splashTts: (text: string) => Promise<void>;
  voice: {
    onPlayAudio: (cb: (data: { audio: number[]; sampleRate: number }) => void) => () => void;
    playbackDone: () => Promise<void>;
  };
}

declare var sarah: SarahAPI;
```

- [ ] **Step 2: Add boot-sequence state variables after the orb setup**

After the orb initialization block (after `orb.setOrbOffset(0, ORB_START_Y, 0);` ~line 23), add:

```typescript
// ============================================================
// Boot sequence state
// ============================================================
const statusEl = document.getElementById('boot-status')!;
const bubbleEl = document.getElementById('splash-bubble')!;

let routerReady = false;
let piperReady = false;
let dotInterval: ReturnType<typeof setInterval> | null = null;

function showStatus(message: string, animated = false): void {
  // Fade out current
  statusEl.classList.remove('visible');
  if (dotInterval) {
    clearInterval(dotInterval);
    dotInterval = null;
  }

  setTimeout(() => {
    if (animated) {
      // Animated dots: . → .. → ... → (leer) → .
      const base = message.replace(/\s*\.{3}\s*$/, '').replace(/\s*\.\.\.\s*$/, '');
      let dotCount = 0;
      const updateDots = () => {
        const dots = '.'.repeat(dotCount % 4);
        statusEl.textContent = dots.length > 0 ? `${base} ${dots}` : base;
        dotCount++;
      };
      updateDots();
      dotInterval = setInterval(updateDots, 500);
    } else {
      statusEl.textContent = message;
    }
    statusEl.classList.add('visible');
  }, 150); // Brief gap for fade transition
}

function hideStatus(): void {
  statusEl.classList.remove('visible');
  if (dotInterval) {
    clearInterval(dotInterval);
    dotInterval = null;
  }
}

function showBubble(text: string): void {
  bubbleEl.textContent = text;
  bubbleEl.classList.add('visible');
}

function hideBubble(): void {
  bubbleEl.classList.remove('visible');
}
```

- [ ] **Step 3: Update the Phase type and replace hold/done phases**

Replace the Phase type:

```typescript
type Phase = 'fade-in' | 'streak' | 'streak-fade' | 'pause' | 'dissolve'
  | 'spotlight' | 'reveal' | 'boot-wait' | 'boot-reveal' | 'boot-bubble'
  | 'boot-piper-wait' | 'boot-break' | 'done';
```

- [ ] **Step 4: Register boot-status listener and set up audio playback**

Add before the `tick` function:

```typescript
// ============================================================
// Audio playback for splash TTS
// ============================================================
let audioContext: AudioContext | null = null;

function playTtsAudio(audioData: number[], sampleRate: number): Promise<void> {
  return new Promise((resolve) => {
    if (!audioContext) audioContext = new AudioContext({ sampleRate });
    const buffer = audioContext.createBuffer(1, audioData.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < audioData.length; i++) {
      channel[i] = audioData[i];
    }
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => {
      sarah.voice.playbackDone();
      resolve();
    };
    source.start();
  });
}

let ttsAudioResolve: (() => void) | null = null;

sarah.voice.onPlayAudio(({ audio, sampleRate }) => {
  playTtsAudio(audio, sampleRate).then(() => {
    if (ttsAudioResolve) {
      ttsAudioResolve();
      ttsAudioResolve = null;
    }
  });
});

// ============================================================
// Boot status IPC listener
// ============================================================
sarah.onBootStatus((data) => {
  switch (data.step) {
    case 'whisper':
    case 'router':
    case 'piper':
      if (data.message) showStatus(data.message, true);
      break;
    case 'router-ready':
      routerReady = true;
      hideStatus();
      break;
    case 'piper-ready':
      piperReady = true;
      hideStatus();
      break;
  }
});
```

- [ ] **Step 5: Replace the dissolve→spotlight→reveal→hold→done chain in the tick function**

The `dissolve` phase currently transitions to `spotlight`. Change it so that after dissolve, we signal `boot-ready` and enter `boot-wait`:

Replace the `dissolve` case:

```typescript
    case 'dissolve': {
      const alive = updateAndDrawParticles();
      if (!alive) {
        // Phase 1 done — tell main process to start boot sequence
        sarah.bootReady();
        startPhase('boot-wait');
      }
      break;
    }
```

Replace `spotlight`, `reveal`, `hold`, and `done` with the new boot phases:

```typescript
    case 'boot-wait': {
      // Waiting for router-ready from main process
      if (routerReady) {
        startPhase('boot-reveal');
      }
      break;
    }

    case 'boot-reveal': {
      // Same as old spotlight + reveal, but triggered by router-ready
      const t = elapsed();

      if (t < 1400) {
        // Spotlight phase
        const p = t / 1400;
        const cx = canvas2d.width / 2;
        const cy = canvas2d.height * 0.52;
        const glowR = canvas2d.height * 0.35;
        const pulse = Math.sin(p * Math.PI);
        const glowAlpha = pulse * 0.18;

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
        grad.addColorStop(0, `rgba(212, 175, 55, ${glowAlpha})`);
        grad.addColorStop(0.5, `rgba(212, 175, 55, ${glowAlpha * 0.3})`);
        grad.addColorStop(1, 'rgba(212, 175, 55, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas2d.width, canvas2d.height);

        const lightP = p * 0.15;
        orb.setLightIntensity(ORB_START_LIGHT + lightP);
      } else {
        // Reveal phase
        const revealT = t - 1400;
        const REVEAL_MS = 3500;
        const p = Math.min(revealT / REVEAL_MS, 1);
        const eased = 1 - Math.pow(1 - p, 4);

        const scale = ORB_START_SCALE + (1.0 - ORB_START_SCALE) * eased;
        orb.setOrbScale(scale);

        const yOffset = ORB_START_Y * (1 - eased);
        orb.setOrbOffset(0, yOffset, 0);

        const lightBase = ORB_START_LIGHT + 0.15;
        const light = lightBase + (1.0 - lightBase) * eased;
        orb.setLightIntensity(light);

        if (p >= 1) {
          sarah.revealDone(); // Tell main process reveal animation is complete
          startPhase('boot-bubble');
        }
      }
      break;
    }

    case 'boot-bubble': {
      const t = elapsed();
      if (t < 100) {
        showBubble('Willkommen!');
      }
      // Bubble visible for ~2s, then wait for piper
      if (t > 2000) {
        hideBubble();
        startPhase('boot-piper-wait');
      }
      break;
    }

    case 'boot-piper-wait': {
      // Waiting for piper-ready
      if (piperReady) {
        startPhase('boot-break');
      }
      break;
    }

    case 'boot-break': {
      const t = elapsed();
      // Trigger break at t=0, TTS at t=200ms
      if (t < 16) {
        orb.triggerBreak(3000);
      }
      if (t >= 200 && t < 216) {
        // Fire TTS once
        sarah.splashTts('Huch, jetzt bin ich einsatzbereit!');
        ttsAudioResolve = () => {
          startPhase('done');
        };
      }
      // Fallback: if TTS fails or takes too long, move on after 6s
      if (t > 6000 && phase === 'boot-break') {
        startPhase('done');
      }
      break;
    }

    case 'done': {
      sarah.splashDone();
      return;
    }
```

- [ ] **Step 6: Build and verify**

Run: `npm run build`

Expected: No TypeScript errors. The splash should now:
1. Play Phase 1 as before (text, streak, dissolve)
2. After dissolve, send `boot-ready` and wait
3. Show status messages from main process
4. Orb reveals when router is ready
5. "Willkommen!" bubble appears after reveal
6. Break + TTS when piper is ready
7. `splashDone()` after TTS completes

- [ ] **Step 7: Commit**

```bash
git add src/splash.ts
git commit -m "feat: implement boot sequence phases in splash renderer"
```

---

### Task 7: Smoke Test + Polish

**Files:**
- All modified files

- [ ] **Step 1: Run the app and verify the full boot sequence**

Run: `npm start`

Verify:
1. Splash appears instantly
2. Phase 1 text animation plays normally
3. After dissolve, status messages appear bottom-left
4. "Spracherkennung wird aktiviert ..." → "Sarah Protokoll wird initialisiert ..." with animated dots
5. Orb reveals when router is ready (spotlight → scale up)
6. "Willkommen!" chat bubble appears above orb
7. "Sprachprotokolle werden geladen ..." appears
8. Break effect triggers, then Sarah speaks "Huch, jetzt bin ich einsatzbereit!"
9. After TTS, `splashDone` fires → dashboard loads

- [ ] **Step 2: Test error case — what if router takes very long?**

Verify that the animated dots keep cycling and the splash stays responsive while waiting.

- [ ] **Step 3: Test error case — what if Piper fails?**

The fallback timeout (6s in `boot-break`) should ensure `splashDone()` still fires.

- [ ] **Step 4: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "fix: polish boot sequence timing and edge cases"
```

---

## Spec Coverage Check

| Spec Requirement | Task |
|-----------------|------|
| Preload + init providers during Phase 1 | Task 3 (whisper + router init start immediately, results buffered) |
| Race condition: services finish before Phase 1 | Task 3 (boot-ready handler flushes buffered state) |
| Sequential status display after Phase 1 | Task 3 (boot-ready handler) |
| Error handling: services fail gracefully | Task 3 (catch per provider, fallback sends) + Task 6 (6s timeout) |
| Status messages bottom-left, replacing, animated dots | Task 4 (HTML) + Task 6 (showStatus) |
| Router-ready triggers orb reveal | Task 6 (boot-reveal phase) |
| Chat bubble "Willkommen!" after reveal | Task 6 (boot-bubble phase) |
| Piper activation + status message | Task 3 (boot-ready handler) + Task 6 |
| Break 100-300ms before TTS | Task 6 (boot-break: break at t=0, TTS at t=200ms) |
| Break not clickable | Task 5 |
| TTS "Huch, jetzt bin ich einsatzbereit!" | Task 3 (splash-tts handler) + Task 6 |
| splashDone after TTS | Task 6 (done phase after ttsAudioResolve) |
| IPC: boot-status, boot-ready, BootStatus type | Task 1 + Task 2 |
