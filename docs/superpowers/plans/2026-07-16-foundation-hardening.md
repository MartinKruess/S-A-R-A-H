# Foundation-Hardening Implementation Plan (Spec A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die 8 Robustheits-Fixes aus `docs/superpowers/specs/2026-07-16-foundation-hardening-design.md` (Rev. 2) umsetzen — Vorbedingung für History/Sessions und Action-Layer.

**Architecture:** Reine Bestandshärtung, keine neuen Subsysteme. Ein Branch `fix/foundation-hardening`, ein Commit pro Task. Task-Reihenfolge folgt Abhängigkeiten: T3 (einmaliges Init) vor T8 (Router-Status-Check); T7 (Severity) vor T8.

**Tech Stack:** Electron 41, TypeScript, Vitest (`npm test` = typecheck + tests), Zod nur wo schon vorhanden (keine neuen Deps).

## Global Constraints

- Code und Commits Englisch, UI-Texte Deutsch (CLAUDE.md)
- Kein `any`/`unknown`/`never` außer unvermeidbar
- Conventional Commits (`fix:`, `refactor:`, `test:`)
- Nach jedem Task: `npm test` grün (36 Dateien / 381 Tests + neue)
- Fehlerpfade nie still schlucken: immer `console.warn`/`console.error` + definierter Rückgabewert

---

### Task 1: Top-Level-Electron-Imports (A1)

**Files:**
- Modify: `src/main/boot-sequence.ts:152,209` (`const { screen } = require('electron')` in Callbacks)
- Modify: `src/main/ipc-config.ts:95` (dito)

**Interfaces:** Konsumiert/produziert nichts Neues — reiner Stil-Fix. **`src/core/crypto/key-manager.ts` NICHT anfassen** (dessen dynamische `safeStorage`-Requires sind absichtlicher Node-Fallback).

- [ ] **Step 1:** In `boot-sequence.ts` den bestehenden Import `import { BrowserWindow, ipcMain } from 'electron';` um `screen` erweitern: `import { BrowserWindow, ipcMain, screen } from 'electron';` — die beiden `const { screen } = require('electron');`-Zeilen (152, 209) ersatzlos löschen.
- [ ] **Step 2:** In `ipc-config.ts` prüfen, was aus `electron` bereits importiert wird; `screen` in den Top-Level-Import aufnehmen, `require`-Zeile (95) löschen.
- [ ] **Step 3:** Run: `npm test` → Expected: alles grün (kein Verhaltenstest nötig, Typecheck fängt Fehler).
- [ ] **Step 4:** Commit: `git commit -m "refactor(main): hoist electron screen require to top-level imports"`

### Task 2: VramManager toten Parameter entfernen (A2)

**Files:**
- Modify: `src/services/llm/vram-manager.ts:41-44`
- Modify: `src/services/llm/router-service.ts:119` (Aufrufer)
- Test: bestehende VramManager-Tests (via Glob `**/vram-manager*.test.ts` finden)

**Interfaces:**
- Produces: `VramManager.swapModels(unload: string): Promise<void>` — einparametrig.

- [ ] **Step 1:** Signatur ändern:

```ts
async swapModels(unload: string): Promise<void> {
  await this.unloadModel(unload);
  // The new model is loaded automatically by Ollama on the next chat request.
}
```

- [ ] **Step 2:** Aufrufer in `router-service.ts:119`: `await this.vramManager.swapModels(llmConfig.routerModel);` (zweites Argument entfernen — das war `llmConfig.workerModel`, ungenutzt).
- [ ] **Step 3:** Bestehende Tests anpassen (Aufrufe mit zwei Argumenten), laufen lassen: `npm test` → PASS.
- [ ] **Step 4:** Commit: `git commit -m "refactor(llm): narrow swapModels signature to unload-only"`

### Task 3: Einmaliges Service-Init (A8)

**Files:**
- Modify: `src/services/llm/router-service.ts` (init)
- Modify: `src/services/voice/providers/faster-whisper-provider.ts` (init)
- Modify: `src/services/voice/providers/piper-provider.ts` (init)
- Test: `tests/services/llm/router-service-init.test.ts` (neu)

