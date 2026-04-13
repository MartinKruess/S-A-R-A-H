# Dual-LLM Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-LLM architecture with a 2B Router + 9B Worker system where the 2B acts as central router with immediate user feedback, and the 9B is loaded on-demand with VRAM swapping.

**Architecture:** RouterService replaces LlmService as the `chat:message` subscriber. It manages two OllamaProvider instances (2B router, 9B worker), parses `[ROUTE:xxx]` tags from the 2B, emits immediate feedback, and handles VRAM swaps via Ollama's `keep_alive` API. When 9B is active, messages go directly to it, bypassing routing. A 5-minute idle timer swaps back to 2B.

**Tech Stack:** TypeScript, Zod v4, Vitest

**Spec:** `docs/superpowers/specs/2026-04-11-dual-llm-routing-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/core/config-schema.ts` | Modify | Replace `model` with `routerModel`/`workerModel`, add `workerOptions` |
| `src/core/bus-events.ts` | Modify | Add `llm:routing` and `llm:model-swap` events |
| `src/services/llm/llm-types.ts` | Modify | Add `WorkerOptions` type, update `LlmConfig` |
| `src/services/llm/router-service.ts` | Create | Central routing orchestrator replacing LlmService |
| `src/services/llm/route-parser.ts` | Create | Parse `[ROUTE:xxx]` tags from 2B responses |
| `src/services/llm/vram-manager.ts` | Create | Model loading/unloading via Ollama API |
| `src/services/llm/routing-prompt.ts` | Create | Routing system prompt for the 2B |
| `src/main.ts` | Modify | Wire RouterService instead of LlmService |
| `tests/services/llm/route-parser.test.ts` | Create | Tests for route tag parsing |
| `tests/services/llm/vram-manager.test.ts` | Create | Tests for model swap logic |
| `tests/services/llm/router-service.test.ts` | Create | Tests for full routing flow |

---

### Task 1: Config Schema — Replace `model` with Dual-Model Config

**Files:**
- Modify: `src/core/config-schema.ts`
- Modify: `src/services/llm/llm-types.ts`

- [ ] **Step 1: Update LlmSchema in config-schema.ts**

In `src/core/config-schema.ts`, replace the current `LlmSchema` (lines 96-104) with:

```typescript
export const LlmSchema = z.object({
  baseUrl: z.string().default('http://localhost:11434'),
  routerModel: z.string().default('qwen3.5:2b'),
  workerModel: z.string().default('qwen3.5:9b'),
  workerOptions: z.object({
    num_ctx: z.number().default(8192),
    num_gpu: z.number().default(24),
  }).default({}),
  options: z.object({
    temperature: z.number().optional(),
    num_predict: z.number().optional(),
    num_ctx: z.number().optional(),
  }).default({}),
});
```

- [ ] **Step 2: Add migration preprocess for `model` → `routerModel`**

In `src/core/config-schema.ts`, extend the existing preprocess in `SarahConfigSchema` (line 128) to also migrate the old `model` field:

```typescript
export const SarahConfigSchema = z.preprocess((raw) => {
  const obj = (raw ?? {}) as Record<string, Record<string, unknown>>;
  // Migrate responseStyle/tone from profile to personalization
  if (obj.profile && obj.personalization) {
    const p = obj.profile;
    const pers = obj.personalization;
    if (p.responseStyle && !pers.responseStyle) {
      pers.responseStyle = p.responseStyle;
      delete p.responseStyle;
    }
    if (p.tone && !pers.tone) {
      pers.tone = p.tone;
      delete p.tone;
    }
  }
  // Migrate llm.model → llm.routerModel
  if (obj.llm && 'model' in obj.llm && !obj.llm.routerModel) {
    obj.llm.routerModel = obj.llm.model;
    delete obj.llm.model;
  }
  return obj;
}, z.object({
  // ... rest unchanged
}));
```

- [ ] **Step 3: Update LlmConfig type in llm-types.ts**

In `src/services/llm/llm-types.ts`, replace `LlmConfig` and `DEFAULT_LLM_CONFIG` (lines 7-21):

```typescript
export interface WorkerOptions {
  num_ctx: number;
  num_gpu: number;
}

export interface LlmConfig {
  baseUrl: string;
  routerModel: string;
  workerModel: string;
  workerOptions: WorkerOptions;
  options?: OllamaOptions;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: 'http://localhost:11434',
  routerModel: 'qwen3.5:2b',
  workerModel: 'qwen3.5:9b',
  workerOptions: {
    num_ctx: 8192,
    num_gpu: 24,
  },
  options: {
    temperature: 0.7,
    num_predict: 1600,
    num_ctx: 32768,
  },
};
```

