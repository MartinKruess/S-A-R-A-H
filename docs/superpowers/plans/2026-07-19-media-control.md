# Generische Mediensteuerung (Schicht 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sarah steuert die aktive Windows-Mediensitzung (Play/Pause/Toggle/Next/Previous) über generische `media_*`-Actions — playerübergreifend (Spotify, Browser/YouTube, VLC, …), ohne OAuth/Premium.

**Architecture:** Router → `media_*`-Action (mit optionalem Target) → `ActionService` → `MediaController`-Interface (plattformneutraler Vertrag) → `WindowsMediaController` startet einen kleinen self-contained C#-Helper (`media-helper.exe`), der Windows GSMTC (`Windows.Media.Control`) fährt und über JSON auf stdin/stdout kommuniziert. Der C#-Executor ist Backend Nr. 1; spätere Plattformen (Linux/MPRIS, Mobil) implementieren denselben JSON-Vertrag.

**Tech Stack:** TypeScript (Electron main), Node `child_process`, Zod, Vitest; C# / .NET 8 (`net8.0-windows10.0.19041.0`, WinRT-Projektion).

## Global Constraints

- **Plattform:** Ausführung nur `win32`. Auf anderen Plattformen liefert `WindowsMediaController` `{ ok: false, speak: 'Das unterstützt dein System nicht.' }` (wie `SystemActions`).
- **Sprache:** Code, Kommentare, Commits auf Englisch; nutzer­sichtbare `speak`-Texte auf Deutsch.
- **TypeScript:** kein `any`/`unknown`/`never`, außer unvermeidbar.
- **`resources/` ist gitignored:** C#-Source unter `native/media-helper/` committen; gebaute `.exe` in `resources/media-helper/` ist lokales Artefakt (analog Piper, nicht committet).
- **Voraussetzung Task 6:** .NET 8 SDK installiert (`dotnet` im PATH). Tasks 1–5 brauchen kein dotnet.
- **Helper-JSON-Vertrag (verbindlich für Task 2 und Task 6 identisch):**
  - Request (eine JSON-Zeile auf **stdin**): `{ "action": "media_play"|"media_pause"|"media_toggle"|"media_next"|"media_previous", "target": "<string, '' = aktive Sitzung>" }`
  - Response Erfolg (eine JSON-Zeile auf **stdout**): `{ "success": true, "app": "<sourceAppId|media-key>", "status": "<playing|paused|unknown>" }`
  - Response Fehler: `{ "success": false, "error": "NO_MEDIA_SESSION"|"NO_MATCHING_SESSION"|"ACTION_NOT_SUPPORTED"|"ACTION_FAILED" }`
- **Action→German speak-Mapping (Task 2):** `NO_MEDIA_SESSION`→„Ich sehe gerade keine laufende Wiedergabe.", `NO_MATCHING_SESSION`→„Ich finde gerade keine passende Wiedergabe.", `ACTION_NOT_SUPPORTED`→„Das kann der aktuelle Player nicht.", sonst/Fehler/Timeout→„Das hat gerade nicht geklappt."

---

## File Structure

- `src/services/actions/action-schemas.ts` (modify) — 5 `media_*`-Schemas + Gate-Stämme `'pausier'`,`'skip'`.
- `src/services/actions/media-controller.ts` (create) — `MediaResult`, `MediaAction`, `MediaController`-Interface, `HelperRunner`, `WindowsMediaController`.
- `src/services/actions/media-controller.test.ts` (create) — Controller-Tests mit injiziertem Runner.
- `src/services/actions/action-service.ts` (modify) — `media` in `ActionDeps` + 5 `case`.
- `src/services/actions/action-service.test.ts` (modify) — `makeMedia()` + Dispatch-Tests.
- `src/services/actions/action-schemas.test.ts` (modify) — Schema-/Gate-Tests.
- `src/services/llm/routing-prompt.ts` (modify) — 5 `media_*`-Zeilen + Beispiele.
- `src/services/llm/routing-prompt.test.ts` (create) — Containment-Test.
- `src/main.ts` (modify) — `WindowsMediaController` bauen und in `ActionDeps.media` reichen.
- `native/media-helper/media-helper.csproj` (create) — .NET-Projekt.
- `native/media-helper/Program.cs` (create) — GSMTC-Helper.
- `problems/features.md` (modify) — Roadmap auf Zwei-Schichten-Modell aktualisieren.

