# Dual-LLM Routing — Design Spec

## Goal

Replace the single-LLM architecture with a 2B Router + 9B Worker system. The 2B model acts as always-on central router that handles simple tasks itself and delegates complex tasks to the 9B model (on-demand loaded). Every model gives immediate human feedback before routing or working.

## Architecture Overview

```
                  ┌→ 2B self (greetings, programs, scheduling)
User → 2B Router ─├→ 9B Worker (conversations, sorting, medium tasks)
                  ├→ Backend 40B (deepsearch, planning) [future]
                  ├→ Vision 4-7B (image analysis) [future]
                  └→ Extern APIs (Claude, Codex, DALL-E) [future]
```

**This spec covers only 2B + 9B.** The architecture is designed so Backend, Vision, and Extern tiers can be added later without restructuring.

## Models

| Role   | Model       | Quantization | VRAM   | Context                  | Behavior                        |
| ------ | ----------- | ------------ | ------ | ------------------------ | ------------------------------- |
| Router | Qwen 3.5:2B | Q4_K_M       | ~3-4GB | default (Ollama manages) | always-on, lightweight          |
| Worker | Qwen 3.5:9B | Q3_K_M       | ~6-7GB | 8192                     | on-demand, `num_gpu` controlled |

### VRAM Management (RTX 3050, 8GB)

2B and 9B **cannot run simultaneously** on 8GB VRAM. Strategy:

1. **2B always-on** — loaded at app start, stays in memory
2. **9B on-demand** — when 2B routes to 9B:
   - Unload 2B: `POST /api/generate { model: "qwen3.5:2b", keep_alive: "0" }`
   - Load 9B: first request to 9B triggers Ollama auto-load
3. **9B stays active** — once loaded, 9B handles all subsequent messages directly (no 2B routing call)
4. **9B idle timeout** — after 5 minutes of no user message, RouterService unloads 9B and reloads 2B:
   - Unload 9B: `POST /api/generate { model: "qwen3.5:9b", keep_alive: "0" }`
   - Load 2B: first routing call to 2B triggers Ollama auto-load
5. **Verify via** `GET /api/ps` (shows loaded models + `size_vram`)

## Routing

### How It Works

The 2B receives every user message first. It gets a **routing system prompt** that tells it:

- What it can handle itself (greetings, opening programs, scheduling, simple questions)
- What the 9B handles (conversations, sorting, medium complexity tasks)
- What Backend handles (deepsearch, planning, coding) [future]
- What Extern handles (coding via Claude/Codex, image generation) [future]

The 2B responds with a **route tag** + **human feedback message**:

```
[ROUTE:self] Natürlich, öffne ich sofort!
[ROUTE:9b] Oh das muss ich mir genauer ansehen.
[ROUTE:backend] Ich sehe mir das an, das dauert einen Moment.
```

The RouterService parses the tag, emits the feedback to the user immediately, then routes the **original user message** to the target model.

### Route Tags

| Tag               | Target              | When                                         |
| ----------------- | ------------------- | -------------------------------------------- |
| `[ROUTE:self]`    | 2B answers directly | Simple tasks within 2B capabilities          |
| `[ROUTE:9b]`      | 9B Worker           | Medium tasks, conversations, file operations |
| `[ROUTE:backend]` | Backend 40B         | Deepsearch, planning, large tasks [future]   |
| `[ROUTE:vision]`  | Vision model        | Image analysis [future]                      |
| `[ROUTE:extern]`  | External API        | Coding, image generation [future]            |

### 9B Escalation Fallback

The 9B can also escalate to Backend if it determines the task is too large:

```
9B receives task → evaluates scope → too complex
9B → User: "Das ist umfangreicher, ich sehe mir das genauer an."
9B → Bus: route to backend with original message
```

This is a **fallback**, not the normal flow. The 2B should correctly route most of the time.

### User Feedback

**Every model gives immediate human feedback.** The user always knows their message was received:

| Scenario          | Feedback to User                                                           |
| ----------------- | -------------------------------------------------------------------------- |
| 2B handles itself | "Natürlich, öffne das Programm!" (+ does the task)                         |
| 2B → 9B           | "Oh das muss ich mir genauer ansehen." (9B takes over)                     |
| 2B → Backend      | "Ich sehe mir das an, das dauert einen Moment." (Backend takes over)       |
| 9B handles itself | "Alles klar, ich kümmere mich darum!" (+ does the task)                    |
| 9B → Backend      | "Das ist umfangreicher, ich sehe mir das genauer an." (Backend takes over) |

## Components

### RouterService (new)

**File:** `src/services/llm/router-service.ts`

Replaces the current `LlmService` as the main subscriber to `chat:message`. Orchestrates the full routing flow.

**Responsibilities:**

- Subscribe to `chat:message` events
- Send user message to 2B with routing prompt
- Parse `[ROUTE:xxx]` tag from 2B response
- Emit feedback text to user immediately (`llm:chunk` / `llm:done`)
- If routed to another model: manage VRAM swap, forward original message
- Emit final response from target model

**State:**

- `activeModel: '2b' | '9b'` — tracks which model is currently loaded
- `idleTimer: NodeJS.Timeout | null` — reset on every `chat:message`; fires after 5 min to unload 9B and reload 2B
- When `activeModel === '9b'`: incoming `chat:message` goes directly to 9B, skipping the 2B routing call entirely
- Uses existing `MessageBus` for all communication

### OllamaProvider (modified)

**File:** `src/services/llm/providers/ollama-provider.ts`

The existing provider stays largely unchanged. The RouterService creates **two instances** with different model configs:

```typescript
const router2b = new OllamaProvider({
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.5:2b',
  options: { think: false },
});

const worker9b = new OllamaProvider({
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.5:9b',
  options: { think: false, num_ctx: 8192, num_gpu: 24 },
});
```

### Config Schema Changes

**File:** `src/core/config-schema.ts`

Extend `LlmSchema` to support multiple models:

```typescript
export const LlmSchema = z.object({
  baseUrl: z.string().default('http://localhost:11434'),
  routerModel: z.string().default('qwen3.5:2b'),
  workerModel: z.string().default('qwen3.5:9b'),
  workerOptions: z
    .object({
      num_ctx: z.number().default(8192),
      num_gpu: z.number().default(24),
    })
    .default({}),
  options: z
    .object({
      temperature: z.number().optional(),
      num_predict: z.number().optional(),
      num_ctx: z.number().optional(),
    })
    .default({}),
});
```

The old `model` field is replaced by `routerModel` + `workerModel`. Migration preprocess moves `model` → `routerModel`.

### Bus Events (new/modified)

**File:** `src/core/bus-events.ts`

```typescript
// Existing — unchanged (no mode field added, contract stays stable)
'chat:message'   → { text: string }
'llm:chunk'      → { text: string }
'llm:done'       → { fullText: string }
'llm:error'      → { message: string }

// New — routing metadata
'llm:routing'    → { from: '2b' | '9b'; to: 'self' | '9b' | 'backend' | 'extern'; feedback: string }
'llm:model-swap' → { loading: string; unloading: string }
```

### Routing Prompt (2B)

The 2B gets a specialized system prompt for routing decisions:

```
## IDENTITY
You are Sarah's routing brain. You receive user messages and decide who handles them.

## YOUR CAPABILITIES (handle yourself)
- Greetings, small talk openers
- Opening/closing programs
- Simple scheduling, reminders
- Quick factual answers

## ESCALATE TO 9B
- Longer conversations, storytelling
- File operations (sorting, renaming, organizing)
- Email drafting, summarizing
- Medium complexity research

## ESCALATE TO BACKEND [future]
- Deep research, multi-source analysis
- Project planning, complex reasoning
- Code generation, debugging

## ESCALATE TO EXTERN [future]
- Professional coding (Claude, Codex)
- Image generation (DALL-E)

## RESPONSE FORMAT
Always respond with a route tag followed by a short German feedback message:
[ROUTE:self] Your response here
[ROUTE:9b] Your feedback here
[ROUTE:backend] Your feedback here

## RULES
- Always respond in German
- Keep feedback short and natural
- When uncertain between self and 9b, choose 9b
- The feedback message is shown to the user immediately
```

