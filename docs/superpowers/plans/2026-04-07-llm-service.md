# LLM-Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sarah bekommt ein lokales Sprachmodell (Mistral Nemo 12B via Ollama) mit Streaming-Chat-UI.

**Architecture:** Provider-abstrahierter LLM-Service als SarahService, kommuniziert über MessageBus. OllamaProvider spricht REST-API. Chat-UI im Dashboard mit Default/Chatmode Toggle. Streaming über IPC.

**Tech Stack:** TypeScript, Electron IPC, Ollama REST API (localhost:11434), Three.js (bestehend)

---

## File Structure

**New files:**
- `src/services/llm/llm-provider.interface.ts` — Provider-Abstraktion + ChatMessage Type
- `src/services/llm/providers/ollama-provider.ts` — Ollama REST-API Client mit Streaming
- `src/services/llm/llm-service.ts` — SarahService Implementation, System-Prompt, Kontext-Management
- `src/renderer/dashboard/chat.ts` — Chat-UI Logik (Eingabe, Nachrichten, Chatmode Toggle)
- `styles/chat.css` — Chat-spezifische Styles
- `tests/services/llm/ollama-provider.test.ts` — Provider Tests
- `tests/services/llm/llm-service.test.ts` — Service Tests

**Modified files:**
- `src/main.ts` — LlmService registrieren, IPC-Handler für Chat + Streaming
- `src/preload.ts` — Chat-API exponieren (chat, onChatChunk, onChatDone, onChatError)
- `dashboard.html` — Eingabefeld, Chat-Container, Chatmode-Button
- `styles/dashboard.css` — Import chat.css
- `package.json` — esbuild Eintrag für chat.ts (falls nötig)
- `tsconfig.renderer.json` — chat.ts excludieren (esbuild-bundled)

---

### Task 1: Provider Interface + ChatMessage Type

**Files:**
- Create: `src/services/llm/llm-provider.interface.ts`

- [ ] **Step 1: Create provider interface file**

```typescript
// src/services/llm/llm-provider.interface.ts

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  /** Unique provider ID, e.g. 'ollama', 'claude', 'openai' */
  readonly id: string;

  /** Check if the provider is reachable and the model is available */
  isAvailable(): Promise<boolean>;

  /**
   * Send messages to the LLM and stream the response.
   * @param messages - Conversation history including system prompt
   * @param onChunk - Called for each streamed text chunk
   * @returns The complete response text
   */
  chat(
    messages: ChatMessage[],
    onChunk: (text: string) => void,
  ): Promise<string>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/llm/llm-provider.interface.ts
git commit -m "feat(llm): add provider interface and ChatMessage type"
```

---

### Task 2: OllamaProvider

**Files:**
- Create: `src/services/llm/providers/ollama-provider.ts`
- Test: `tests/services/llm/ollama-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/llm/ollama-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from '../../../src/services/llm/providers/ollama-provider';

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider('http://localhost:11434', 'mistral-nemo');
  });

  it('has id "ollama"', () => {
    expect(provider.id).toBe('ollama');
  });

  it('isAvailable returns false when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await provider.isAvailable();
    expect(result).toBe(false);
    vi.restoreAllMocks();
  });

  it('isAvailable returns false when model not in list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3:latest' }] }),
    } as Response);
    const result = await provider.isAvailable();
    expect(result).toBe(false);
    vi.restoreAllMocks();
  });

  it('isAvailable returns true when model found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'mistral-nemo:latest' }] }),
    } as Response);
    const result = await provider.isAvailable();
    expect(result).toBe(true);
    vi.restoreAllMocks();
  });

  it('chat streams chunks and returns full response', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      JSON.stringify({ message: { content: 'Hello' }, done: false }) + '\n',
      JSON.stringify({ message: { content: ' world' }, done: true }) + '\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      body: stream,
    } as Response);

    const received: string[] = [];
    const result = await provider.chat(
      [{ role: 'user', content: 'Hi' }],
      (text) => received.push(text),
    );

    expect(received).toEqual(['Hello', ' world']);
    expect(result).toBe('Hello world');
    vi.restoreAllMocks();
  });

  it('chat throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    await expect(
      provider.chat([{ role: 'user', content: 'Hi' }], () => {}),
    ).rejects.toThrow('Ollama error: 500 Internal Server Error');
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/llm/ollama-provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the OllamaProvider implementation**

```typescript
// src/services/llm/providers/ollama-provider.ts
import type { ChatMessage, LlmProvider } from '../llm-provider.interface.js';

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';

  constructor(
    private baseUrl: string,
    private model: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return false;
      const data = (await res.json()) as { models: { name: string }[] };
      return data.models.some((m) => m.name.startsWith(this.model));
    } catch {
      return false;
    }
  }

  async chat(
    messages: ChatMessage[],
    onChunk: (text: string) => void,
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as {
          message: { content: string };
          done: boolean;
        };
        const chunk = parsed.message.content;
        if (chunk) {
          fullText += chunk;
          onChunk(chunk);
        }
      }
    }

    return fullText;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/llm/ollama-provider.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/llm/providers/ollama-provider.ts tests/services/llm/ollama-provider.test.ts