- [ ] **Step 4: Update test mock config**

In `tests/services/llm/llm-service.test.ts`, update line 55 in `createMockContext()`:

```typescript
llm: { baseUrl: 'http://localhost:11434', routerModel: 'qwen3.5:2b', workerModel: 'qwen3.5:9b', workerOptions: { num_ctx: 8192, num_gpu: 24 }, options: {} },
```

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`

Expected: Type errors in `main.ts` (still references old `llmConfig.model`). Schema and types should compile.

- [ ] **Step 6: Commit**

```bash
git add src/core/config-schema.ts src/services/llm/llm-types.ts tests/services/llm/llm-service.test.ts
git commit -m "$(cat <<'EOF'
refactor: replace single model config with routerModel/workerModel

Split llm.model into llm.routerModel (2B) and llm.workerModel (9B).
Add workerOptions for num_ctx/num_gpu control.
Include migration preprocess for existing configs.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Bus Events — Add Routing and Model-Swap Events

**Files:**
- Modify: `src/core/bus-events.ts`

- [ ] **Step 1: Add new event types**

In `src/core/bus-events.ts`, add two new events after the existing `llm:error` entry (line 11):

```typescript
export type BusEvents = {
  'chat:message':        { text: string; mode: 'chat' | 'voice' };
  'llm:chunk':           { text: string };
  'llm:done':            { fullText: string };
  'llm:error':           { message: string };
  'llm:routing':         { from: '2b' | '9b'; to: 'self' | '9b' | 'backend' | 'extern'; feedback: string };
  'llm:model-swap':      { loading: string; unloading: string };
  'voice:state':         { state: VoiceState };
  'voice:listening':     Record<string, never>;
  'voice:transcript':    { text: string };
  'voice:speaking':      { text: string };
  'voice:play-audio':    { audio: number[]; sampleRate: number };
  'voice:done':          Record<string, never>;
  'voice:error':         { message: string };
  'voice:interrupted':   Record<string, never>;
  'voice:wake':          Record<string, never>;
  'voice:playback-done': Record<string, never>;
};
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -10`

Expected: Clean for this file (no consumers of new events yet).

- [ ] **Step 3: Commit**

```bash
git add src/core/bus-events.ts
git commit -m "$(cat <<'EOF'
feat: add llm:routing and llm:model-swap bus events

New events for dual-LLM routing metadata and VRAM swap tracking.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Route Parser — Parse `[ROUTE:xxx]` Tags

**Files:**
- Create: `src/services/llm/route-parser.ts`
- Create: `tests/services/llm/route-parser.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/services/llm/route-parser.test.ts`:

```typescript
// tests/services/llm/route-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseRouteTag } from '../../../src/services/llm/route-parser';