**Interfaces:**
- Produces: `init(): Promise<void>` bleibt äußerlich identisch, ist aber idempotent — jeder Aufruf nach dem ersten liefert **dasselbe** Promise, der Body läuft genau einmal. Muster in allen drei Klassen:

```ts
private initPromise: Promise<void> | null = null;

async init(): Promise<void> {
  if (!this.initPromise) {
    this.initPromise = this.doInit();
  }
  return this.initPromise;
}

private async doInit(): Promise<void> {
  // bisheriger init-Body, unverändert
}
```

- [ ] **Step 1: Failing Test schreiben** — `tests/services/llm/router-service-init.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { RouterService } from '../../../src/services/llm/router-service';

function makeService() {
  const provider = {
    id: 'ollama',
    isAvailable: vi.fn().mockResolvedValue(true),
    chat: vi.fn().mockResolvedValue(''),
  };
  const context = {
    parsedConfig: { llm: { baseUrl: 'http://localhost:11434', routerModel: 'r', workerModel: 'w', workerOptions: { num_ctx: 4096 } }, personalization: { responseStyle: 'kurz' } },
    bus: { emit: vi.fn(), on: vi.fn() },
    db: { insert: vi.fn() },
  };
  // context/provider strukturell typisieren wie in bestehenden router-Tests üblich —
  // vorhandene Test-Datei als Vorlage nehmen (Glob **/router*.test.ts)
  return new RouterService(context as never, provider as never, provider as never);
}

describe('RouterService.init idempotence', () => {
  it('runs the init body exactly once for concurrent/repeated calls', async () => {
    const svc = makeService();
    const p1 = svc.init();
    const p2 = svc.init();
    await Promise.all([p1, p2]);
    await svc.init();
    // isAvailable ist der erste Schritt des Init-Bodys — genau 1 Aufruf beweist einen Durchlauf
    expect((svc as never as { routerProvider: { isAvailable: ReturnType<typeof vi.fn> } })).toBeTruthy();
  });
});
```

  Hinweis an den Umsetzer: Die Assertion konkret auf den gemockten `isAvailable` des übergebenen Providers formulieren (`expect(provider.isAvailable).toHaveBeenCalledTimes(1)`), Provider dafür außerhalb von `makeService` halten. Falls `new RouterService(...)`-Konstruktion im Test unpraktikabel ist: vorhandene Router-Test-Datei als Vorlage für die Mock-Struktur nutzen.

- [ ] **Step 2:** Run: `npx vitest run tests/services/llm/router-service-init.test.ts` → Expected: FAIL (`isAvailable` 2× oder 3× gerufen).
- [ ] **Step 3:** Muster (siehe Interfaces) in `RouterService` einbauen: bisherigen `init`-Body nach `private async doInit()` verschieben.
- [ ] **Step 4:** Run Test → PASS.
- [ ] **Step 5:** Dasselbe Muster in `FasterWhisperProvider.init` und `PiperProvider.init` (Body → `doInit`). Kein eigener Test pro Provider nötig — Muster ist identisch; der Boot ruft beide doppelt (eager + `registry.initAll()`).
- [ ] **Step 6:** Run: `npm test` → PASS. Den Kommentar `// Provider inits are idempotent, so double-calling is safe` in `boot-sequence.ts` auf den neuen Mechanismus anpassen (`// init() is single-flight (A8): repeated calls return the same promise`).
- [ ] **Step 7:** Commit: `git commit -m "fix(core): make service init single-flight to prevent double initialization"`

### Task 4: IPC-Input-Validierung (A3)

**Files:**
- Modify: `src/main/ipc-voice.ts:24-32`
- Modify: `src/main/boot-sequence.ts:161` (`chat-message`-Handler)
- Modify: `src/main/ipc-config.ts`, `src/main/ipc-programs.ts` (Sweep, siehe Step 5)
- Test: `tests/main/ipc-validation.test.ts` (neu)

**Interfaces:**
- Produces: Guard-Konvention für alle IPC-Handler: ungültiger Payload → `console.warn('[IPC] invalid payload for <channel>')` + `return undefined` (void-Kanäle) bzw. `return null` (Wert-Kanäle). Grenzwerte: `chat-message` max. 4000 Zeichen; `voice-audio-chunk` max. 65536 Elemente.