### No-Tag Fallback

A 2B model may occasionally respond without a `[ROUTE:xxx]` tag (e.g. `"Klar, mache ich!"` without any tag). RouterService handles this explicitly:

- **Detection:** response contains no `[ROUTE:` prefix after stripping whitespace
- **Fallback:** treat as `[ROUTE:self]` — emit the full response as-is to the user
- **Log:** emit a warning to console so routing quality can be monitored during development
- **No retry:** retrying would add latency and may loop; self-handling is the safe default

### Conversation History

- **2B routing calls** are NOT stored in conversation history (they're routing decisions, not conversation)
- **Target model responses** (2B self-answers, 9B responses) ARE stored in history
- When 9B takes over, it receives the **full conversation history** so it has context
- History stays in `RouterService`, shared across models

## Message Flow Examples

### Example 1: 2B handles itself

```
1. User sends "Öffne Photoshop" → chat:message
2. RouterService receives → sends to 2B with routing prompt
3. 2B responds: "[ROUTE:self] Natürlich, öffne ich sofort!"
4. RouterService parses → route = self
5. RouterService emits feedback as llm:chunk/llm:done
6. (Program opening logic triggered separately)
```

### Example 2: Route to 9B

```
1. User sends "Sortiere meine PDFs im Download-Ordner" → chat:message
2. RouterService receives → activeModel === '2b' → sends to 2B with routing prompt
3. 2B responds: "[ROUTE:9b] Oh das muss ich mir genauer ansehen."
4. RouterService parses → route = 9b
5. RouterService emits feedback as llm:chunk/llm:done
6. RouterService emits llm:routing { from: '2b', to: '9b' }
7. RouterService swaps models: unload 2B, load 9B → activeModel = '9b'
8. RouterService starts idleTimer (5 min)
9. RouterService sends original message to 9B with full system prompt + history
10. 9B responds: "Alles klar, ich kümmere mich darum! ..." (streams via llm:chunk)
11. RouterService emits llm:done with 9B response
12. 9B stays loaded — next chat:message goes directly to 9B (step 2 skipped)
```

### Example 2b: idleTimer fires after 5 min silence

```
1. No chat:message for 5 minutes
2. RouterService idleTimer fires
3. Unload 9B: POST /api/generate { keep_alive: "0" }
4. activeModel = '2b'
5. Next chat:message goes to 2B router again
```

### Example 3: 9B escalates to Backend

```
1-7. Same as Example 2
8. 9B receives task, evaluates: "[ROUTE:backend] Das ist umfangreicher..."
9. RouterService emits 9B feedback to user
10. RouterService would route to Backend [future — for now, 9B handles it anyway]
11. Swap back to 2B
```

## LlmService Refactoring

The current `LlmService` becomes a thin wrapper or is replaced by `RouterService`:

- `LlmService.handleChatMessage()` logic moves to `RouterService`
- `LlmService` may remain as a utility for direct single-model calls (used by RouterService internally)
- Or `LlmService` is fully replaced — RouterService takes over the `chat:message` subscription

Decision: **Replace LlmService with RouterService.** The RouterService uses OllamaProvider instances directly. Less indirection.

## Testing Strategy

- **Unit tests:** RouterService route-tag parsing, VRAM swap logic, history management
- **Integration tests:** Full message flow with mocked OllamaProvider
- **Manual tests:** Actual Ollama with 2B model, verify routing decisions

## Future Extensibility

Adding a new tier (e.g., Backend) requires:

1. Add route tag to routing prompt
2. Add new OllamaProvider instance (or HttpProvider for remote)
3. Add handling in RouterService switch/match
4. Add VRAM management rules (if local model)

No architectural changes needed — just configuration and a new provider instance.

## Out of Scope

- Backend tier implementation (future)
- Vision model (future)
- External API integration (future)
- Performance-Profile UI (not needed — 2B runs unthrottled, 9B gets hardcoded num_gpu)
- Splash screen progress bar (separate feature)
