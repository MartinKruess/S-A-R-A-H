# Medien-Konversationskontext Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Knappe Folgebefehle („weiter"/„zurück"/„stopp") werden per kurzem, gleitendem Kontextfenster deterministisch auf die richtige `media_*`-Action aufgelöst — auch im warmen 9B-Fenster.

**Architecture:** Ein deterministischer `MediaContext` (in-memory, kein LLM) merkt sich die letzte Medien-Aktion + Zeitstempel und löst terse Äußerungen innerhalb von 12 s auf. Der `RouterService` ruft `resolve()` als allerersten Schritt in `runTurn()` (vor dem 2B/9B-Zweig) und `record()` an jedem Punkt, an dem er eine `media_*`-Action absetzt.

**Tech Stack:** TypeScript (Electron main), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-19-media-context-design.md` (zweifach reviewt).

## Global Constraints

- Code/Kommentare/Commits Englisch; nutzer­sichtbare `speak`-Texte Deutsch (exakt aus der Auflösungs-Tabelle der Spec).
- TypeScript: kein `any`/`unknown`/`never` außer unvermeidbar. Ausnahme: in Tests darf ein Fake per `as unknown as <Type>` gecastet werden (bestehendes Muster, z. B. `action-service.test.ts`).
- **Typ wiederverwenden:** `MediaAction` aus `src/services/actions/media-controller.js` importieren, NICHT neu definieren.
- **Fenster:** `MEDIA_CONTEXT_WINDOW_MS = 12_000` (Hardcode, analog `IDLE_TIMEOUT_MS`).
- **Hook-Placement (kritisch):** Resolver in `runTurn()` VOR dem `if (this.activeModel === '9b')`-Zweig — sonst greift er im warmen 9B-Fenster nie (terse Wörter umgehen das Gate).
- **`record`-Guard:** im normalen Router-Pfad (`routeAndRespond`) nur für `media_*`-Actions aufrufen (`action.startsWith('media_')`), sonst überschreibt z. B. `set_volume` die `lastAction`.
- **Scope V1:** nur Schicht-1-Transport; kein Ziel-Gedächtnis, kein Repeat/Playlist, kein `nochmal` (bekannte Einschränkungen siehe Spec).

## File Structure

- `src/services/llm/media-context.ts` (create) — `MediaContext`, `ResolvedMedia`, `MEDIA_CONTEXT_WINDOW_MS`.
- `src/services/llm/media-context.test.ts` (create) — Unit-Tests (SQLite-frei).
- `src/services/llm/router-service.ts` (modify) — optionaler 4. Ctor-Param, Hook in `runTurn`, `record`-Guard in `routeAndRespond`.
- `src/services/llm/router-service.test.ts` (modify) — neuer `describe`-Block „RouterService (media context)" mit Fake-Context (SQLite-frei).
- `problems/features.md` (modify) — nach Merge auf umgesetzt.

---

### Task 1: `MediaContext` (Kernlogik + Unit-Tests)

**Files:**
- Create: `src/services/llm/media-context.ts`
- Test: `src/services/llm/media-context.test.ts`

**Interfaces:**
- Consumes: `MediaAction` aus `../actions/media-controller.js`.
- Produces:
  - `export const MEDIA_CONTEXT_WINDOW_MS = 12_000`
  - `export interface ResolvedMedia { action: MediaAction; speak: string }`
  - `export class MediaContext { record(action: MediaAction, nowMs: number): void; resolve(text: string, nowMs: number): ResolvedMedia | null }`

- [ ] **Step 1: Write the failing tests** — `media-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MediaContext, MEDIA_CONTEXT_WINDOW_MS } from './media-context.js';