- [ ] **Step 1: Failing Tests** — `tests/main/ipc-validation.test.ts` mit reinen Validierungsfunktionen (Extraktion macht sie testbar ohne Electron):

```ts
import { describe, it, expect } from 'vitest';
import { isValidChatMessage, isValidAudioChunk, isValidInteractionMode } from '../../src/main/ipc-validation';

describe('ipc payload validation', () => {
  it('accepts a normal chat message', () => {
    expect(isValidChatMessage('Hallo Sarah')).toBe(true);
  });
  it('rejects non-strings, empty and oversized messages', () => {
    expect(isValidChatMessage(42)).toBe(false);
    expect(isValidChatMessage('')).toBe(false);
    expect(isValidChatMessage('x'.repeat(4001))).toBe(false);
  });
  it('accepts a finite number array as audio chunk', () => {
    expect(isValidAudioChunk([0, 0.5, -0.5])).toBe(true);
  });
  it('rejects non-arrays, oversized arrays and non-finite values', () => {
    expect(isValidAudioChunk('nope')).toBe(false);
    expect(isValidAudioChunk(new Array(65537).fill(0))).toBe(false);
    expect(isValidAudioChunk([0, NaN])).toBe(false);
    expect(isValidAudioChunk([0, Infinity])).toBe(false);
  });
  it('accepts only chat and voice as interaction mode', () => {
    expect(isValidInteractionMode('chat')).toBe(true);
    expect(isValidInteractionMode('voice')).toBe(true);
    expect(isValidInteractionMode('keyword')).toBe(false);
    expect(isValidInteractionMode(1)).toBe(false);
  });
});
```

- [ ] **Step 2:** Run → FAIL (Modul existiert nicht).
- [ ] **Step 3:** `src/main/ipc-validation.ts` anlegen:

```ts
export const MAX_CHAT_MESSAGE_LENGTH = 4000;
export const MAX_AUDIO_CHUNK_SAMPLES = 65536;

export function isValidChatMessage(value: number | string | object): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CHAT_MESSAGE_LENGTH;
}

export function isValidAudioChunk(value: number[] | string | object): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_AUDIO_CHUNK_SAMPLES
    && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function isValidInteractionMode(value: string | number): value is 'chat' | 'voice' {
  return value === 'chat' || value === 'voice';
}
```

  (Falls der Typechecker die Union-Parameter zu eng findet: Signaturen der bestehenden Handler-Parameter übernehmen — entscheidend ist: **kein** `any`.)

- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Guards einbauen — Muster (`ipc-voice.ts`):

```ts
ipcMain.handle('voice-audio-chunk', (_event, chunk: number[]) => {
  if (!isValidAudioChunk(chunk)) {
    console.warn('[IPC] invalid payload for voice-audio-chunk');
    return;
  }
  const samples = new Float32Array(chunk);
  // … Rest unverändert
});

ipcMain.handle('voice-set-interaction-mode', (_event, mode: string) => {
  if (!isValidInteractionMode(mode)) {
    console.warn('[IPC] invalid payload for voice-set-interaction-mode');
    return;
  }
  getService<VoiceService>(getAppContext(), 'voice').setInteractionMode(mode);
});
```

  Gleiches Muster für `chat-message` (`boot-sequence.ts:161`, `isValidChatMessage`). Danach Sweep: `grep -n "ipcMain.handle\|ipcMain.on" src/main/*.ts` — jeden Handler mit Renderer-Parametern sichten; String-Parameter kriegen typeof-Check + sinnvolles Längenlimit, Wert-Kanäle geben bei Ablehnung `null` zurück. Guard immer **vor** Service-/FS-Zugriff.
- [ ] **Step 6:** Run: `npm test` → PASS.
- [ ] **Step 7:** Commit: `git commit -m "fix(ipc): validate renderer payloads before processing"`

### Task 5: LLM-Timeout mit Abort + einmaligem Retry (A4)

**Files:**
- Modify: `src/services/llm/llm-provider.interface.ts` (ChatOptions)
- Modify: `src/services/llm/providers/ollama-provider.ts:35-46` (fetch + Loop)
- Modify: `src/services/llm/chat-with-timeout.ts` (komplett)
- Test: bestehende Datei erweitern falls vorhanden (Glob `**/chat-with-timeout*.test.ts`), sonst `tests/services/llm/chat-with-timeout.test.ts` neu