describe('parseRouteTag', () => {
  it('parses [ROUTE:self] with feedback', () => {
    const result = parseRouteTag('[ROUTE:self] Natürlich, öffne ich sofort!');
    expect(result).toEqual({
      route: 'self',
      feedback: 'Natürlich, öffne ich sofort!',
    });
  });

  it('parses [ROUTE:9b] with feedback', () => {
    const result = parseRouteTag('[ROUTE:9b] Oh das muss ich mir genauer ansehen.');
    expect(result).toEqual({
      route: '9b',
      feedback: 'Oh das muss ich mir genauer ansehen.',
    });
  });

  it('parses [ROUTE:backend] with feedback', () => {
    const result = parseRouteTag('[ROUTE:backend] Ich sehe mir das an, das dauert einen Moment.');
    expect(result).toEqual({
      route: 'backend',
      feedback: 'Ich sehe mir das an, das dauert einen Moment.',
    });
  });

  it('parses [ROUTE:extern] with feedback', () => {
    const result = parseRouteTag('[ROUTE:extern] Das leite ich weiter.');
    expect(result).toEqual({
      route: 'extern',
      feedback: 'Das leite ich weiter.',
    });
  });

  it('parses [ROUTE:vision] with feedback', () => {
    const result = parseRouteTag('[ROUTE:vision] Lass mich das Bild ansehen.');
    expect(result).toEqual({
      route: 'vision',
      feedback: 'Lass mich das Bild ansehen.',
    });
  });

  it('returns self fallback when no tag present', () => {
    const result = parseRouteTag('Klar, mache ich!');
    expect(result).toEqual({
      route: 'self',
      feedback: 'Klar, mache ich!',
    });
  });

  it('returns self fallback for empty string', () => {
    const result = parseRouteTag('');
    expect(result).toEqual({
      route: 'self',
      feedback: '',
    });
  });

  it('handles tag with leading whitespace', () => {
    const result = parseRouteTag('  [ROUTE:9b] Moment bitte.');
    expect(result).toEqual({
      route: '9b',
      feedback: 'Moment bitte.',
    });
  });

  it('handles tag with newlines in feedback', () => {
    const result = parseRouteTag('[ROUTE:self] Zeile eins.\nZeile zwei.');
    expect(result).toEqual({
      route: 'self',
      feedback: 'Zeile eins.\nZeile zwei.',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/llm/route-parser.test.ts 2>&1 | tail -10`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement route-parser.ts**

Create `src/services/llm/route-parser.ts`:

```typescript
// src/services/llm/route-parser.ts

export type RouteTarget = 'self' | '9b' | 'backend' | 'vision' | 'extern';

export interface ParsedRoute {
  route: RouteTarget;
  feedback: string;
}

const ROUTE_PATTERN = /^\s*\[ROUTE:(\w+)]\s*/;

export function parseRouteTag(response: string): ParsedRoute {
  const match = response.match(ROUTE_PATTERN);

  if (!match) {
    return { route: 'self', feedback: response };
  }

  const route = match[1] as RouteTarget;
  const feedback = response.slice(match[0].length);

  return { route, feedback };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/services/llm/route-parser.test.ts 2>&1 | tail -10`

Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/llm/route-parser.ts tests/services/llm/route-parser.test.ts
git commit -m "$(cat <<'EOF'
feat: add route tag parser for dual-LLM routing

Parses [ROUTE:xxx] tags from 2B responses.
Falls back to 'self' when no tag is present.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: VRAM Manager — Model Loading/Unloading

**Files:**
- Create: `src/services/llm/vram-manager.ts`
- Create: `tests/services/llm/vram-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/services/llm/vram-manager.test.ts`:

```typescript
// tests/services/llm/vram-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VramManager } from '../../../src/services/llm/vram-manager';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('VramManager', () => {
  let manager: VramManager;

  beforeEach(() => {
    mockFetch.mockReset();
    manager = new VramManager('http://localhost:11434');
  });

  describe('unloadModel', () => {
    it('sends keep_alive 0 to unload model', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      await manager.unloadModel('qwen3.5:2b');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen3.5:2b',
            prompt: '',
            keep_alive: '0',
          }),
        },
      );
    });

    it('does not throw on fetch error', async () => {
      mockFetch.mockRejectedValue(new Error('connection refused'));
      await expect(manager.unloadModel('qwen3.5:2b')).resolves.toBeUndefined();
    });
  });

  describe('getLoadedModels', () => {
    it('returns list of loaded model names', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          models: [
            { model: 'qwen3.5:2b', size_vram: 3000000000 },
            { model: 'qwen3.5:9b', size_vram: 6500000000 },
          ],
        }),
      });

      const models = await manager.getLoadedModels();
      expect(models).toEqual([
        { model: 'qwen3.5:2b', sizeVram: 3000000000 },
        { model: 'qwen3.5:9b', sizeVram: 6500000000 },
      ]);
    });

    it('returns empty array on fetch error', async () => {
      mockFetch.mockRejectedValue(new Error('connection refused'));
      const models = await manager.getLoadedModels();
      expect(models).toEqual([]);
    });
  });

  describe('swapModels', () => {
    it('unloads current model then returns', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      await manager.swapModels('qwen3.5:2b', 'qwen3.5:9b');

      // Should have called unload for the outgoing model
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('qwen3.5:2b');
      expect(body.keep_alive).toBe('0');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/llm/vram-manager.test.ts 2>&1 | tail -10`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement vram-manager.ts**

Create `src/services/llm/vram-manager.ts`:

```typescript
// src/services/llm/vram-manager.ts

export interface LoadedModel {
  model: string;
  sizeVram: number;
}

export class VramManager {
  constructor(private baseUrl: string) {}

  async unloadModel(model: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: '',
          keep_alive: '0',
        }),
      });
    } catch {
      // Model may already be unloaded — ignore errors
    }
  }

  async getLoadedModels(): Promise<LoadedModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/ps`);
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models: { model: string; size_vram: number }[];
      };
      return data.models.map((m) => ({
        model: m.model,
        sizeVram: m.size_vram,
      }));
    } catch {
      return [];
    }
  }

  async swapModels(unload: string, _load: string): Promise<void> {
    await this.unloadModel(unload);
    // The new model is loaded automatically by Ollama on the next chat request.
    // No explicit load call needed.
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/services/llm/vram-manager.test.ts 2>&1 | tail -10`

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/llm/vram-manager.ts tests/services/llm/vram-manager.test.ts
git commit -m "$(cat <<'EOF'
feat: add VramManager for Ollama model loading/unloading

Manages VRAM by unloading models via keep_alive: 0.
Queries loaded models via /api/ps endpoint.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Routing Prompt — System Prompt for the 2B Router

