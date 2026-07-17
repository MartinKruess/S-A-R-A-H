import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RouterService } from './router-service.js';
import { bootstrap } from '../../core/bootstrap.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import type { StorageProvider, Filter, MessageRow, MessagesPageQuery } from '../../core/storage/storage.interface.js';
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