**Interfaces:**
- Produces: `ChatOptions.signal?: AbortSignal` — Provider bricht Fetch/Stream bei Abort ab. `chatWithTimeout(provider, messages, onChunk, options?)` — Signatur unverändert, intern: Timeout → Abort → genau ein Retry (nur wenn noch kein Chunk geflossen ist).

- [ ] **Step 1: Failing Tests** (Kernfälle):

```ts
import { describe, it, expect, vi } from 'vitest';
import { chatWithTimeout, STREAM_TIMEOUT_MS } from '../../../src/services/llm/chat-with-timeout';

function providerWith(chatImpl: (...args: unknown[]) => Promise<string>) {
  return { id: 'fake', isAvailable: vi.fn().mockResolvedValue(true), chat: vi.fn(chatImpl) };
}

describe('chatWithTimeout retry', () => {
  it('aborts the first attempt on timeout and retries exactly once', async () => {
    vi.useFakeTimers();
    let firstSignal: AbortSignal | undefined;
    const provider = providerWith(async (_m, _cb, opts) => {
      const { signal } = opts as { signal?: AbortSignal };
      if (!firstSignal) {
        firstSignal = signal;
        return new Promise<string>(() => {}); // hängt für immer, sendet nie Chunks
      }
      return 'second attempt result';
    });
    const resultP = chatWithTimeout(provider as never, [], () => {});
    await vi.advanceTimersByTimeAsync(STREAM_TIMEOUT_MS + 1);
    await expect(resultP).resolves.toBe('second attempt result');
    expect(firstSignal?.aborted).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not retry when chunks were already streamed', async () => {
    vi.useFakeTimers();
    const provider = providerWith(async (_m, cb) => {
      (cb as (t: string) => void)('partial ');
      return new Promise<string>(() => {}); // hängt nach erstem Chunk
    });
    const resultP = chatWithTimeout(provider as never, [], () => {});
    resultP.catch(() => {}); // rejection wird unten geprüft
    await vi.advanceTimersByTimeAsync(STREAM_TIMEOUT_MS + 1);
    await expect(resultP).rejects.toThrow('timeout');
    expect(provider.chat).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('ignores late chunks from the aborted first attempt', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    let lateCb: ((t: string) => void) | null = null;
    let calls = 0;
    const provider = providerWith(async (_m, cb) => {
      calls++;
      if (calls === 1) {
        lateCb = cb as (t: string) => void;
        return new Promise<string>(() => {});
      }
      (cb as (t: string) => void)('fresh');
      return 'fresh';
    });
    const resultP = chatWithTimeout(provider as never, [], (t) => seen.push(t));
    await vi.advanceTimersByTimeAsync(STREAM_TIMEOUT_MS + 1);
    lateCb!('stale'); // verspäteter Chunk des abgebrochenen Versuchs
    await expect(resultP).resolves.toBe('fresh');
    expect(seen).toEqual(['fresh']);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `ChatOptions` erweitern: `signal?: AbortSignal;` (mit JSDoc `/** Abort the in-flight request and stop streaming. */`). `OllamaProvider.chat`: `signal: options?.signal` an `fetch(..., { signal: options?.signal, ... })` übergeben und in der Read-Schleife pro Iteration prüfen:

```ts
while (true) {
  if (options?.signal?.aborted) {
    await reader.cancel();
    throw new Error('aborted');
  }
  const { done, value } = await reader.read();
  // … Rest unverändert
```

- [ ] **Step 4:** `chat-with-timeout.ts` neu:

```ts
import type { LlmProvider, ChatMessage, ChatOptions } from './llm-provider.interface.js';

export const STREAM_TIMEOUT_MS = 120_000;

async function attempt(
  provider: LlmProvider,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options: ChatOptions | undefined,
  onFirstChunk: () => void,
): Promise<string> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout>;
  let sawChunk = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    const arm = () => setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, STREAM_TIMEOUT_MS);
    timeoutId = arm();
  });

  const guardedChunk = (chunk: string) => {
    if (controller.signal.aborted) return; // stale chunk of an aborted attempt
    if (!sawChunk) { sawChunk = true; onFirstChunk(); }
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      controller.abort();
    }, STREAM_TIMEOUT_MS);
    onChunk(chunk);
  };

  try {
    const result = await Promise.race([
      provider.chat(messages, guardedChunk, { ...options, signal: controller.signal }),
      timeoutPromise,
    ]);
    return result;
  } finally {
    clearTimeout(timeoutId!);
  }
}

