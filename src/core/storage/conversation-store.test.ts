import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStore, FALLBACK_CONVERSATION_ID, START_CONTEXT_LIMIT } from './conversation-store.js';
import { SqliteStorage } from './sqlite-storage.js';
import type { StorageProvider, Filter, MessageRow, MessagesPageQuery, TurnMessageWrite } from './storage.interface.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
  async insertTurnMessages(conversationId: number, messages: readonly TurnMessageWrite[]): Promise<void> {
    if (this.opts.failInsertTables?.includes('messages')) throw new Error('disk I/O error');
    return this.inner.insertTurnMessages(conversationId, messages);
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

describe('ConversationStore', () => {
  let storage: SqliteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-convstore-'));
    storage = new SqliteStorage(path.join(tmpDir, 'sarah.db'));
  });

  afterEach(async () => {
    await storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates exactly one session per boot on a fresh DB', async () => {
    const boot = await new ConversationStore(storage).boot();

    const rows = await storage.query('conversations');
    expect(rows).toHaveLength(1);
    expect(boot.conversationId).toBe(1);
    expect(boot.degraded).toBe(false);
    expect(boot.startContext).toEqual([]);
  });

  it('repairs legacy messages BEFORE creating the session (new session never gets id 1)', async () => {
    await storage.insertTurnMessages(1, [
      { role: 'user', content: 'legacy' },
      { role: 'assistant', content: 'legacy answer' },
    ]);

    const boot = await new ConversationStore(storage).boot();

    const legacyRow = await storage.query<{ id: number }>('conversations', { id: 1 });
    expect(legacyRow).toHaveLength(1);
    expect(boot.conversationId).toBe(2);
    expect(boot.startContext.map((m) => m.content)).toEqual(['legacy', 'legacy answer']);
  });

  it('repair is idempotent across boots', async () => {
    await storage.insert('messages', { conversation_id: 1, role: 'user', content: 'legacy' });

    await new ConversationStore(storage).boot();
    await new ConversationStore(storage).boot();

    // legacy row (id 1) + two sessions = 3, no duplicates of the legacy row
    const rows = await storage.query<{ id: number }>('conversations');
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.id === 1)).toHaveLength(1);
  });

  it('does not create a legacy row on an already-repaired or fresh DB', async () => {
    await new ConversationStore(storage).boot(); // fresh: session takes id 1 organically

    const rows = await storage.query('conversations');
    expect(rows).toHaveLength(1);
  });

  it('loads at most START_CONTEXT_LIMIT messages across sessions, chronological', async () => {
    await storage.insert('conversations', { mode: 'ambient' }); // old session, id 1
    for (let i = 0; i < 15; i++) {
      await storage.insertTurnMessages(1, [
        { role: 'user', content: `question ${i}` },
        { role: 'assistant', content: `answer ${i}` },
      ]);
    }

    const boot = await new ConversationStore(storage).boot();

    expect(boot.startContext).toHaveLength(START_CONTEXT_LIMIT);
    expect(boot.startContext[0].content).toBe('question 5'); // oldest complete turn kept
    expect(boot.startContext[START_CONTEXT_LIMIT - 1].content).toBe('answer 14'); // newest last
  });

  it('drops an orphaned assistant at the page boundary instead of loading half a turn', async () => {
    await storage.insert('conversations', { mode: 'ambient' });
    await storage.insert('messages', { conversation_id: 1, role: 'assistant', content: 'orphan' });
    for (let i = 0; i < 10; i++) {
      await storage.insertTurnMessages(1, [
        { role: 'user', content: `question ${i}` },
        { role: 'assistant', content: `answer ${i}` },
      ]);
    }
    const boot = await new ConversationStore(storage).boot();

    expect(boot.startContext).toHaveLength(20);
    expect(boot.startContext.some((row) => row.content === 'orphan')).toBe(false);
    expect(boot.startContext[0].role).toBe('user');
  });

  it('excludes the current session and spans previous sessions', async () => {
    const boot1 = await new ConversationStore(storage).boot();
    await storage.insert('messages', { conversation_id: boot1.conversationId, role: 'user', content: 'from run 1' });
    await storage.insert('messages', { conversation_id: boot1.conversationId, role: 'assistant', content: 'answer run 1' });

    const boot2 = await new ConversationStore(storage).boot();

    expect(boot2.conversationId).not.toBe(boot1.conversationId);
    expect(boot2.startContext.map((m) => m.content)).toEqual(['from run 1', 'answer run 1']);
  });

  it('does not load persisted history when memory is disabled', async () => {
    await storage.insert('conversations', { mode: 'ambient' });
    await storage.insert('messages', { conversation_id: 1, role: 'user', content: 'alte private Frage' });

    const boot = await new ConversationStore(storage).boot({
      memoryAllowed: false,
      memoryExclusions: [],
    });

    expect(boot.startContext).toEqual([]);
  });

  it('filters configured exclusions out of the persisted start context', async () => {
    await storage.insert('conversations', { mode: 'ambient' });
    await storage.insertTurnMessages(1, [
      { role: 'user', content: 'Mein Hobby ist Musik' },
      { role: 'assistant', content: 'Das merke ich mir.' },
    ]);
    await storage.insert('conversations', { mode: 'ambient' });
    await storage.insert('messages', { conversation_id: 2, role: 'user', content: 'Mein Kontostand bleibt privat' });
    await storage.insert('messages', { conversation_id: 2, role: 'assistant', content: 'Das behandle ich vertraulich.' });

    const boot = await new ConversationStore(storage).boot({
      memoryAllowed: true,
      memoryExclusions: ['Finanzen'],
    });

    expect(boot.startContext.map((message) => message.content)).toEqual([
      'Mein Hobby ist Musik',
      'Das merke ich mir.',
    ]);
  });

  it('falls back to in-memory sentinel when the session insert fails', async () => {
    const failing = new FailingStorage(storage, { failInsertTables: ['conversations'] });

    const boot = await new ConversationStore(failing).boot();

    expect(boot.conversationId).toBe(FALLBACK_CONVERSATION_ID);
    expect(boot.degraded).toBe(true);
  });

  it('returns an empty start context when reads fail, without throwing', async () => {
    const failing = new FailingStorage(storage, { failReads: true });

    const boot = await new ConversationStore(failing).boot();

    expect(boot.startContext).toEqual([]);
  });
});
