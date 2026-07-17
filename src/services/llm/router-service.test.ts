import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RouterService } from './router-service.js';
import { bootstrap } from '../../core/bootstrap.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import type { StorageProvider, Filter, MessageRow, MessagesPageQuery } from '../../core/storage/storage.interface.js';
import type { BusEvents } from '../../core/bus-events.js';
import { START_CONTEXT_HEADER } from './context-window.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

class FakeProvider implements LlmProvider {
  readonly id = 'fake';
  lastMessages: ChatMessage[] | null = null;
  constructor(private reply = 'Antwort von Sarah') {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(messages: ChatMessage[], onChunk: (text: string) => void): Promise<string> {
    this.lastMessages = messages;
    onChunk(this.reply);
    return this.reply;
  }
}

/** Delegating storage that fails selected operations — simulates a broken DB. */
class FailingStorage implements StorageProvider {
  constructor(
    private inner: StorageProvider,
    private opts: { failInsertTables?: string[]; failReads?: boolean } = {},
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.inner.get<T>(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    return this.inner.set(key, value);
  }
  async query<T = Record<string, unknown>>(table: string, filter?: Filter): Promise<T[]> {
    if (this.opts.failReads) throw new Error('disk I/O error');
    return this.inner.query<T>(table, filter);
  }
  async queryMessagesPage(query: MessagesPageQuery): Promise<MessageRow[]> {
    if (this.opts.failReads) throw new Error('disk I/O error');
    return this.inner.queryMessagesPage(query);
  }
  async insert(table: string, data: Record<string, unknown>): Promise<number> {
    if (this.opts.failInsertTables?.includes(table)) throw new Error('disk I/O error');
    return this.inner.insert(table, data);
  }
  async update(table: string, filter: Filter, data: Record<string, unknown>): Promise<number> {
    return this.inner.update(table, filter, data);
  }
  async delete(table: string, filter: Filter): Promise<number> {
    return this.inner.delete(table, filter);
  }
  async close(): Promise<void> {
    return this.inner.close();
  }
}

describe('RouterService (history & sessions)', () => {
  let tmpDir: string;
  let ctx: AppContext;
  let router: RouterService | null = null;
  let workerProvider: FakeProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-router-'));
    ctx = await bootstrap(tmpDir);
    workerProvider = new FakeProvider();
    router = null;
  });

  afterEach(async () => {
    await router?.destroy();
    await ctx.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRouter(context: AppContext): RouterService {
    router = new RouterService(context, new FakeProvider('warm'), workerProvider);
    return router;
  }

  /** Drives a full chat turn through the worker path (bypasses 2B routing). */
  async function chatTurn(r: RouterService, text: string): Promise<void> {
    r.activeModel = '9b';
    await r.handleChatMessage(text);
  }

  it('creates exactly one conversation per boot, even with a double init() call (H3)', async () => {
    const r = makeRouter(ctx);
    await Promise.all([r.init(), r.init()]);
    await r.init();

    const rows = await ctx.db.query('conversations');
    expect(rows).toHaveLength(1);
  });

  it('persists both turn messages under the boot session id, not the legacy id 1', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' }); // occupy id 1 (old session)
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Hallo Sarah');

    const msgs = await ctx.db.query<{ conversation_id: number; role: string; content: string }>('messages');
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.role).sort()).toEqual(['assistant', 'user']);
    for (const m of msgs) {
      expect(m.conversation_id).toBe(2);
    }
  });