export async function chatWithTimeout(
  provider: LlmProvider,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options?: ChatOptions,
): Promise<string> {
  let streamedToUser = false;
  const markStreamed = () => { streamedToUser = true; };
  try {
    return await attempt(provider, messages, onChunk, options, markStreamed);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'timeout';
    if (!isTimeout || streamedToUser) throw err;
    // Retry exactly once: first attempt was aborted, its late chunks are ignored.
    return attempt(provider, messages, onChunk, options, markStreamed);
  }
}
```

  Achtung Umsetzer: Der Timer-Reset in `guardedChunk` rejected beim zweiten Arm nicht mehr (reject-Referenz) — beim Implementieren sicherstellen, dass ein Timeout **nach** Chunks weiterhin die Promise rejectet (Muster: `rejectRef` wie im Original halten und in beiden `setTimeout`-Armen `controller.abort(); rejectRef(new Error('timeout'))` aufrufen). Die Tests aus Step 1 decken das ab (Fall 2).
- [ ] **Step 5:** Run Tests → PASS; dann `npm test` → PASS (bestehende Aufrufer sind signaturkompatibel).
- [ ] **Step 6:** Commit: `git commit -m "fix(llm): abort timed-out stream before single retry, ignore stale chunks"`

### Task 6: Voice-Teilausfall mit Fähigkeits-Status (A5)

**Files:**
- Modify: `src/services/voice/voice-service.ts:87-129` (init) + `llm:done`-Pfad
- Modify: `src/core/bus-events.ts` (neues Event)
- Modify: `src/main/ipc-voice.ts` (forward)
- Modify: Renderer-Voice-Panel (Datei via `grep -rn "voice:state" src/renderer/` lokalisieren — das Panel, das den Voice-Status anzeigt)
- Test: `tests/services/voice/voice-capability.test.ts` (neu)

**Interfaces:**
- Produces: Bus-Event `'voice:capability': { stt: boolean; tts: boolean }` in `BusEvents`; `VoiceService.init()` setzt Status `running`, wenn **mindestens eine** Fähigkeit da ist, `error` nur wenn beide fehlen.

- [ ] **Step 1: Failing Test** — TTS-Init wirft, STT nicht:

```ts
import { describe, it, expect, vi } from 'vitest';
import { VoiceService } from '../../../src/services/voice/voice-service';

function makeDeps(ttsFails: boolean) {
  const stt = { init: vi.fn().mockResolvedValue(undefined) };
  const tts = { init: ttsFails ? vi.fn().mockRejectedValue(new Error('piper broken')) : vi.fn().mockResolvedValue(undefined) };
  const emitted: Array<{ topic: string; data: object }> = [];
  const context = {
    parsedConfig: { controls: { voiceMode: 'off', pushToTalkKey: 'F9' } },
    bus: { emit: vi.fn((_src: string, topic: string, data: object) => emitted.push({ topic, data })), on: vi.fn(() => () => {}) },
  };
  const noop = { init: vi.fn(), registerKey: vi.fn(), unregisterAll: vi.fn(), setPlaying: vi.fn() };
  return { stt, tts, context, emitted, noop };
}