---

### Task 1: `media_*` action schemas + gate stems

**Files:**
- Modify: `src/services/actions/action-schemas.ts`
- Test: `src/services/actions/action-schemas.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `ACTION_SCHEMAS.media_play|media_pause|media_toggle|media_next|media_previous` (jeweils `z.string().max(40)`); `isActionName` erkennt sie; `ACTION_HINT_STEMS` enthält `'pausier'`,`'skip'`.

- [ ] **Step 1: Write the failing test** — in `action-schemas.test.ts`, im `describe('ACTION_SCHEMAS boundaries', …)` ergänzen:

```ts
it('media_* accept empty target and short program names, reject overlong', () => {
  for (const name of ['media_play', 'media_pause', 'media_toggle', 'media_next', 'media_previous'] as const) {
    expect(ACTION_SCHEMAS[name].safeParse('').success).toBe(true);
    expect(ACTION_SCHEMAS[name].safeParse('spotify').success).toBe(true);
    expect(ACTION_SCHEMAS[name].safeParse('x'.repeat(41)).success).toBe(false);
  }
});

it('isActionName knows the five media_* names', () => {
  expect(isActionName('media_play')).toBe(true);
  expect(isActionName('media_previous')).toBe(true);
});
```

Und im `describe('looksLikeActionCommand …')` ergänzen:

```ts
it('matches media transport hint words', () => {
  expect(looksLikeActionCommand('Pausiere die Musik')).toBe(true);
  expect(looksLikeActionCommand('Skip mal')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/actions/action-schemas.test.ts`
Expected: FAIL — `ACTION_SCHEMAS.media_play` is undefined / gate returns false for "Skip mal".

- [ ] **Step 3: Write minimal implementation** — in `action-schemas.ts`, in `ACTION_SCHEMAS` nach der `spotify_*`-Gruppe einfügen:

```ts
  // Generic media transport (Schicht 1). Param = optional target: '' = active session,
  // else a program name substring ("spotify", "chrome") to pick that session.
  media_play: z.string().max(40),
  media_pause: z.string().max(40),
  media_toggle: z.string().max(40),
  media_next: z.string().max(40),
  media_previous: z.string().max(40),
```

Und `ACTION_HINT_STEMS` erweitern (`'skip'` = geläufiger Anglizismus fürs Weiterspringen, kein häufiges Alltagswort):

```ts
export const ACTION_HINT_STEMS: readonly string[] = [
  'öffn', 'start', 'such', 'google', 'zeig',
  'timer', 'wecker',
  'lautstärke', 'lauter', 'leiser',
  'spotify', 'musik', 'pausier', 'skip',
  'sperr', 'bildschirm',
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/actions/action-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/actions/action-schemas.ts src/services/actions/action-schemas.test.ts
git commit -m "feat(actions): media_* schemas and transport gate stems"
```

---

### Task 2: `MediaController` interface + `WindowsMediaController`

**Files:**
- Create: `src/services/actions/media-controller.ts`
- Test: `src/services/actions/media-controller.test.ts`

**Interfaces:**
- Consumes: der Helper-JSON-Vertrag (Global Constraints).
- Produces:
  - `interface MediaResult { ok: boolean; speak?: string; }`
  - `type MediaAction = 'media_play'|'media_pause'|'media_toggle'|'media_next'|'media_previous'`
  - `interface MediaController { play(target: string): Promise<MediaResult>; pause(target: string): Promise<MediaResult>; toggle(target: string): Promise<MediaResult>; next(target: string): Promise<MediaResult>; previous(target: string): Promise<MediaResult>; }`
  - `type HelperRunner = (requestJson: string) => Promise<string>`
  - `class WindowsMediaController implements MediaController` mit Konstruktor `(helperPath: string, opts?: { run?: HelperRunner; platform?: string })`.

- [ ] **Step 1: Write the failing test** — `media-controller.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { WindowsMediaController, type HelperRunner } from './media-controller.js';

function controller(over: { run?: HelperRunner; platform?: string } = {}) {
  return new WindowsMediaController('C:/fake/media-helper.exe', {
    run: over.run ?? (async () => JSON.stringify({ success: true, app: 'Spotify.exe', status: 'paused' })),
    platform: over.platform ?? 'win32',
  });
}

describe('WindowsMediaController', () => {
  it('sends the correct action + target to the helper', async () => {
    const run = vi.fn<HelperRunner>().mockResolvedValue(JSON.stringify({ success: true, app: 'x', status: 'playing' }));
    const c = controller({ run });
    await c.pause('spotify');
    expect(JSON.parse(run.mock.calls[0][0])).toEqual({ action: 'media_pause', target: 'spotify' });
  });

  it('active session: empty target is passed through', async () => {
    const run = vi.fn<HelperRunner>().mockResolvedValue(JSON.stringify({ success: true, app: 'x', status: 'playing' }));
    await controller({ run }).next('');
    expect(JSON.parse(run.mock.calls[0][0])).toEqual({ action: 'media_next', target: '' });
  });

  it('success → silent ok', async () => {
    expect(await controller().play('')).toEqual({ ok: true });
  });

  it('maps each error code to an honest German speak', async () => {
    const cases: Array<[string, string]> = [
      ['NO_MEDIA_SESSION', 'Ich sehe gerade keine laufende Wiedergabe.'],
      ['NO_MATCHING_SESSION', 'Ich finde gerade keine passende Wiedergabe.'],
      ['ACTION_NOT_SUPPORTED', 'Das kann der aktuelle Player nicht.'],
      ['ACTION_FAILED', 'Das hat gerade nicht geklappt.'],
    ];
    for (const [error, speak] of cases) {
      const c = controller({ run: async () => JSON.stringify({ success: false, error }) });
      expect(await c.pause('')).toEqual({ ok: false, speak });
    }
  });

  it('unparseable helper output → generic speak', async () => {
    const c = controller({ run: async () => 'not json' });
    expect(await c.pause('')).toEqual({ ok: false, speak: 'Das hat gerade nicht geklappt.' });
  });

  it('runner throw (timeout/crash) → generic speak, does not reject', async () => {
    const c = controller({ run: async () => { throw new Error('media-helper timeout'); } });
    expect(await c.next('')).toEqual({ ok: false, speak: 'Das hat gerade nicht geklappt.' });
  });

  it('non-win32 → unsupported, never runs the helper', async () => {
    const run = vi.fn<HelperRunner>();
    const c = controller({ run, platform: 'linux' });
    expect(await c.pause('')).toEqual({ ok: false, speak: 'Das unterstützt dein System nicht.' });
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/actions/media-controller.test.ts`
Expected: FAIL — cannot find `./media-controller.js`.

- [ ] **Step 3: Write minimal implementation** — `media-controller.ts`:

```ts
// src/services/actions/media-controller.ts
// Schicht 1 (generic media transport). Platform-neutral MediaController contract;
// WindowsMediaController drives GSMTC via a small self-contained C# helper spoken to
// over JSON stdin/stdout. `run` is injectable for tests.
import { spawn } from 'child_process';

export interface MediaResult {
  ok: boolean;
  speak?: string;
}

export type MediaAction =
  | 'media_play'
  | 'media_pause'
  | 'media_toggle'
  | 'media_next'
  | 'media_previous';

export interface MediaController {
  play(target: string): Promise<MediaResult>;
  pause(target: string): Promise<MediaResult>;
  toggle(target: string): Promise<MediaResult>;
  next(target: string): Promise<MediaResult>;
  previous(target: string): Promise<MediaResult>;
}

/** Runs the helper: writes requestJson to stdin, resolves with the stdout JSON line. */
export type HelperRunner = (requestJson: string) => Promise<string>;

const UNSUPPORTED: MediaResult = { ok: false, speak: 'Das unterstützt dein System nicht.' };
const GENERIC: MediaResult = { ok: false, speak: 'Das hat gerade nicht geklappt.' };
const HELPER_TIMEOUT_MS = 4000;

interface HelperResponse {
  success?: boolean;
  error?: string;
}

export class WindowsMediaController implements MediaController {
  private run: HelperRunner;
  private platform: string;

  constructor(
    private helperPath: string,
    opts: { run?: HelperRunner; platform?: string } = {},
  ) {
    this.platform = opts.platform ?? process.platform;
    this.run = opts.run ?? ((json) => this.defaultRun(json));
  }

  play(target: string): Promise<MediaResult> { return this.send('media_play', target); }
  pause(target: string): Promise<MediaResult> { return this.send('media_pause', target); }
  toggle(target: string): Promise<MediaResult> { return this.send('media_toggle', target); }
  next(target: string): Promise<MediaResult> { return this.send('media_next', target); }
  previous(target: string): Promise<MediaResult> { return this.send('media_previous', target); }

  private async send(action: MediaAction, target: string): Promise<MediaResult> {
    if (this.platform !== 'win32') return UNSUPPORTED;
    let stdout: string;
    try {
      stdout = await this.run(JSON.stringify({ action, target }));
    } catch (err) {
      console.warn('[MediaController] helper exec failed:', action, (err as Error).message);
      return GENERIC;
    }
    return this.mapResponse(stdout);
  }

  private mapResponse(stdout: string): MediaResult {
    let res: HelperResponse;
    try {
      res = JSON.parse(stdout) as HelperResponse;
    } catch {
      console.warn('[MediaController] bad helper output:', stdout.slice(0, 200));
      return GENERIC;
    }
    if (res.success === true) return { ok: true };
    switch (res.error) {
      case 'NO_MEDIA_SESSION': return { ok: false, speak: 'Ich sehe gerade keine laufende Wiedergabe.' };
      case 'NO_MATCHING_SESSION': return { ok: false, speak: 'Ich finde gerade keine passende Wiedergabe.' };
      case 'ACTION_NOT_SUPPORTED': return { ok: false, speak: 'Das kann der aktuelle Player nicht.' };
      default: return GENERIC;
    }
  }

  /** Spawns the helper, feeds requestJson on stdin, resolves stdout; kills on timeout. */
  private defaultRun(requestJson: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.helperPath, [], { windowsHide: true });
      let out = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('media-helper timeout'));
      }, HELPER_TIMEOUT_MS);

      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(out.trim());
      });

      child.stdin?.write(`${requestJson}\n`);
      child.stdin?.end();
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/actions/media-controller.test.ts`
Expected: PASS (alle Fälle).

- [ ] **Step 5: Commit**

```bash
git add src/services/actions/media-controller.ts src/services/actions/media-controller.test.ts
git commit -m "feat(actions): MediaController contract + WindowsMediaController (helper via JSON stdio)"
```

---

### Task 3: Wire `media` into `ActionService`

**Files:**
- Modify: `src/services/actions/action-service.ts`
- Test: `src/services/actions/action-service.test.ts`

**Interfaces:**
- Consumes: `MediaController` (Task 2), `ACTION_SCHEMAS.media_*` (Task 1).
- Produces: `ActionDeps.media: MediaController`; Dispatch für die fünf `media_*`.

- [ ] **Step 1: Write the failing test** — in `action-service.test.ts`:

Import ergänzen:
```ts
import type { MediaController } from './media-controller.js';
```

`makeMedia()` neben `makeSpotify()` hinzufügen:
```ts
function makeMedia(): MediaController {
  return {
    play: vi.fn().mockResolvedValue({ ok: true }),
    pause: vi.fn().mockResolvedValue({ ok: true }),
    toggle: vi.fn().mockResolvedValue({ ok: true }),
    next: vi.fn().mockResolvedValue({ ok: true }),
    previous: vi.fn().mockResolvedValue({ ok: true }),
  };
}
```

`makeService`-Signatur um `media?: MediaController` erweitern, in den `deps` mitgeben und zurückgeben. Die Zeilen anpassen:
```ts
function makeService(over: {
  launcher?: Partial<ProgramLauncher>;
  search?: Parameters<typeof makeSearch>[0];
  spotify?: SpotifyActions;
  media?: MediaController;
} = {}): { bus: MessageBus; results: BusEvents['action:result'][]; service: ActionService; spotify: SpotifyActions; media: MediaController } {
```
und im Body:
```ts
  const media = over.media ?? makeMedia();
  const service = new ActionService(bus, { launcher, getPrograms: () => [], search, system, spotify, media });
```
```ts
  return { bus, results, service, spotify, media };
```

Neuer Test:
```ts
it('media_next dispatches to MediaController.next with the target param', async () => {
  const media = makeMedia();
  const { bus, results, service } = makeService({ media });
  await service.init();
  await request(bus, 'media_next', '');
  expect(media.next).toHaveBeenCalledWith('');
  expect(results[0]).toEqual({ requestId: 'rid-1', action: 'media_next', ok: true });
});

it('media_pause passes a named target through to the controller', async () => {
  const media = makeMedia();
  const { bus, service } = makeService({ media });
  await service.init();
  await request(bus, 'media_pause', 'spotify');
  expect(media.pause).toHaveBeenCalledWith('spotify');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/actions/action-service.test.ts`
Expected: FAIL — `media` fehlt in `ActionDeps` / dispatch kennt `media_next` nicht.

- [ ] **Step 3: Write minimal implementation** — in `action-service.ts`:

Import:
```ts
import type { MediaController } from './media-controller.js';
```
`ActionDeps` erweitern:
```ts
export interface ActionDeps {
  launcher: ProgramLauncher;
  getPrograms: () => ProgramEntry[];
  search: SearchLike;
  system: SystemActions;
  spotify: SpotifyActions;
  media: MediaController;
}
```
Im `switch (action)` nach dem `spotify_volume_adjust`-Case einfügen:
```ts
      case 'media_play':
        return this.deps.media.play(parsed.data as string);
      case 'media_pause':
        return this.deps.media.pause(parsed.data as string);
      case 'media_toggle':
        return this.deps.media.toggle(parsed.data as string);
      case 'media_next':
        return this.deps.media.next(parsed.data as string);
      case 'media_previous':
        return this.deps.media.previous(parsed.data as string);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/actions/action-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/actions/action-service.ts src/services/actions/action-service.test.ts
git commit -m "feat(actions): dispatch media_* to MediaController"
```

---

### Task 4: Router prompt teaches `media_*`

**Files:**
- Modify: `src/services/llm/routing-prompt.ts`
- Test: `src/services/llm/routing-prompt.test.ts` (create)

**Interfaces:**
- Consumes: nichts.
- Produces: `buildRoutingPrompt()` enthält die fünf `media_*`-Kommandos + Beispiele.

- [ ] **Step 1: Write the failing test** — `routing-prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRoutingPrompt } from './routing-prompt.js';

describe('buildRoutingPrompt media_* coverage', () => {
  const prompt = buildRoutingPrompt();
  it('lists all five media transport actions', () => {
    for (const a of ['media_play', 'media_pause', 'media_toggle', 'media_next', 'media_previous']) {
      expect(prompt).toContain(a);
    }
  });
  it('shows an active-session example (empty target) and a named-target example', () => {
    expect(prompt).toContain('[ACTION:media_pause:]');
    expect(prompt).toContain('[ACTION:media_pause:spotify]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/llm/routing-prompt.test.ts`
Expected: FAIL — prompt enthält die Strings nicht.

- [ ] **Step 3: Write minimal implementation** — in `routing-prompt.ts` die Command-Liste (STEP 1) nach der `spotify_volume_adjust`-Zeile ergänzen:

```
- media_pause:<empty|program> — pause playback. Empty = whatever is currently playing ("Pause", "Mach die Musik aus", "Halt an")
- media_play:<empty|program> — resume playback ("Weiter", "Play", "Mach weiter")
- media_toggle:<empty|program> — toggle play/pause ("Mach die Musik an")
- media_next:<empty|program> — next track ("Nächstes Lied", "Skip")
- media_previous:<empty|program> — previous track ("Zurück", "Eins zurück")
- Transport ("Pause"/"weiter"/"nächstes Lied") is ALWAYS media_* (never spotify_*). A named program is the target: "Pausiere Spotify" → media_pause:spotify. "Schließe Spotify" stays open_program/close, NOT media.
```

Im EXAMPLES-Block ergänzen:

```
User: "Pause" → [ACTION:media_pause:] Ich pausiere.
User: "Mach weiter" → [ACTION:media_play:] Läuft wieder.
User: "Nächstes Lied" → [ACTION:media_next:] Weiter zum nächsten.
User: "Eins zurück" → [ACTION:media_previous:] Zurück.
User: "Pausiere Spotify" → [ACTION:media_pause:spotify] Ich pausiere Spotify.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/llm/routing-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/llm/routing-prompt.ts src/services/llm/routing-prompt.test.ts
git commit -m "feat(llm): router prompt for media_* transport actions"
```

---

### Task 5: Compose `WindowsMediaController` in `main.ts`

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `WindowsMediaController` (Task 2), `ActionDeps.media` (Task 3), `resourcesPath`-Muster (bereits in `main.ts`).
- Produces: laufende Verdrahtung — kein neues Symbol.

- [ ] **Step 1: Add the import** — bei den Action-Imports:

```ts
import { WindowsMediaController } from './services/actions/media-controller.js';
```

- [ ] **Step 2: Lift `resourcesPath` above the action layer** — die vorhandene Deklaration (aktuell ~Zeile 182, im Voice-Block)

```ts
  const resourcesPath = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', 'resources');
```

vor den `// --- Action layer …`-Block (~Zeile 126) verschieben, damit sie sowohl für den `MediaController` als auch weiterhin für die Voice-Provider gilt. Die Zeilen an der alten Stelle entfernen (die Voice-Provider nutzen dann dieselbe Variable — keine zweite Deklaration).

- [ ] **Step 3: Build the controller and pass it into ActionDeps** — direkt vor `const actionService = new ActionService(…)`:

```ts
  const mediaController = new WindowsMediaController(
    path.join(resourcesPath, 'media-helper', 'media-helper.exe'),
  );
```

und in den `ActionService`-deps ergänzen:

```ts
  const actionService = new ActionService(appContext.bus, {
    launcher: programLauncher,
    getPrograms: () => appContext!.parsedConfig.resources.programs,
    search: searchService,
    system: systemActions,
    spotify: spotifyActions,
    media: mediaController,
  });
```

- [ ] **Step 4: Typecheck + build (the verification for a composition-root change)**

Run: `npm run typecheck && npm run build:main`
Expected: kein Fehler; keine doppelte `resourcesPath`-Deklaration, `media` in den deps vorhanden.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): wire WindowsMediaController into the action layer"
```

---

### Task 6: C# GSMTC helper (`media-helper.exe`)

**Files:**
- Create: `native/media-helper/media-helper.csproj`
- Create: `native/media-helper/Program.cs`
- Build output (gitignored): `resources/media-helper/media-helper.exe`

**Interfaces:**
- Consumes: der Helper-JSON-Vertrag (Global Constraints) — muss exakt zu `WindowsMediaController` (Task 2) passen.
- Produces: die Exe unter `resources/media-helper/`.

**Voraussetzung:** .NET 8 SDK installiert (`dotnet --version` zeigt 8.x). Ist `dotnet` nicht im PATH: `winget install Microsoft.DotNet.SDK.8`.

- [ ] **Step 1: Create the project file** — `native/media-helper/media-helper.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows10.0.19041.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <AssemblyName>media-helper</AssemblyName>
    <RuntimeIdentifier>win-x64</RuntimeIdentifier>
    <PublishSingleFile>true</PublishSingleFile>
    <SelfContained>true</SelfContained>
  </PropertyGroup>
</Project>
```

- [ ] **Step 2: Write the helper** — `native/media-helper/Program.cs`:

```csharp
using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Windows.Media.Control;

// One command per invocation: read a JSON request on stdin, act, write a JSON response on stdout.
// Contract (must match WindowsMediaController on the TS side):
//   in:  { "action": "media_pause", "target": "" }
//   out: { "success": true, "app": "Spotify.exe", "status": "paused" }
//        { "success": false, "error": "NO_MEDIA_SESSION" }
internal static class MediaHelper
{
    private const int TimeoutMs = 2500;

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    private const byte VK_MEDIA_NEXT_TRACK = 0xB0;
    private const byte VK_MEDIA_PREV_TRACK = 0xB1;
    private const byte VK_MEDIA_PLAY_PAUSE = 0xB3;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    private static async Task<int> Main()
    {
        string raw = await Console.In.ReadToEndAsync();
        string action;
        string target;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            action = doc.RootElement.GetProperty("action").GetString() ?? "";
            target = doc.RootElement.TryGetProperty("target", out var t) ? (t.GetString() ?? "") : "";
        }
        catch
        {
            Fail("ACTION_FAILED");
            return 0;
        }

        try
        {
            await Run(action, target);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[media-helper] exception: " + ex.Message);
            Fail("ACTION_FAILED");
        }
        return 0;
    }

    private static async Task Run(string action, string target)
    {
        var mgr = await WithTimeout(GlobalSystemMediaTransportControlsSessionManager.RequestAsync().AsTask());
        var session = SelectSession(mgr, target, out string selError);
        if (session == null)
        {
            if (selError == "NO_MEDIA_SESSION" && TryMediaKey(action))
            {
                Success("media-key", "unknown");
                return;
            }
            Fail(selError);
            return;
        }

        var info = session.GetPlaybackInfo();
        var controls = info.Controls;
        string status = info.PlaybackStatus.ToString().ToLowerInvariant();

        bool ok;
        switch (action)
        {
            case "media_play":
                if (!controls.IsPlayEnabled) { Fail("ACTION_NOT_SUPPORTED"); return; }
                ok = await WithTimeout(session.TryPlayAsync().AsTask());
                break;
            case "media_pause":
                if (!controls.IsPauseEnabled) { Fail("ACTION_NOT_SUPPORTED"); return; }
                ok = await WithTimeout(session.TryPauseAsync().AsTask());
                break;
            case "media_toggle":
                if (!controls.IsPlayPauseToggleEnabled) { Fail("ACTION_NOT_SUPPORTED"); return; }
                ok = await WithTimeout(session.TryTogglePlayPauseAsync().AsTask());
                break;
            case "media_next":
                if (!controls.IsNextEnabled) { Fail("ACTION_NOT_SUPPORTED"); return; }
                ok = await WithTimeout(session.TrySkipNextAsync().AsTask());
                break;
            case "media_previous":
                if (!controls.IsPreviousEnabled) { Fail("ACTION_NOT_SUPPORTED"); return; }
                ok = await WithTimeout(session.TrySkipPreviousAsync().AsTask());
                break;
            default:
                Fail("ACTION_FAILED");
                return;
        }

        if (ok) Success(session.SourceAppUserModelId, status);
        else Fail("ACTION_FAILED");
    }

    // Target named → first session whose app id contains it; else Windows' current session;
    // else the single Playing session; else ambiguous/none → NO_MEDIA_SESSION.
    private static GlobalSystemMediaTransportControlsSession? SelectSession(
        GlobalSystemMediaTransportControlsSessionManager mgr, string target, out string error)
    {
        error = "";
        var sessions = mgr.GetSessions();
        if (target.Length > 0)
        {
            var needle = target.ToLowerInvariant();
            var match = sessions.FirstOrDefault(s =>
                (s.SourceAppUserModelId ?? "").ToLowerInvariant().Contains(needle));
            if (match == null) { error = "NO_MATCHING_SESSION"; return null; }
            return match;
        }

        var current = mgr.GetCurrentSession();
        if (current != null) return current;

        var playing = sessions.Where(s =>
            s.GetPlaybackInfo().PlaybackStatus
                == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing).ToList();
        if (playing.Count == 1) return playing[0];

        error = "NO_MEDIA_SESSION";
        return null;
    }

    // Fallback only for toggle/next/previous (a media key for play/pause is just a toggle).
    private static bool TryMediaKey(string action)
    {
        byte vk;
        switch (action)
        {
            case "media_toggle": vk = VK_MEDIA_PLAY_PAUSE; break;
            case "media_next": vk = VK_MEDIA_NEXT_TRACK; break;
            case "media_previous": vk = VK_MEDIA_PREV_TRACK; break;
            default: return false;
        }
        Console.Error.WriteLine("[media-helper] fallback: media-key " + action);
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        return true;
    }

    private static async Task<T> WithTimeout<T>(Task<T> task)
    {
        var finished = await Task.WhenAny(task, Task.Delay(TimeoutMs));
        if (finished != task) throw new TimeoutException("GSMTC await timed out");
        return await task;
    }

    private static void Success(string? app, string status) =>
        Console.Out.WriteLine(JsonSerializer.Serialize(new { success = true, app = app ?? "", status }));

    private static void Fail(string error) =>
        Console.Out.WriteLine(JsonSerializer.Serialize(new { success = false, error }));
}
```

- [ ] **Step 3: Build the helper (self-contained single file)**

Run:
```bash
dotnet publish native/media-helper/media-helper.csproj -c Release -o resources/media-helper
```
Expected: `resources/media-helper/media-helper.exe` existiert (self-contained; kein .NET auf dem Zielrechner nötig).

- [ ] **Step 4: Smoke-test the helper directly**

Bei laufender Wiedergabe (z. B. Spotify spielt) in PowerShell:
```powershell
'{ "action": "media_pause", "target": "" }' | .\resources\media-helper\media-helper.exe
```
Expected: eine JSON-Zeile wie `{"success":true,"app":"Spotify.exe","status":"playing"}`, und die Musik pausiert. Ohne laufende Wiedergabe: `{"success":false,"error":"NO_MEDIA_SESSION"}`.

- [ ] **Step 5: Commit the source (exe is gitignored)**

```bash
git add native/media-helper/media-helper.csproj native/media-helper/Program.cs
git commit -m "feat(native): GSMTC media-helper (play/pause/toggle/next/previous, media-key fallback)"
```

---

### Task 7: Update `problems/features.md`

**Files:**
- Modify: `problems/features.md`

**Interfaces:**
- Consumes: nichts.
- Produces: Doku spiegelt das Zwei-Schichten-Modell.

- [ ] **Step 1: Edit the Spotify roadmap section** — im Abschnitt `## Feature: Spotify-Steuerung — Roadmap` die V2-Zeile (aktuell „**V2 — Transport (Gruppe A), läuft auf `feat/spotify-transport`:** …") ersetzen durch:

```markdown
- **Mediensteuerung V2 (Schicht 1, generisch) ✅ auf `feat/media-control`:** play/pause/toggle/next/previous über Windows GSMTC (C#-Helper `media-helper.exe`), playerübergreifend (Spotify/Browser/VLC), ohne OAuth/Premium. Generische `media_*`-Actions + `MediaController`-Vertrag. Details: `docs/superpowers/specs/2026-07-19-media-control-design.md`.
- **Schicht 2 (Spotify-spezifisch, künftig):** Shuffle/Repeat, nach Namen spielen, Playlists — via Spotify-Web-API (Premium + aktives Gerät). Bleiben `spotify_*`-Actions hinter dem OAuth-Adapter.
```

- [ ] **Step 2: Verify the file still reads consistently**

Run: `git diff problems/features.md`
Expected: nur die Roadmap-Zeilen geändert; V1 (`spotify_volume`) unberührt.

- [ ] **Step 3: Commit**

```bash
git add problems/features.md
git commit -m "docs(features): two-layer media model — generic media_* (Schicht 1) vs spotify_* (Schicht 2)"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck` — grün.
- [ ] `npx vitest run` — alle Tests grün.
- [ ] `npm run build` — grün.
- [ ] **Manuell (Martin, `npm start`):** in **Spotify** *und* **YouTube (Browser)** je etwas abspielen → „Pause"/„Weiter"/„Nächstes Lied" auf die laufende Sitzung; die spielende Sitzung wechseln und erneut; „Pausiere Spotify" (Named-Target); **alles gestoppt** → „Ich sehe gerade keine laufende Wiedergabe."; Fallback prüfen (Player ohne GSMTC-Session, falls vorhanden → stderr-Marker).