  it('feeds the start context to the worker as a transient block, never persisting it (H5)', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' }); // old session, id 1
    await ctx.db.insert('messages', { conversation_id: 1, role: 'user', content: 'alte Frage' });
    await ctx.db.insert('messages', { conversation_id: 1, role: 'assistant', content: 'alte Antwort' });
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Neue Frage');

    const sent = workerProvider.lastMessages;
    expect(sent).not.toBeNull();
    expect(sent![0].role).toBe('system'); // main system prompt
    expect(sent![1]).toEqual({ role: 'system', content: START_CONTEXT_HEADER });
    expect(sent![2]).toEqual({ role: 'user', content: 'alte Frage' });
    expect(sent![3]).toEqual({ role: 'assistant', content: 'alte Antwort' });
    expect(sent![4]).toEqual({ role: 'user', content: 'Neue Frage' });

    // start context was NOT re-persisted: 2 old + 2 new turn messages only
    const msgs = await ctx.db.query('messages');
    expect(msgs).toHaveLength(4);
  });

  it('answers in-memory with exactly one visible warning when the session insert fails (H4)', async () => {
    const degradedCtx: AppContext = { ...ctx, db: new FailingStorage(ctx.db, { failInsertTables: ['conversations'] }) };
    const r = makeRouter(degradedCtx);
    await r.init();

    const warnings: string[] = [];
    const done: string[] = [];
    ctx.bus.on('storage:degraded', () => {
      warnings.push('w');
    });
    ctx.bus.on('llm:done', () => {
      done.push('d');
    });

    await chatTurn(r, 'Erste Frage');
    await chatTurn(r, 'Zweite Frage');

    expect(done).toHaveLength(2); // both answers arrived
    expect(warnings).toHaveLength(1); // warning exactly once
    expect(await ctx.db.query('messages')).toHaveLength(0); // inserts skipped
  });

  it('keeps the answer flowing when a message insert fails (H4)', async () => {
    const degradedCtx: AppContext = { ...ctx, db: new FailingStorage(ctx.db, { failInsertTables: ['messages'] }) };
    const r = makeRouter(degradedCtx);
    await r.init();

    const warnings: string[] = [];
    const done: string[] = [];
    ctx.bus.on('storage:degraded', () => {
      warnings.push('w');
    });
    ctx.bus.on('llm:done', () => {
      done.push('d');
    });

    await chatTurn(r, 'Frage trotz kaputter DB');
    await chatTurn(r, 'Noch eine');

    expect(done).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    // in-memory history stayed complete: second turn carried the first turn's messages
    const sent = workerProvider.lastMessages!;
    expect(sent.some((m) => m.content === 'Frage trotz kaputter DB')).toBe(true);
    expect(sent.some((m) => m.content === 'Antwort von Sarah')).toBe(true);
  });

  it('boots with an empty start context when DB reads fail, and still answers', async () => {
    const degradedCtx: AppContext = { ...ctx, db: new FailingStorage(ctx.db, { failReads: true }) };
    const r = makeRouter(degradedCtx);
    await r.init();

    const done: string[] = [];
    ctx.bus.on('llm:done', () => {
      done.push('d');
    });
    await chatTurn(r, 'Hallo');

    expect(done).toHaveLength(1);
    const sent = workerProvider.lastMessages!;
    expect(sent.some((m) => m.content === START_CONTEXT_HEADER)).toBe(false);
  });
});

/** Provider whose replies can be scripted per call (routing answers, worker answers). */
class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted';
  lastMessages: ChatMessage[] | null = null;
  private queue: string[];
  constructor(...replies: string[]) {
    this.queue = replies;
  }
  push(reply: string): void {
    this.queue.push(reply);
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(messages: ChatMessage[], onChunk: (t: string) => void): Promise<string> {
    this.lastMessages = messages;
    const reply = this.queue.shift() ?? 'leer';
    onChunk(reply);
    return reply;
  }
}