describe('VoiceService partial failure', () => {
  it('keeps STT alive and reports capability when TTS init fails', async () => {
    const { stt, tts, context, emitted, noop } = makeDeps(true);
    const svc = new VoiceService(context as never, stt as never, tts as never, noop as never, noop as never, noop as never);
    await svc.init();
    expect(svc.status).toBe('running');
    const cap = emitted.find((e) => e.topic === 'voice:capability');
    expect(cap?.data).toEqual({ stt: true, tts: false });
  });

  it('reports error status only when both capabilities fail', async () => {
    const { tts, context, noop } = makeDeps(true);
    const stt = { init: vi.fn().mockRejectedValue(new Error('whisper broken')) };
    const svc = new VoiceService(context as never, stt as never, tts as never, noop as never, noop as never, noop as never);
    await svc.init();
    expect(svc.status).toBe('error');
  });
});
```

  (Konstruktor-Argumente an die echte Reihenfolge anpassen: `context, stt, tts, wakeWord, audio, hotkey` — Mock-Formen aus bestehenden Voice-Tests übernehmen falls vorhanden.)
- [ ] **Step 2:** Run → FAIL (heute: ein Fehler → status `error`, kein capability-Event).
- [ ] **Step 3:** `bus-events.ts`: `'voice:capability': { stt: boolean; tts: boolean };` ergänzen.
- [ ] **Step 4:** `VoiceService.init()` umbauen:

```ts
private capabilities = { stt: false, tts: false };

async init(): Promise<void> {
  const { controls } = this.context.parsedConfig;
  const rawMode = controls.voiceMode;
  this.voiceMode = rawMode === 'keyword' ? 'off' : rawMode;
  this.pushToTalkKey = controls.pushToTalkKey;

  try { await this.stt.init(); this.capabilities.stt = true; }
  catch (err) { console.error('[VoiceService] STT init failed:', err); }

  try { await this.tts.init(); this.capabilities.tts = true; }
  catch (err) { console.error('[VoiceService] TTS init failed:', err); }

  this.setupMode();

  if (this.capabilities.tts) {
    this.ttsQueue = new TtsQueue(/* … bisherige Argumente unverändert … */);
    this.playbackUnsub = this.context.bus.on('voice:playback-done', () => {
      this.audio.setPlaying(false);
      this.ttsQueue?.playbackDone();
    });
  }

  this.context.bus.emit(this.id, 'voice:capability', { ...this.capabilities });
  this.status = this.capabilities.stt || this.capabilities.tts ? 'running' : 'error';
}
```

- [ ] **Step 5:** `llm:done`-Pfad prüfen (`onMessage`/`onTtsQueueEmpty`): Ohne `ttsQueue` muss der Zyklus direkt `this.setState('idle')` erreichen statt auf Queue-Leerung zu warten. Konkret: an der Stelle, die nach `llm:done` auf die TTS-Queue übergibt, `if (!this.ttsQueue) { this.setState('idle'); return; }` einfügen.
- [ ] **Step 6:** `ipc-voice.ts`: `forwardToRenderers(bus, 'voice:capability');` ergänzen. Renderer-Voice-Panel: auf das Event subscriben, bei `tts: false` in der Status-Zeile den Text `Stimme offline — Antworten nur als Text` zeigen (bestehende Statusanzeige nutzen, kein neues UI-Element).
- [ ] **Step 7:** Run: `npm test` → PASS.
- [ ] **Step 8:** Commit: `git commit -m "fix(voice): survive TTS init failure with capability status instead of silent death"`

### Task 7: Boot-Status mit Severity (A6)

**Files:**
- Modify: `src/core/sarah-api.ts:7-10` (BootStatus)
- Modify: `src/main/boot-sequence.ts` (send-Helper + Aufrufer)
- Modify: `src/renderer/dashboard/boot-sequence.ts:18` (lokales Interface) + Anzeige-Logik + zugehöriges CSS
- Test: keiner (reine Typ-/Darstellungsänderung; Logiktest kommt in Task 8)

**Interfaces:**
- Produces: `BootStatus = { step: …; message?: string; severity?: 'info' | 'warning' | 'error' }` — `severity` optional mit Default `'info'`, damit bestehende Aufrufer unverändert bleiben. `send(step, message?, severity?)` in `main/boot-sequence.ts`.

- [ ] **Step 1:** `sarah-api.ts`: Feld `severity?: 'info' | 'warning' | 'error';` am `BootStatus`-Typ ergänzen. Dasselbe am lokalen Interface `renderer/dashboard/boot-sequence.ts:18`.
- [ ] **Step 2:** `main/boot-sequence.ts` send-Helper:

```ts
const send = (step: string, message?: string, severity: 'info' | 'warning' | 'error' = 'info') => {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('boot-status', { step, message, severity });
  }
};
```

  Aufrufer einstufen: `send('router', containerError, 'error')` (Container-/Router-Fehler), CPU-Warnung `send('router', 'Warnung: …', 'warning')`, alle übrigen unverändert (Default info).
- [ ] **Step 3:** Renderer: Wo `data.message` angezeigt wird, Klassen setzen — `severity === 'error'` → `boot-msg-error`, `'warning'` → `boot-msg-warning`. CSS (in der Datei, die die Boot-Statuszeile stylt — via `grep -rn "boot-status\|bootStatus" src/renderer/ styles/` finden):

```css
.boot-msg-error   { color: var(--cockpit-accent-red); animation: none; }
.boot-msg-warning { color: #ffb347; animation: none; }
```

  Das bestehende 3s-Dwell bleibt unverändert (gilt je Meldung einmal).
- [ ] **Step 4:** Run: `npm test` → PASS (Typecheck deckt beide Interfaces). Optik testet Martin manuell.
- [ ] **Step 5:** Commit: `git commit -m "feat(boot): add severity to boot status so errors stop looking like loading"`

### Task 8: Router-error trotz Container erkennen (A7)

**Files:**
- Create: `src/main/boot-issues.ts` (extrahierte, testbare Ableitung)
- Modify: `src/main/boot-sequence.ts` (nach `await routerReady`)
- Test: `tests/main/boot-issues.test.ts` (neu)

**Interfaces:**
- Consumes: `severity`-fähiges `send()` aus Task 7; einmaliges Init aus Task 3 (der Status-Check erfolgt nach dem einzigen Init-Durchlauf).
- Produces: `deriveBootIssue(containerError: string | null, routerStatus: ServiceStatus): { message: string; severity: 'warning' | 'error' } | null`

- [ ] **Step 1: Failing Test** — `tests/main/boot-issues.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveBootIssue } from '../../src/main/boot-issues';