describe('MediaContext.resolve', () => {
  it('"weiter" after a pause resumes (media_play)', () => {
    const c = new MediaContext();
    c.record('media_pause', 1000);
    expect(c.resolve('weiter', 2000)).toEqual({ action: 'media_play', speak: 'Läuft wieder.' });
  });

  it('"weiter" after a skip goes to the next track (media_next)', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('weiter', 2000)).toEqual({ action: 'media_next', speak: 'Nächstes Lied.' });
  });

  it('"nächstes" is always media_next, even right after a pause', () => {
    const c = new MediaContext();
    c.record('media_pause', 1000);
    expect(c.resolve('nächstes', 2000)).toEqual({ action: 'media_next', speak: 'Nächstes Lied.' });
  });

  it('"zurück"/"das vorherige" → media_previous; "stopp"/"halt" → media_pause', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('zurück', 1500)?.action).toBe('media_previous');
    expect(c.resolve('das vorherige', 1500)?.action).toBe('media_previous');
    expect(c.resolve('stopp', 1500)?.action).toBe('media_pause');
    expect(c.resolve('halt', 1500)?.action).toBe('media_pause');
  });

  it('returns null when the window is cold (> WINDOW old)', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('weiter', 1000 + MEDIA_CONTEXT_WINDOW_MS + 1)).toBeNull();
  });

  it('returns null when nothing was recorded yet', () => {
    expect(new MediaContext().resolve('weiter', 5000)).toBeNull();
  });

  it('returns null for a whole sentence (> 3 tokens)', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('erzähl mir mehr davon weiter', 2000)).toBeNull();
  });

  it('returns null for an unknown short word', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('hallo', 2000)).toBeNull();
  });

  it('record refreshes the sliding window', () => {
    const c = new MediaContext();
    c.record('media_next', 0);
    const first = c.resolve('weiter', 10_000);      // 10s < 12s → warm
    expect(first?.action).toBe('media_next');
    c.record(first!.action, 10_000);                 // refresh at 10s (RouterService does this)
    expect(c.resolve('weiter', 15_000)?.action).toBe('media_next'); // 5s after refresh → still warm
  });

  it('normalizes case and surrounding whitespace', () => {
    const c = new MediaContext();
    c.record('media_pause', 1000);
    expect(c.resolve('  WEITER  ', 2000)?.action).toBe('media_play');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/llm/media-context.test.ts`
Expected: FAIL — cannot find `./media-context.js`.

- [ ] **Step 3: Write minimal implementation** — `media-context.ts`:

```ts
// src/services/llm/media-context.ts
// Deterministic short-window media conversation context (Layer 1). Resolves
// terse follow-up commands ("weiter"/"zurück"/"stopp") using the last media
// action within a sliding window — no LLM in the resolution path.
import type { MediaAction } from '../actions/media-controller.js';

export const MEDIA_CONTEXT_WINDOW_MS = 12_000;

export interface ResolvedMedia {
  action: MediaAction;
  speak: string;
}

interface MediaContextState {
  lastAction: MediaAction;
  atMs: number;
}

// Whole-sentence inputs are never terse follow-ups.
const MAX_TERSE_TOKENS = 3;

const STOP_PHRASES = new Set(['stop', 'stopp', 'halt', 'pause']);
const BACK_PHRASES = new Set(['zurück', 'eins zurück', 'das vorherige']);
const NEXT_PHRASES = new Set(['nächstes']);
// Ambiguous: after a pause → resume; after a skip / while playing → next.
const FORWARD_PHRASES = new Set(['weiter', 'und weiter', 'noch eins']);

export class MediaContext {
  private state: MediaContextState | null = null;

  /** Record that a media_* command was issued (refreshes the window). */
  record(action: MediaAction, nowMs: number): void {
    this.state = { lastAction: action, atMs: nowMs };
  }

  /**
   * Resolve a terse follow-up to a media action, or null if the window is cold
   * or the text isn't a known terse follow-up (caller then routes normally).
   */
  resolve(text: string, nowMs: number): ResolvedMedia | null {
    const norm = text.normalize('NFC').trim().toLowerCase();
    if (!norm || norm.split(/\s+/).length > MAX_TERSE_TOKENS) return null;
    if (!this.state || nowMs - this.state.atMs > MEDIA_CONTEXT_WINDOW_MS) return null;

    if (STOP_PHRASES.has(norm)) return { action: 'media_pause', speak: 'Pausiert.' };
    if (BACK_PHRASES.has(norm)) return { action: 'media_previous', speak: 'Zurück.' };
    if (NEXT_PHRASES.has(norm)) return { action: 'media_next', speak: 'Nächstes Lied.' };
    if (FORWARD_PHRASES.has(norm)) {
      return this.state.lastAction === 'media_pause'
        ? { action: 'media_play', speak: 'Läuft wieder.' }
        : { action: 'media_next', speak: 'Nächstes Lied.' };
    }
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/llm/media-context.test.ts`
Expected: PASS (10/10).

- [ ] **Step 5: Commit**

```bash
git add src/services/llm/media-context.ts src/services/llm/media-context.test.ts
git commit -m "feat(llm): MediaContext — deterministic short-window resolver for terse media follow-ups"
```

---

### Task 2: Wire `MediaContext` into `RouterService`

**Files:**
- Modify: `src/services/llm/router-service.ts`
- Test: `src/services/llm/router-service.test.ts`

**Interfaces:**
- Consumes: `MediaContext`, `ResolvedMedia` (Task 1), `MediaAction` (`media-controller.js`).
- Produces: optionaler 4. Ctor-Param `mediaContext`; Resolver-Shortcut in `runTurn`; `record`-Guard in `routeAndRespond`.

**Hintergrund für den Integrationstest:** Der Shortcut-Pfad fasst kein SQLite an, solange `status === 'running'` und `conversationId === FALLBACK_CONVERSATION_ID` (Default, wenn `init()` NICHT aufgerufen wird) — `persistMessage` überspringt dann den DB-Insert. Deshalb läuft der Test mit einem **Fake-Context ohne `bootstrap()`** und ist grün, obwohl die anderen `router-service.test.ts`-Blöcke im vitest-Env am `better-sqlite3`-ABI-Bruch scheitern (vorbestehend, nicht Teil dieses Plans).

- [ ] **Step 1: Write the failing integration test** — in `router-service.test.ts` einen NEUEN `describe`-Block am Dateiende anfügen (nutzt NICHT das `bootstrap`-`beforeEach`):

```ts
import { MessageBus } from '../../core/message-bus.js';
import { MediaContext } from './media-context.js';

describe('RouterService (media context)', () => {
  // Minimal fake AppContext: the media-context shortcut path only touches the bus.
  // No init() → conversationId stays FALLBACK → persistMessage skips the DB.
  function fakeCtx(bus: MessageBus): AppContext {
    return {
      bus,
      db: { insert: async () => 0 },
      parsedConfig: { llm: { baseUrl: 'http://localhost:11434' } },
    } as unknown as AppContext;
  }

  it('warm 9B window: terse "weiter" resolves to media_next and never calls the worker', async () => {
    const bus = new MessageBus();
    const requests: BusEvents['action:request'][] = [];
    bus.on('action:request', (m) => requests.push(m.data));

    const worker = new FakeProvider();
    const mediaContext = new MediaContext();
    mediaContext.record('media_next', Date.now()); // warm: last action was a skip

    const r = new RouterService(fakeCtx(bus), new FakeProvider(), worker, mediaContext);
    r.status = 'running'; // bypass init()/DB (conversationId stays FALLBACK → no SQLite)
    r.activeModel = '9b';

    await r.handleChatMessage('weiter');

    expect(requests).toHaveLength(1);
    expect(requests[0].action).toBe('media_next'); // shortcut fired before the 9B worker
    expect(worker.lastMessages).toBeNull();          // worker.stream never ran
    await r.destroy();
  });
});
```

> **Nur der Warm-Shortcut wird hier integrationsgetestet** — er ist der einzige config-freie Pfad (nur Bus). Die „kalt/kein-Treffer → normale Route"-Fälle deckt der `MediaContext`-Unit-Test (Task 1, `resolve` → `null`) plus das manuelle E2E ab; den vollen Fall-Through (`runWorker`) zu fahren würde einen kompletten `parsedConfig` brauchen, den der Fake-Context bewusst nicht stellt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/llm/router-service.test.ts -t "media context"`
Expected: FAIL — `RouterService` ctor takes 3 args / `media_next` action not emitted (resolver not wired yet).

- [ ] **Step 3: Implement the wiring** — in `router-service.ts`:

Imports ergänzen:
```ts
import { MediaContext } from './media-context.js';
import { isActionName, looksLikeActionCommand } from '../actions/action-schemas.js';
import type { MediaAction } from '../actions/media-controller.js';
```
(`isActionName`/`looksLikeActionCommand` sind schon importiert — nur `MediaContext` + `MediaAction` neu.)

Konstruktor um den optionalen 4. Parameter erweitern:
```ts
  constructor(
    private context: AppContext,
    private routerProvider: LlmProvider,
    workerProvider: LlmProvider,
    private mediaContext: MediaContext = new MediaContext(),
  ) {
    this.vramManager = new VramManager(context.parsedConfig.llm.baseUrl);
    this.routing = new RoutingService(routerProvider);
    this.worker = new WorkerService(workerProvider);
  }
```

In `runTurn` den Resolver als ERSTEN Schritt nach `persistMessage` einfügen (VOR dem `try`/`if activeModel`-Block):
```ts
  private async runTurn(text: string, mode: 'chat' | 'voice'): Promise<void> {
    await this.persistMessage('user', text);

    // MediaContext (Layer-1 terse follow-ups) — before any routing so it also
    // fires in the warm-9B window, where terse words bypass the gate.
    const hit = this.mediaContext.resolve(text, Date.now());
    if (hit) {
      const requestId = randomUUID();
      this.pendingActions.set(requestId, { action: hit.action });
      this.context.bus.emit(this.id, 'action:request', { requestId, action: hit.action, param: '' });
      this.mediaContext.record(hit.action, Date.now());
      await this.emitAssistantResponse(hit.speak);
      return;
    }

    try {
      // ... bestehender if (this.activeModel === '9b') { … } else { … } Block UNVERÄNDERT ...
```

In `routeAndRespond`, im `action`-Zweig, nach dem `action:request`-Emit den Guard-`record` einfügen:
```ts
      const requestId = randomUUID();
      this.pendingActions.set(requestId, { action });
      this.context.bus.emit(this.id, 'action:request', { requestId, action, param });
      if (action.startsWith('media_')) this.mediaContext.record(action as MediaAction, Date.now());
      await this.emitAssistantResponse(feedback);
      return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/llm/router-service.test.ts -t "media context"`
Expected: PASS (1/1). (Die übrigen `router-service.test.ts`-Blöcke bleiben am vorbestehenden `better-sqlite3`-ABI-Bruch rot — NICHT Teil dieses Plans; der `-t "media context"`-Filter läuft nur den neuen Block.)

- [ ] **Step 5: Typecheck + main build**

Run: `npm run typecheck && npm run build:main`
Expected: sauber (optionaler Ctor-Param bricht keine der 13+ bestehenden `new RouterService(ctx, r, w)`-Aufrufe).

- [ ] **Step 6: Commit**

```bash
git add src/services/llm/router-service.ts src/services/llm/router-service.test.ts
git commit -m "feat(llm): wire MediaContext into RouterService (pre-routing resolver + guarded record)"
```

---

### Task 3: `features.md` nachziehen

**Files:**
- Modify: `problems/features.md`

- [ ] **Step 1: Edit the media-context feature entry** — im Abschnitt `## Feature: Medien-Konversationskontext (geplant, nach Schicht 1)` die Überschrift/Einleitung auf umgesetzt setzen und in `## ✅ Umgesetzt (auf dev)` eine Zeile ergänzen:

```markdown
- **Medien-Konversationskontext** — deterministischer `MediaContext` (`src/services/llm/media-context.ts`): knappe Folgebefehle im 12-s-Fenster („weiter" nach Pause → resume, nach Skip → next; „zurück"/„stopp"), aufgelöst vor jeglichem Routing (fängt auch das warme 9B-Fenster). Spec: `docs/superpowers/specs/2026-07-19-media-context-design.md`.
```

Die „(geplant)"-Sektion entsprechend auf „✅ umgesetzt" kürzen (Detail-Design steht in der Spec).

- [ ] **Step 2: Commit**

```bash
git add problems/features.md
git commit -m "docs(features): media conversation context implemented"
```

---

## Final verification (after all tasks)

- [ ] `npx vitest run src/services/llm/media-context.test.ts` — grün (10/10).
- [ ] `npx vitest run src/services/llm/router-service.test.ts -t "media context"` — grün (1/1).
- [ ] `npm run typecheck` und `npm run build:main` — grün.
- [ ] **Manuell (Martin, `npm start`):** Musik läuft → „nächstes Lied" → kurz warten → „weiter" (soll **skippen**, nicht nur resumen) → „zurück" → „stopp". Dann: „pausieren" → „weiter" (soll **fortsetzen**). Gegenprobe: 20–30 s mit Sarah plaudern (9B), dann „weiter" (Fenster kalt → soll **nicht** skippen, normale Antwort). Und: mitten im 9B-Gespräch direkt nach einem Skip „weiter" (Resolver greift vor dem Worker).