git commit -m "feat(llm): add OllamaProvider with streaming support"
```

---

### Task 3: LlmService

**Files:**
- Create: `src/services/llm/llm-service.ts`
- Test: `tests/services/llm/llm-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/llm/llm-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmService } from '../../../src/services/llm/llm-service';
import type { LlmProvider, ChatMessage } from '../../../src/services/llm/llm-provider.interface';
import type { AppContext } from '../../../src/core/bootstrap';
import { MessageBus } from '../../../src/core/message-bus';

function createMockProvider(): LlmProvider {
  return {
    id: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    chat: vi.fn().mockImplementation(
      async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
        onChunk('Hello');
        onChunk(' Martin');
        return 'Hello Martin';
      },
    ),
  };
}

function createMockContext(): { context: AppContext; bus: MessageBus } {
  const bus = new MessageBus();
  return {
    bus,
    context: {
      bus,
      registry: {} as any,
      config: {
        get: vi.fn().mockResolvedValue({
          profile: {
            displayName: 'Martin',
            city: 'Berlin',
            profession: 'Developer',
            responseStyle: 'mittel',
            tone: 'freundlich',
          },
        }),
        set: vi.fn(),
        query: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        close: vi.fn(),
      },
      db: {
        get: vi.fn(),
        set: vi.fn(),
        query: vi.fn(),
        insert: vi.fn().mockResolvedValue(1),
        update: vi.fn(),
        delete: vi.fn(),
        close: vi.fn(),
      },
      shutdown: vi.fn(),
    } as unknown as AppContext,
  };
}