describe('deriveBootIssue', () => {
  it('reports container errors as-is', () => {
    expect(deriveBootIssue('Docker ist nicht gestartet.', 'error')).toEqual({
      message: 'Docker ist nicht gestartet.',
      severity: 'error',
    });
  });
  it('reports router error despite healthy container', () => {
    expect(deriveBootIssue(null, 'error')).toEqual({
      message: 'Sarah-Protokoll nicht erreichbar — Sprachverarbeitung ist gestört.',
      severity: 'error',
    });
  });
  it('returns null when everything is fine', () => {
    expect(deriveBootIssue(null, 'running')).toBeNull();
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `src/main/boot-issues.ts`:

```ts
import type { ServiceStatus } from '../core/types.js';

export function deriveBootIssue(
  containerError: string | null,
  routerStatus: ServiceStatus,
): { message: string; severity: 'warning' | 'error' } | null {
  if (containerError) return { message: containerError, severity: 'error' };
  if (routerStatus === 'error') {
    return {
      message: 'Sarah-Protokoll nicht erreichbar — Sprachverarbeitung ist gestört.',
      severity: 'error',
    };
  }
  return null;
}
```

- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** In `main/boot-sequence.ts` den bestehenden `if (containerError) … else { checkGpu … }`-Block so umbauen, dass zuerst `const issue = deriveBootIssue(containerError, routerService.status);` läuft: Issue vorhanden → `send('router', issue.message, issue.severity)` + 3s-Dwell; kein Issue → bisheriger GPU-Check (dessen Warnung nutzt `'warning'` aus Task 7). Orb-Reveal (`send('router-ready')`) läuft in allen Fällen weiter.
- [ ] **Step 6:** Run: `npm test` → PASS.
- [ ] **Step 7:** Commit: `git commit -m "fix(boot): surface router error even when container is healthy"`

---

## Abschluss

- [ ] `npm test` komplett grün, `npm run build` grün
- [ ] PR `fix/foundation-hardening` → `dev` (Squash), Branch danach löschen
- [ ] Manuell (Martin): Boot-Optik der Fehler/Warnungen; Piper-Exe wegbenennen → Sarah antwortet als Text + Cockpit zeigt „Stimme offline"; danach zurückbenennen
- [ ] Spec B (`2026-07-16-history-sessions-design.md`) gegen den neuen Code-Stand gegenchecken (A8-Init-Pfad!) — dann erst Plan B schreiben