**Files:**
- Create: `src/services/llm/routing-prompt.ts`

- [ ] **Step 1: Create routing-prompt.ts**

Create `src/services/llm/routing-prompt.ts`:

```typescript
// src/services/llm/routing-prompt.ts

export function buildRoutingPrompt(): string {
  return `## IDENTITY
You are Sarah's routing brain. You receive user messages and decide who handles them.

## YOUR CAPABILITIES (handle yourself)
- Greetings and small talk openers ("Hallo", "Guten Morgen", "Wie geht's")
- Opening and closing programs ("Öffne Photoshop", "Schließe Discord")
- Simple scheduling and reminders ("Erinnere mich um 15 Uhr")
- Quick factual answers ("Wie spät ist es?", "Was ist die Hauptstadt von Frankreich?")
- Simple calculations and conversions

## ESCALATE TO 9B
- Longer conversations, storytelling, explanations
- File operations (sorting, renaming, organizing files/folders)
- Email drafting, reading, summarizing
- Medium complexity research
- Any task that requires multiple steps or deeper reasoning

## ESCALATE TO BACKEND [not yet available]
- Deep research, multi-source analysis
- Project planning, complex reasoning
- Code generation, debugging

## ESCALATE TO EXTERN [not yet available]
- Professional coding (Claude, Codex)
- Image generation (DALL-E)

## RESPONSE FORMAT
Always start your response with exactly one route tag, followed by a short German feedback message.
The tag MUST be the very first thing in your response.

Format: [ROUTE:target] Your German feedback message

Available targets: self, 9b, backend, extern

Examples:
[ROUTE:self] Natürlich, ich öffne das Programm!
[ROUTE:9b] Oh, das muss ich mir genauer ansehen.
[ROUTE:backend] Ich sehe mir das an, das dauert einen Moment.

## RULES
- Always respond in German
- Keep your feedback message short and natural (1-2 sentences)
- When uncertain between self and 9b, choose 9b
- The feedback message is shown to the user immediately
- If a target is marked [not yet available], route to 9b instead
- NEVER skip the route tag — always include it`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/llm/routing-prompt.ts
git commit -m "$(cat <<'EOF'
feat: add routing system prompt for 2B router model

Defines capabilities per tier and response format with [ROUTE:xxx] tags.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: RouterService — Core Routing Orchestrator

**Files:**
- Create: `src/services/llm/router-service.ts`
- Create: `tests/services/llm/router-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/services/llm/router-service.test.ts`:

```typescript
// tests/services/llm/router-service.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RouterService } from '../../../src/services/llm/router-service';
import type { LlmProvider, ChatMessage, ChatOptions } from '../../../src/services/llm/llm-provider.interface';
import type { AppContext } from '../../../src/core/bootstrap';
import { MessageBus } from '../../../src/core/message-bus';

function createMockProvider(responses: string[]): LlmProvider {
  let callIndex = 0;
  return {
    id: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    chat: vi.fn().mockImplementation(
      async (_msgs: ChatMessage[], onChunk: (t: string) => void, _options?: ChatOptions) => {
        const response = responses[callIndex] ?? responses[0];
        callIndex++;
        onChunk(response);
        return response;
      },
    ),
  };
}

function createMockContext(): { context: AppContext; bus: MessageBus } {
  const bus = new MessageBus();
  const parsedConfig = {
    onboarding: { setupComplete: true },
    system: { os: '', platform: '', arch: '', cpu: '', cpuCores: '', totalMemory: '', freeMemory: '', hostname: '', shell: '', language: '', timezone: '', folders: { documents: '', downloads: '', pictures: '', desktop: '' } },
    profile: {
      displayName: 'Martin',
      lastName: '',
      city: 'Berlin',
      address: '',
      profession: 'Developer',
      activities: '',
      usagePurposes: [],
      hobbies: [],
    },
    skills: { programming: null, programmingStack: [], programmingResources: [], programmingProjectsFolder: '', design: null, office: null },
    resources: { emails: [], programs: [], favoriteLinks: [], pdfCategories: [], picturesFolder: '', installFolder: '', gamesFolder: '', extraProgramsFolder: '', importantFolders: [] },
    trust: { memoryAllowed: true, fileAccess: 'specific-folders' as const, confirmationLevel: 'standard' as const, memoryExclusions: [], anonymousEnabled: false, showContextEnabled: false },
    personalization: {
      accentColor: '#00d4ff',
      voice: 'default-female-de',
      speechRate: 1,
      chatFontSize: 'default' as const,
      chatAlignment: 'stacked' as const,
      emojisEnabled: true,
      responseMode: 'normal' as const,
      responseLanguage: 'de' as const,
      responseStyle: 'mittel' as const,
      tone: 'freundlich' as const,
      characterTraits: [],
      quirk: null,
    },
    controls: { voiceMode: 'off' as const, pushToTalkKey: 'F9', quietModeDuration: 30, customCommands: [] },
    llm: { baseUrl: 'http://localhost:11434', routerModel: 'qwen3.5:2b', workerModel: 'qwen3.5:9b', workerOptions: { num_ctx: 8192, num_gpu: 24 }, options: {} },
    integrations: { context7: false },
  };
  return {
    bus,
    context: {
      bus,
      registry: {} as any,
      config: { get: vi.fn(), set: vi.fn(), query: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), close: vi.fn() },
      db: { get: vi.fn(), set: vi.fn(), query: vi.fn(), insert: vi.fn().mockResolvedValue(1), update: vi.fn(), delete: vi.fn(), close: vi.fn() },
      parsedConfig,
      configErrors: null,
      shutdown: vi.fn(),
    } as unknown as AppContext,
  };
}