describe('LlmService', () => {
  let service: LlmService;
  let provider: LlmProvider;
  let context: AppContext;
  let bus: MessageBus;

  beforeEach(() => {
    provider = createMockProvider();
    const mock = createMockContext();
    context = mock.context;
    bus = mock.bus;
    service = new LlmService(context, provider);
  });

  it('has id "llm"', () => {
    expect(service.id).toBe('llm');
  });

  it('subscribes to chat:message', () => {
    expect(service.subscriptions).toContain('chat:message');
  });

  it('status is pending before init', () => {
    expect(service.status).toBe('pending');
  });

  it('status is running after init when provider available', async () => {
    await service.init();
    expect(service.status).toBe('running');
  });

  it('status is error after init when provider not available', async () => {
    (provider.isAvailable as any).mockResolvedValue(false);
    await service.init();
    expect(service.status).toBe('error');
  });

  it('builds system prompt from config', async () => {
    await service.init();

    const emitted: { topic: string; data: Record<string, unknown> }[] = [];
    bus.on('llm:done', (msg) => emitted.push(msg));

    await service.handleChatMessage('Hallo');

    const chatCall = (provider.chat as any).mock.calls[0];
    const systemMsg = chatCall[0][0] as ChatMessage;
    expect(systemMsg.role).toBe('system');
    expect(systemMsg.content).toContain('Martin');
    expect(systemMsg.content).toContain('Berlin');
  });

  it('emits llm:chunk and llm:done on chat', async () => {
    await service.init();

    const chunks: string[] = [];
    const dones: string[] = [];
    bus.on('llm:chunk', (msg) => chunks.push(msg.data.text as string));
    bus.on('llm:done', (msg) => dones.push(msg.data.fullText as string));

    await service.handleChatMessage('Hallo');

    expect(chunks).toEqual(['Hello', ' Martin']);
    expect(dones).toEqual(['Hello Martin']);
  });

  it('emits llm:error when provider throws', async () => {
    (provider.chat as any).mockRejectedValue(new Error('connection lost'));
    await service.init();

    const errors: string[] = [];
    bus.on('llm:error', (msg) => errors.push(msg.data.message as string));

    await service.handleChatMessage('Hallo');

    expect(errors.length).toBe(1);
    expect(errors[0]).toBe('Sarah ist kurz weggedriftet. Einen Moment...');
  });

  it('stores messages in db', async () => {
    await service.init();
    await service.handleChatMessage('Hallo');

    const insertCalls = (context.db.insert as any).mock.calls;
    // User message + assistant message = 2 inserts
    expect(insertCalls.length).toBe(2);
    expect(insertCalls[0][0]).toBe('messages');
    expect(insertCalls[0][1].role).toBe('user');
    expect(insertCalls[1][0]).toBe('messages');
    expect(insertCalls[1][1].role).toBe('assistant');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/llm/llm-service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the LlmService implementation**

```typescript
// src/services/llm/llm-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { BusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';

const MAX_CONTEXT_TOKENS = 120_000;
const CHARS_PER_TOKEN = 4;
const STREAM_TIMEOUT_MS = 30_000;

const ERROR_MESSAGES: Record<string, string> = {
  unavailable: 'Sarah träumt noch... Einen Moment.',
  'no-model': 'Sarah fehlen gerade die Worte.',
  timeout: 'Sarah hat den Faden verloren... Versuch es nochmal.',
  connection: 'Sarah ist kurz weggedriftet. Einen Moment...',
};

export class LlmService implements SarahService {
  readonly id = 'llm';
  readonly subscriptions = ['chat:message'];
  status: ServiceStatus = 'pending';

  private history: ChatMessage[] = [];
  private systemPrompt = '';

  constructor(
    private context: AppContext,
    private provider: LlmProvider,
  ) {}

  async init(): Promise<void> {
    const available = await this.provider.isAvailable();
    if (!available) {
      this.status = 'error';
      return;
    }
    this.systemPrompt = await this.buildSystemPrompt();
    this.status = 'running';
  }

  async destroy(): Promise<void> {
    this.history = [];
    this.status = 'stopped';
  }

  onMessage(msg: BusMessage): void {
    if (msg.topic === 'chat:message') {
      const text = msg.data.text as string;
      this.handleChatMessage(text);
    }
  }

  async handleChatMessage(text: string): Promise<void> {
    if (this.status !== 'running') {
      this.context.bus.emit(this.id, 'llm:error', {
        message: ERROR_MESSAGES.unavailable,
      });
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: text };
    this.history.push(userMsg);

    await this.context.db.insert('messages', {
      conversation_id: 1,
      role: 'user',
      content: text,
    });

    const messages = this.buildMessages();

    try {
      let fullText = '';
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), STREAM_TIMEOUT_MS);
      });

      const chatPromise = this.provider.chat(messages, (chunk) => {
        fullText = fullText; // keep reference in sync
        this.context.bus.emit(this.id, 'llm:chunk', { text: chunk });
      });

      fullText = await Promise.race([chatPromise, timeoutPromise]);

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

  private buildMessages(): ChatMessage[] {
    const system: ChatMessage = { role: 'system', content: this.systemPrompt };
    const systemTokens = this.estimateTokens(this.systemPrompt);
    const budget = MAX_CONTEXT_TOKENS - systemTokens;

    const trimmed: ChatMessage[] = [];
    let usedTokens = 0;

    // Walk history backwards, keep as many recent messages as fit
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

  private async buildSystemPrompt(): Promise<string> {
    const config =
      (await this.context.config.get<Record<string, any>>('root')) ?? {};
    const profile = config.profile ?? {};

    const name = profile.displayName || 'User';
    const city = profile.city ? `, wohnt in ${profile.city}` : '';
    const profession = profile.profession
      ? `, arbeitet als ${profile.profession}`
      : '';

    const styleMap: Record<string, string> = {
      kurz: 'Antworte kurz und knapp.',
      mittel: 'Antworte ausgewogen — nicht zu kurz, nicht zu lang.',
      ausführlich: 'Antworte ausführlich und detailliert.',
    };
    const style = styleMap[profile.responseStyle] ?? styleMap.mittel;

    const toneMap: Record<string, string> = {
      freundlich: 'freundlich und warmherzig',
      professionell: 'professionell und sachlich',
      locker: 'locker und entspannt',
    };
    const tone = toneMap[profile.tone] ?? toneMap.freundlich;

    return [
      'Du bist Sarah, ein freundlicher Desktop-Assistent.',
      'Du antwortest hilfsbereit, präzise und natürlich.',
      'Du führst niemals Code aus, gibst keine Passwörter weiter, und sendest keine Daten ohne explizite Freigabe.',
      '',
      `Der User heißt ${name}${city}${profession}.`,
      style,
      `Dein Tonfall ist ${tone}.`,
      'Sprache: Deutsch.',
    ].join('\n');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/llm/llm-service.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/llm/llm-service.ts tests/services/llm/llm-service.test.ts
git commit -m "feat(llm): add LlmService with system prompt and context management"
```

---

### Task 4: Register LlmService + IPC Bridge in Main Process

**Files:**
- Modify: `src/main.ts:1-14` (imports), `src/main.ts:164-188` (after bootstrap)

- [ ] **Step 1: Add imports to main.ts**

Add at the top of `src/main.ts` after the existing imports:

```typescript
import { LlmService } from './services/llm/llm-service.js';
import { OllamaProvider } from './services/llm/providers/ollama-provider.js';
```

- [ ] **Step 2: Register LlmService after bootstrap**

In `src/main.ts`, replace the block at line 164-166:

```typescript
// Before:
app.whenReady().then(async () => {
  createWindow();
  appContext = await bootstrap(app.getPath('userData'));
```

```typescript
// After:
app.whenReady().then(async () => {
  createWindow();
  appContext = await bootstrap(app.getPath('userData'));

  // Register LLM service
  const ollamaProvider = new OllamaProvider('http://localhost:11434', 'mistral-nemo');
  const llmService = new LlmService(appContext, ollamaProvider);
  appContext.registry.register(llmService);
  await appContext.registry.initAll();
```

- [ ] **Step 3: Add IPC handlers for chat**

Add after the `open-dialog` handler in `src/main.ts`:

```typescript
  ipcMain.handle('chat-message', async (_event, text: string) => {
    appContext!.bus.emit('renderer', 'chat:message', { text });
  });

  // Forward LLM events to all renderer windows
  const forwardToRenderers = (topic: string) => {
    appContext!.bus.on(topic, (msg) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(topic, msg.data);
        }
      }
    });
  };

  forwardToRenderers('llm:chunk');
  forwardToRenderers('llm:done');
  forwardToRenderers('llm:error');
```

- [ ] **Step 4: Build and verify no compile errors**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(llm): register LlmService and add chat IPC handlers"
```

---

### Task 5: Preload — Chat API

**Files:**
- Modify: `src/preload.ts`

- [ ] **Step 1: Add chat methods to preload**

Replace the contents of `src/preload.ts`:

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sarah', {
  version: process.versions.electron,
  splashDone: () => ipcRenderer.send('splash-done'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('save-config', config),
  isFirstRun: () => ipcRenderer.invoke('is-first-run'),
  selectFolder: (title?: string) => ipcRenderer.invoke('select-folder', title),
  detectPrograms: () => ipcRenderer.invoke('detect-programs'),
  scanFolderExes: (folderPath: string) => ipcRenderer.invoke('scan-folder-exes', folderPath),
  openDialog: (view: string) => ipcRenderer.invoke('open-dialog', view),

  // Chat API
  chat: (message: string) => ipcRenderer.invoke('chat-message', message),
  onChatChunk: (callback: (data: { text: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { text: string }) => callback(data);
    ipcRenderer.on('llm:chunk', handler);
    return () => ipcRenderer.removeListener('llm:chunk', handler);
  },
  onChatDone: (callback: (data: { fullText: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { fullText: string }) => callback(data);
    ipcRenderer.on('llm:done', handler);
    return () => ipcRenderer.removeListener('llm:done', handler);
  },
  onChatError: (callback: (data: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
    ipcRenderer.on('llm:error', handler);
    return () => ipcRenderer.removeListener('llm:error', handler);
  },
});
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/preload.ts
git commit -m "feat(llm): expose chat API in preload"
```

---

### Task 6: Chat-UI — HTML + CSS

**Files:**
- Modify: `dashboard.html`
- Create: `styles/chat.css`
- Modify: `styles/dashboard.css`

- [ ] **Step 1: Add chat elements to dashboard.html**

Replace the `app-main` div in `dashboard.html`:

```html
      <div class="app-main" id="sarah-area">
        <div class="sarah-orb-wrapper" id="sarah-orb-wrapper">
          <div id="sarah-orb-3d" style="width: 100%; height: 100%;"></div>
        </div>
        <div class="chat-container" id="chat-container">
          <div class="chat-messages" id="chat-messages"></div>
        </div>
        <div class="chat-input-bar" id="chat-input-bar">
          <button class="chat-mode-toggle" id="chat-mode-toggle" title="Chat-Modus">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>
          <input type="text" class="chat-input" id="chat-input" placeholder="Nachricht an Sarah..." autocomplete="off" />
        </div>
      </div>
```

- [ ] **Step 2: Create chat.css**

```css
/* styles/chat.css */

/* ── Chat layout ── */
.sarah-orb-wrapper {
  flex: 1;
  min-height: 0;
  position: relative;
}

.app-main {
  display: flex;
  flex-direction: column;
}

.chat-container {
  display: none;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sarah-space-md);
}

.chat-container.visible {
  display: flex;
  flex-direction: column;
}

/* In chatmode: orb shrinks, chat appears */
.app-main.chatmode .sarah-orb-wrapper {
  flex: 0 0 30%;
}

.app-main.chatmode .chat-container {
  display: flex;
  flex-direction: column;
  flex: 0 0 70%;
}

/* ── Messages ── */
.chat-messages {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--sarah-space-sm);
  overflow-y: auto;
  padding-bottom: var(--sarah-space-sm);
}

.chat-bubble {
  max-width: 85%;
  padding: var(--sarah-space-sm) var(--sarah-space-md);
  border-radius: var(--sarah-radius-lg);
  font-size: var(--sarah-font-size-sm);
  line-height: 1.5;
  word-wrap: break-word;
}

.chat-bubble.user {
  align-self: flex-end;
  background: rgba(var(--sarah-accent-rgb), 0.15);
  color: var(--sarah-text-primary);
}

.chat-bubble.assistant {
  align-self: flex-start;
  background: var(--sarah-bg-surface);
  color: var(--sarah-text-primary);
}

.chat-bubble.error {
  align-self: center;
  background: none;
  color: var(--sarah-text-muted);
  font-style: italic;
  font-size: var(--sarah-font-size-xs);
}

/* ── Input bar ── */
.chat-input-bar {
  display: flex;
  align-items: center;
  gap: var(--sarah-space-xs);
  padding: var(--sarah-space-xs) var(--sarah-space-sm);
  border-top: 1px solid var(--sarah-border);
}

.chat-input {
  flex: 1;
  background: var(--sarah-bg-surface);
  border: 1px solid var(--sarah-border);
  border-radius: var(--sarah-radius-md);
  padding: var(--sarah-space-xs) var(--sarah-space-sm);
  color: var(--sarah-text-primary);
  font-size: var(--sarah-font-size-sm);
  outline: none;
  font-family: inherit;
}

.chat-input:focus {
  border-color: var(--sarah-accent);
}

.chat-input::placeholder {
  color: var(--sarah-text-muted);
}

.chat-mode-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  color: var(--sarah-text-secondary);
  cursor: pointer;
  border-radius: var(--sarah-radius-sm);
  transition: all var(--sarah-transition-fast);
}

.chat-mode-toggle:hover {
  color: var(--sarah-text-primary);
  background: var(--sarah-bg-surface-hover);
}

.app-main.chatmode .chat-mode-toggle {
  color: var(--sarah-accent);
}
```

- [ ] **Step 3: Import chat.css in dashboard.css**

Add at the top of `styles/dashboard.css` after the base import:

```css
@import url('./base.css');
@import url('./chat.css');
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add dashboard.html styles/chat.css styles/dashboard.css
git commit -m "feat(chat): add chat HTML structure and CSS"
```

---

### Task 7: Chat-UI — JavaScript Logic

**Files:**
- Modify: `src/renderer/dashboard/dashboard.ts`

- [ ] **Step 1: Add chat logic to dashboard.ts**

Add the following at the end of `src/renderer/dashboard/dashboard.ts`:

```typescript
// ── Chat ──
declare const sarah: {
  version: string;
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  selectFolder: (title?: string) => Promise<string | null>;
  openDialog: (view: string) => Promise<void>;
  chat: (message: string) => Promise<void>;
  onChatChunk: (cb: (data: { text: string }) => void) => () => void;
  onChatDone: (cb: (data: { fullText: string }) => void) => () => void;
  onChatError: (cb: (data: { message: string }) => void) => () => void;
};
```

Wait — the `declare const sarah` block already exists at the top of dashboard.ts. We need to update it and add the chat logic.

Replace the full `src/renderer/dashboard/dashboard.ts`:

```typescript
import { registerComponents } from '../components/index.js';
import { applyAccentColor } from './accent.js';

declare const sarah: {
  version: string;
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  selectFolder: (title?: string) => Promise<string | null>;
  openDialog: (view: string) => Promise<void>;
  chat: (message: string) => Promise<void>;
  onChatChunk: (cb: (data: { text: string }) => void) => () => void;
  onChatDone: (cb: (data: { fullText: string }) => void) => () => void;
  onChatError: (cb: (data: { message: string }) => void) => () => void;
};

(window as any).__sarah = sarah;

registerComponents();

// Apply saved accent color on load
sarah.getConfig().then((config: any) => {
  const color = config.personalization?.accentColor;
  if (color && color !== '#00d4ff') {
    applyAccentColor(color);
  }
});

// Nav buttons open separate windows
const navButtons = document.querySelectorAll<HTMLButtonElement>('.nav-item');

navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view!;
    if (view !== 'sarah') {
      sarah.openDialog(view);
    }
  });
});

// ── Chat ──
const sarahArea = document.getElementById('sarah-area')!;
const chatMessages = document.getElementById('chat-messages')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatModeToggle = document.getElementById('chat-mode-toggle')!;

let chatMode = false;
let currentBubble: HTMLElement | null = null;

function addBubble(role: 'user' | 'assistant' | 'error', text: string): HTMLElement {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

// Toggle chat mode
chatModeToggle.addEventListener('click', () => {
  chatMode = !chatMode;
  sarahArea.classList.toggle('chatmode', chatMode);
  if (chatMode) {
    chatInput.focus();
  }
});

// Send message on Enter
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && chatInput.value.trim()) {
    const text = chatInput.value.trim();
    chatInput.value = '';

    // Auto-enter chatmode on first message
    if (!chatMode) {
      chatMode = true;
      sarahArea.classList.add('chatmode');
    }

    addBubble('user', text);
    currentBubble = addBubble('assistant', '');
    sarah.chat(text);
  }
});

// Streaming chunks
sarah.onChatChunk((data) => {
  if (currentBubble) {
    currentBubble.textContent += data.text;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
});

// Done
sarah.onChatDone(() => {
  currentBubble = null;
});

// Error
sarah.onChatError((data) => {
  if (currentBubble) {
    currentBubble.remove();
    currentBubble = null;
  }
  addBubble('error', data.message);
});
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/renderer/dashboard/dashboard.ts
git commit -m "feat(chat): add chat logic with streaming and chatmode toggle"
```

---

### Task 8: Integration Test — End to End

**Files:** No new files — manual test with running Ollama.

- [ ] **Step 1: Verify Ollama is running**

Run: `curl http://localhost:11434/api/tags`
Expected: JSON response listing models including `mistral-nemo`

- [ ] **Step 2: Build the app**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Start the app**

Run: `npm start`
Expected: App starts, splash screen, then dashboard with orb

- [ ] **Step 4: Test chat**

1. Type a message in the input field, press Enter
2. Chat mode activates — orb shrinks to 30%, chat appears
3. Sarah's response streams in word by word
4. Click chat mode toggle to go back to orb-only view

- [ ] **Step 5: Test error handling**

1. Stop Ollama (`taskkill /f /im ollama.exe` or close the app)
2. Send a message
3. Expected: Error bubble with "Sarah ist kurz weggedriftet. Einen Moment..."

- [ ] **Step 6: Run all unit tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat(llm): complete LLM service integration with streaming chat"
```