describe('RouterService (action layer)', () => {
  let tmpDir: string;
  let ctx: AppContext;
  let router: RouterService | null = null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-router-action-'));
    ctx = await bootstrap(tmpDir);
    router = null;
    // The test harness never registers RouterService with ctx.registry (that
    // wiring is ServiceRegistry's job in production, see main.ts). Forward the
    // two new correlation topics to whichever router the current test created.
    ctx.bus.on('action:result', (msg) => router?.onMessage(msg));
    ctx.bus.on('action:notify', (msg) => router?.onMessage(msg));
  });

  afterEach(async () => {
    await router?.destroy();
    await ctx.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits action:request with a fresh requestId and speaks the feedback', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:open_program:spotify] Ich öffne Spotify.'); // 1. Reply = warmup
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();

    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (msg) => {
      requests.push(msg.data);
    });
    ctx.bus.on('llm:done', (msg) => {
      done.push(msg.data.fullText);
    });

    await router.handleChatMessage('Öffne Spotify');

    expect(requests).toHaveLength(1);
    expect(requests[0].action).toBe('open_program');
    expect(requests[0].param).toBe('spotify');
    expect(requests[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(done).toEqual(['Ich öffne Spotify.']);
    const msgs = await ctx.db.query<{ role: string; content: string }>('messages');
    expect(msgs.map((m) => m.content)).toContain('Ich öffne Spotify.'); // feedback persisted as assistant turn
  });

  it('rejects unknown action names honestly and never emits action:request', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:send_all_data:evil] Klar.');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const requests: string[] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', () => {
      requests.push('x');
    });
    ctx.bus.on('llm:done', (msg) => {
      done.push(msg.data.fullText);
    });

    await router.handleChatMessage('mach was böses');

    expect(requests).toHaveLength(0);
    expect(done).toEqual(['Das kann ich noch nicht.']);
  });

  it('speaks an action:result with matching requestId, drops unknown/duplicate ids', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:web_search:hotels kiel] Ich schaue mal.');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const done: string[] = [];
    ctx.bus.on('llm:done', (msg) => {
      done.push(msg.data.fullText);
    });
    let requestId = '';
    ctx.bus.on('action:request', (msg) => {
      requestId = msg.data.requestId;
    });

    await router.handleChatMessage('Such Hotels in Kiel');
    ctx.bus.emit('test', 'action:result', { requestId, action: 'web_search', ok: true, speak: 'Drei Hotels gefunden.' });
    ctx.bus.emit('test', 'action:result', { requestId, action: 'web_search', ok: true, speak: 'Doppelt.' }); // duplicate → dropped
    ctx.bus.emit('test', 'action:result', {
      requestId: 'ffffffff-0000-0000-0000-000000000000',
      action: 'web_search',
      ok: true,
      speak: 'Fremd.',
    });
    await new Promise((r) => setTimeout(r, 20)); // let the output queue drain

    expect(done).toEqual(['Ich schaue mal.', 'Drei Hotels gefunden.']);
  });

  it('serializes late results against a running worker stream (no interleaved chunks)', async () => {
    const workerP = new ScriptedProvider('Lange Antwort vom Worker.');
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b] Moment.');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    const events: string[] = [];
    ctx.bus.on('llm:chunk', (msg) => {
      events.push('chunk:' + msg.data.text);
    });
    ctx.bus.on('llm:done', (msg) => {
      events.push('done:' + msg.data.fullText);
    });

    const turn = router.handleChatMessage('Erkläre etwas Langes');
    // result arrives while the worker turn is still in flight:
    ctx.bus.emit('test', 'action:notify', { speak: 'Dein Timer ist abgelaufen.' });
    await turn;
    await new Promise((r) => setTimeout(r, 20));

    const doneIdx = events.findIndex((e) => e.startsWith('done:Lange'));
    const notifyIdx = events.findIndex((e) => e === 'done:Dein Timer ist abgelaufen.');
    expect(doneIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(doneIdx); // notify strictly after the stream finished
  });

  it('heuristic gate: action command in 9B window swaps back and routes (R4-M1 state reset)', async () => {
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b] Moment.', '[ACTION:open_program:spotify] Ich öffne Spotify.');
    const workerP = new ScriptedProvider('Photosynthese ist …', 'sollte nie kommen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    const requests: string[] = [];
    ctx.bus.on('action:request', (msg) => {
      requests.push(msg.data.action);
    });

    await router.handleChatMessage('Erkläre mir Photosynthese'); // → 9B window
    expect(router.activeModel).toBe('9b');
    await router.handleChatMessage('Öffne Spotify'); // hint word → gate

    expect(requests).toEqual(['open_program']);
    expect(router.activeModel).toBe('2b'); // R4-M1: reset before routeAndRespond, self/action keeps it
  });

  it('heuristic gate: plain chat in 9B window goes straight to the worker', async () => {
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b] Moment.');
    const workerP = new ScriptedProvider('Erste Antwort.', 'Zweite Antwort.');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();

    await router.handleChatMessage('Erkläre mir Photosynthese');
    await router.handleChatMessage('Und was war nochmal Chlorophyll?'); // kein Hint-Wort

    expect(router.activeModel).toBe('9b');
    expect(workerP.lastMessages!.some((m) => m.content.includes('Chlorophyll'))).toBe(true);
  });

  it('destroy() clears pendingActions and the shutdown guard blocks late output', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:web_search:x y] Moment.');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    let requestId = '';
    ctx.bus.on('action:request', (msg) => {
      requestId = msg.data.requestId;
    });
    await router.handleChatMessage('Such x y');

    await router.destroy();
    const done: string[] = [];
    ctx.bus.on('llm:done', (msg) => {
      done.push(msg.data.fullText);
    });
    ctx.bus.emit('test', 'action:result', { requestId, action: 'web_search', ok: true, speak: 'Spät.' });
    await new Promise((r) => setTimeout(r, 20));

    expect(done).toHaveLength(0);
  });
});