// Mock fetch for VramManager
const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
vi.stubGlobal('fetch', mockFetch);

describe('RouterService', () => {
  let service: RouterService;
  let routerProvider: LlmProvider;
  let workerProvider: LlmProvider;
  let context: AppContext;
  let bus: MessageBus;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    routerProvider = createMockProvider(['[ROUTE:self] Natürlich, öffne ich sofort!']);
    workerProvider = createMockProvider(['Alles klar, ich kümmere mich darum!']);
    const mock = createMockContext();
    context = mock.context;
    bus = mock.bus;
    service = new RouterService(context, routerProvider, workerProvider);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has id "router"', () => {
    expect(service.id).toBe('router');
  });

  it('subscribes to chat:message', () => {
    expect(service.subscriptions).toContain('chat:message');
  });

  it('status is running after init when router provider available', async () => {
    await service.init();
    expect(service.status).toBe('running');
  });

  it('status is error after init when router provider not available', async () => {
    (routerProvider.isAvailable as any).mockResolvedValue(false);
    await service.init();
    expect(service.status).toBe('error');
  });

  describe('routing to self', () => {
    it('emits feedback directly when 2B routes to self', async () => {
      await service.init();

      const dones: string[] = [];
      bus.on('llm:done', (msg) => dones.push(msg.data.fullText as string));

      await service.handleChatMessage('Öffne Photoshop', 'chat');

      expect(dones).toEqual(['Natürlich, öffne ich sofort!']);
    });

    it('stores user and assistant messages in db', async () => {
      await service.init();
      await service.handleChatMessage('Hallo', 'chat');

      const insertCalls = (context.db.insert as any).mock.calls;
      expect(insertCalls.length).toBe(2);
      expect(insertCalls[0][1].role).toBe('user');
      expect(insertCalls[1][1].role).toBe('assistant');
    });
  });

  describe('routing to 9b', () => {
    beforeEach(() => {
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const text = '[ROUTE:9b] Oh das muss ich mir genauer ansehen.';
          onChunk(text);
          return text;
        },
      );
    });

    it('emits routing feedback then worker response', async () => {
      await service.init();

      const dones: string[] = [];
      bus.on('llm:done', (msg) => dones.push(msg.data.fullText as string));

      await service.handleChatMessage('Sortiere meine PDFs', 'chat');

      // First done: router feedback, Second done: worker response
      expect(dones[0]).toBe('Oh das muss ich mir genauer ansehen.');
      expect(dones[1]).toBe('Alles klar, ich kümmere mich darum!');
    });

    it('emits llm:routing event', async () => {
      await service.init();

      const routings: any[] = [];
      bus.on('llm:routing', (msg) => routings.push(msg.data));

      await service.handleChatMessage('Sortiere meine PDFs', 'chat');

      expect(routings[0]).toEqual({
        from: '2b',
        to: '9b',
        feedback: 'Oh das muss ich mir genauer ansehen.',
      });
    });

    it('sets activeModel to 9b after routing', async () => {
      await service.init();
      await service.handleChatMessage('Sortiere meine PDFs', 'chat');

      expect(service.activeModel).toBe('9b');
    });

    it('sends directly to 9b when activeModel is 9b', async () => {
      await service.init();

      // First message: route to 9B
      await service.handleChatMessage('Sortiere meine PDFs', 'chat');
      expect(service.activeModel).toBe('9b');

      // Reset mocks for second call
      const workerChatSpy = workerProvider.chat as ReturnType<typeof vi.fn>;
      workerChatSpy.mockClear();

      // Second message: should go directly to 9B, no routing call
      await service.handleChatMessage('Und benenne sie um', 'chat');

      expect(workerChatSpy).toHaveBeenCalledTimes(1);
      // Router should NOT have been called for the second message
      const routerCallCount = (routerProvider.chat as ReturnType<typeof vi.fn>).mock.calls.length;
      // routerProvider.chat was called once (first message routing), not again for second
      expect(routerCallCount).toBe(1);
    });
  });

  describe('no-tag fallback', () => {
    it('treats response without tag as self', async () => {
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const text = 'Klar, mache ich!';
          onChunk(text);
          return text;
        },
      );

      await service.init();

      const dones: string[] = [];
      bus.on('llm:done', (msg) => dones.push(msg.data.fullText as string));

      await service.handleChatMessage('Hallo', 'chat');

      expect(dones).toEqual(['Klar, mache ich!']);
    });
  });

  describe('idle timer', () => {
    it('swaps back to 2b after idle timeout', async () => {
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const text = '[ROUTE:9b] Moment.';
          onChunk(text);
          return text;
        },
      );

      await service.init();
      await service.handleChatMessage('Sortiere PDFs', 'chat');
      expect(service.activeModel).toBe('9b');

      // Advance past idle timeout (5 minutes)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

      expect(service.activeModel).toBe('2b');
    });

    it('resets idle timer on new message', async () => {
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const text = '[ROUTE:9b] Moment.';
          onChunk(text);
          return text;
        },
      );

      await service.init();
      await service.handleChatMessage('Sortiere PDFs', 'chat');

      // Advance 4 minutes
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(service.activeModel).toBe('9b');

      // Send another message — resets timer
      await service.handleChatMessage('Weiter sortieren', 'chat');

      // Advance another 4 minutes — should still be 9b
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(service.activeModel).toBe('9b');

      // Advance to full 5 min after last message
      await vi.advanceTimersByTimeAsync(1 * 60 * 1000 + 100);
      expect(service.activeModel).toBe('2b');
    });
  });

  describe('error handling', () => {
    it('emits llm:error when router provider throws', async () => {
      (routerProvider.chat as any).mockRejectedValue(new Error('connection lost'));
      await service.init();

      const errors: string[] = [];
      bus.on('llm:error', (msg) => errors.push(msg.data.message as string));

      await service.handleChatMessage('Hallo', 'chat');

      expect(errors.length).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/llm/router-service.test.ts 2>&1 | tail -10`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement router-service.ts**

Create `src/services/llm/router-service.ts`:

```typescript
// src/services/llm/router-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { buildRoutingPrompt } from './routing-prompt.js';
import { parseRouteTag } from './route-parser.js';
import { VramManager } from './vram-manager.js';
import { NUM_PREDICT_MAP } from './llm-types.js';

const STREAM_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONTEXT_TOKENS = 120_000;
const CHARS_PER_TOKEN = 4;

const ERROR_MESSAGES: Record<string, string> = {
  unavailable: 'Sarah träumt noch... Einen Moment.',
  timeout: 'Sarah hat den Faden verloren... Versuch es nochmal.',
  connection: 'Sarah ist kurz weggedriftet. Einen Moment...',
};

export class RouterService implements SarahService {
  readonly id = 'router';
  readonly subscriptions = ['chat:message'] as const;
  status: ServiceStatus = 'pending';
  activeModel: '2b' | '9b' = '2b';

  private history: ChatMessage[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private vramManager: VramManager;

  constructor(
    private context: AppContext,
    private routerProvider: LlmProvider,
    private workerProvider: LlmProvider,
  ) {
    this.vramManager = new VramManager(context.parsedConfig.llm.baseUrl);
  }

  async init(): Promise<void> {
    const available = await this.routerProvider.isAvailable();
    if (!available) {
      this.status = 'error';
      return;
    }
    this.status = 'running';
  }

  async destroy(): Promise<void> {
    this.clearIdleTimer();
    this.history = [];
    this.status = 'stopped';
  }

  onMessage(msg: TypedBusMessage): void {
    if (msg.topic === 'chat:message') {
      const { text, mode } = msg.data;
      this.handleChatMessage(text, mode).catch(() => {
        this.context.bus.emit(this.id, 'llm:error', {
          message: ERROR_MESSAGES.connection,
        });
      });
    }
  }

  async handleChatMessage(text: string, mode: 'chat' | 'voice' = 'chat'): Promise<void> {
    if (this.status !== 'running') {
      this.context.bus.emit(this.id, 'llm:error', {
        message: ERROR_MESSAGES.unavailable,
      });
      return;
    }

    // Store user message
    const userMsg: ChatMessage = { role: 'user', content: text };
    this.history.push(userMsg);
    await this.context.db.insert('messages', {
      conversation_id: 1,
      role: 'user',
      content: text,
    });

    // If 9B is active, send directly to worker — skip routing
    if (this.activeModel === '9b') {
      this.resetIdleTimer();
      await this.sendToWorker(text, mode);
      return;
    }

    // Route via 2B
    await this.routeViaRouter(text, mode);
  }

  private async routeViaRouter(text: string, mode: 'chat' | 'voice'): Promise<void> {
    try {
      // Ask 2B for routing decision
      const routingPrompt = buildRoutingPrompt();
      const routingMessages: ChatMessage[] = [
        { role: 'system', content: routingPrompt },
        { role: 'user', content: text },
      ];

      const routerResponse = await this.chatWithTimeout(
        this.routerProvider,
        routingMessages,
        () => {}, // No streaming for routing call
      );

      const { route, feedback } = parseRouteTag(routerResponse);

      if (!feedback.match(/^\[ROUTE:/)) {
        console.log(`[Router] No route tag detected, falling back to self`);
      }

      if (route === 'self') {
        // 2B handles it — emit feedback as the response
        this.context.bus.emit(this.id, 'llm:chunk', { text: feedback });
        this.context.bus.emit(this.id, 'llm:done', { fullText: feedback });

        this.history.push({ role: 'assistant', content: feedback });
        await this.context.db.insert('messages', {
          conversation_id: 1,
          role: 'assistant',
          content: feedback,
        });
      } else if (route === '9b') {
        // Emit feedback immediately
        this.context.bus.emit(this.id, 'llm:chunk', { text: feedback });
        this.context.bus.emit(this.id, 'llm:done', { fullText: feedback });
        this.context.bus.emit(this.id, 'llm:routing', {
          from: '2b',
          to: '9b',
          feedback,
        });

        // Swap to 9B
        const { routerModel } = this.context.parsedConfig.llm;
        this.context.bus.emit(this.id, 'llm:model-swap', {
          unloading: routerModel,
          loading: this.context.parsedConfig.llm.workerModel,
        });
        await this.vramManager.swapModels(routerModel, this.context.parsedConfig.llm.workerModel);
        this.activeModel = '9b';
        this.resetIdleTimer();

        // Send original message to 9B
        await this.sendToWorker(text, mode);
      } else {
        // Future routes (backend, extern, vision) — fallback to 9b for now
        this.context.bus.emit(this.id, 'llm:chunk', { text: feedback });
        this.context.bus.emit(this.id, 'llm:done', { fullText: feedback });
        this.context.bus.emit(this.id, 'llm:routing', {
          from: '2b',
          to: route,
          feedback,
        });

        // Route to 9B as fallback since other tiers aren't available yet
        const { routerModel } = this.context.parsedConfig.llm;
        await this.vramManager.swapModels(routerModel, this.context.parsedConfig.llm.workerModel);
        this.activeModel = '9b';
        this.resetIdleTimer();
        await this.sendToWorker(text, mode);
      }
    } catch (err) {
      const errorKey =
        err instanceof Error && err.message === 'timeout'
          ? 'timeout'
          : 'connection';
      this.context.bus.emit(this.id, 'llm:error', {
        message: ERROR_MESSAGES[errorKey],
      });
    }
  }

  private async sendToWorker(text: string, mode: 'chat' | 'voice'): Promise<void> {
    const systemPrompt = buildSystemPrompt(this.context.parsedConfig, mode);
    const messages = this.buildMessages(systemPrompt);

    const responseStyle = this.context.parsedConfig.personalization.responseStyle;
    const numPredict = NUM_PREDICT_MAP[responseStyle] ?? NUM_PREDICT_MAP.mittel;

    try {
      const fullText = await this.chatWithTimeout(
        this.workerProvider,
        messages,
        (chunk) => {
          this.context.bus.emit(this.id, 'llm:chunk', { text: chunk });
        },
        { num_predict: numPredict },
      );

      this.history.push({ role: 'assistant', content: fullText });
      await this.context.db.insert('messages', {
        conversation_id: 1,
        role: 'assistant',
        content: fullText,
      });

      this.context.bus.emit(this.id, 'llm:done', { fullText });
    } catch (err) {
      const errorKey =
        err instanceof Error && err.message === 'timeout'
          ? 'timeout'
          : 'connection';
      this.context.bus.emit(this.id, 'llm:error', {
        message: ERROR_MESSAGES[errorKey],
      });
    }
  }

  private async chatWithTimeout(
    provider: LlmProvider,
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    options?: { num_predict?: number },
  ): Promise<string> {
    let timeoutId: ReturnType<typeof setTimeout>;
    let rejectTimeout: (err: Error) => void;

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
      timeoutId = setTimeout(
        () => reject(new Error('timeout')),
        STREAM_TIMEOUT_MS,
      );
    });

    const chatPromise = provider.chat(messages, (chunk) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(
        () => rejectTimeout(new Error('timeout')),
        STREAM_TIMEOUT_MS,
      );
      onChunk(chunk);
    }, options);

    const result = await Promise.race([chatPromise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  }

  private buildMessages(systemPrompt: string): ChatMessage[] {
    const system: ChatMessage = { role: 'system', content: systemPrompt };
    const systemTokens = this.estimateTokens(systemPrompt);
    const budget = MAX_CONTEXT_TOKENS - systemTokens;

    const trimmed: ChatMessage[] = [];
    let usedTokens = 0;

    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      const tokens = this.estimateTokens(msg.content);
      if (usedTokens + tokens > budget) break;
      usedTokens += tokens;
      trimmed.unshift(msg);
    }

    return [system, ...trimmed];
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(async () => {
      if (this.activeModel === '9b') {
        const { workerModel } = this.context.parsedConfig.llm;
        await this.vramManager.unloadModel(workerModel);
        this.activeModel = '2b';
        console.log('[Router] Idle timeout — swapped back to 2B');
      }
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/services/llm/router-service.test.ts 2>&1 | tail -20`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/llm/router-service.ts tests/services/llm/router-service.test.ts
git commit -m "$(cat <<'EOF'
feat: add RouterService for dual-LLM routing

Central orchestrator that routes via 2B, delegates to 9B on-demand.
Includes VRAM swapping, idle timer, no-tag fallback, and conversation history.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wire RouterService in main.ts — Replace LlmService

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Update imports in main.ts**

In `src/main.ts`, replace the LlmService import (line 7) with RouterService:

```typescript
// Replace:
import { LlmService } from './services/llm/llm-service.js';

// With:
import { RouterService } from './services/llm/router-service.js';
```

- [ ] **Step 2: Update service registration in main.ts**

In `src/main.ts`, replace the LlmService instantiation (lines 190-194) with RouterService:

```typescript
  // Register Router service (replaces LlmService)
  const { llm: llmConfig } = appContext.parsedConfig;
  const routerProvider = new OllamaProvider(llmConfig.baseUrl, llmConfig.routerModel, llmConfig.options);
  const workerOptions = {
    ...llmConfig.options,
    num_ctx: llmConfig.workerOptions.num_ctx,
    num_gpu: llmConfig.workerOptions.num_gpu,
  };
  const workerProvider = new OllamaProvider(llmConfig.baseUrl, llmConfig.workerModel, workerOptions);
  const routerService = new RouterService(appContext, routerProvider, workerProvider);
  appContext.registry.register(routerService);
```

- [ ] **Step 3: Update any remaining references to llmService variable**

Search for any remaining references to `llmService` in `main.ts` and update them to `routerService`. If there are none beyond the registration, no changes needed.

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`

Expected: Clean — no type errors.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run 2>&1 | tail -20`

Expected: All non-SQLite tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "$(cat <<'EOF'
refactor: wire RouterService replacing LlmService in main bootstrap

Creates two OllamaProvider instances (router 2B + worker 9B) and
registers RouterService as the chat:message handler.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Update LlmService Tests — Ensure No Regressions

**Files:**
- Modify: `tests/services/llm/llm-service.test.ts`

The old `LlmService` is no longer wired up in main.ts but still exists as a module. Its tests should still pass since we didn't modify the class itself.

- [ ] **Step 1: Run existing LlmService tests**

Run: `npx vitest run tests/services/llm/llm-service.test.ts 2>&1 | tail -10`

Expected: All tests PASS (LlmService class unchanged).

- [ ] **Step 2: Run all tests**

Run: `npx vitest run 2>&1 | tail -20`

Expected: All non-SQLite tests PASS (including new router-service, route-parser, vram-manager tests).

- [ ] **Step 3: Commit (if any fixes needed)**

Only commit if fixes were required. Otherwise skip.

---

### Task 9: Final Verification — Build, Types, Tests

**Files:** None (verification only)

- [ ] **Step 1: Run full type check (main)**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`

Expected: Clean — no type errors.

- [ ] **Step 2: Run full type check (renderer)**

Run: `npx tsc --noEmit -p tsconfig.renderer.json 2>&1 | head -30`

Expected: Clean — no type errors.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run 2>&1 | tail -40`

Expected: All non-SQLite tests PASS.

- [ ] **Step 4: Verify build**

Run: `npm run build 2>&1 | tail -20`

Expected: Build succeeds.

- [ ] **Step 5: Commit any remaining fixes (if needed)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix: resolve build/test issues from dual-LLM routing

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```
