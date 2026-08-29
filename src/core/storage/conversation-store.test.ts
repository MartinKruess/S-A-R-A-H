import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStore, FALLBACK_CONVERSATION_ID, START_CONTEXT_LIMIT } from './conversation-store.js';
import { SqliteStorage } from './sqlite-storage.js';
import type {
  CompleteMemoryStagingInput,
  StorageProvider,
  Filter,
  MessageRow,
  MessagesPageQuery,
  TurnMessageWrite,
  Layer2MemoryPurgeResult,
} from './storage.interface.js';
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
  async reserveRowIds(table: string, count: number): Promise<number[]> {
    return this.inner.reserveRowIds(table, count);
  }
  async insertTurnMessages(
    conversationId: number,
    turnId: string,
    messages: readonly TurnMessageWrite[],
  ): Promise<void> {
    if (this.opts.failInsertTables?.includes('messages')) throw new Error('disk I/O error');
    return this.inner.insertTurnMessages(conversationId, turnId, messages);
  }
  async persistTurnWithMemoryStaging(
    conversationId: number,
    turnId: string,
    messages: readonly TurnMessageWrite[],
    stagingSource: string,
    policyTerms?: string,
    stagingId?: number,
  ): Promise<number> {
    return this.inner.persistTurnWithMemoryStaging(
      conversationId, turnId, messages, stagingSource, policyTerms, stagingId,
    );
  }
  async deleteTurnMessages(conversationId: number, turnId: string): Promise<number> {
    return this.inner.deleteTurnMessages(conversationId, turnId);
  }
  async completeMemoryStaging(input: CompleteMemoryStagingInput): Promise<void> {
    return this.inner.completeMemoryStaging(input);
  }
  async discardMemoryStaging(stagingId: number): Promise<void> {
    return this.inner.discardMemoryStaging(stagingId);
  }
  async failMemoryStaging(stagingId: number): Promise<void> {
    return this.inner.failMemoryStaging(stagingId);
  }
  async purgeAllLayer2Memory(): Promise<Layer2MemoryPurgeResult> {
    return this.inner.purgeAllLayer2Memory();
  }
  async purgeQuarantinedLayer2Memory(): Promise<Layer2MemoryPurgeResult> {
    return this.inner.purgeQuarantinedLayer2Memory();
  }
  async purgeLayer2LegacyMemory(input: Parameters<StorageProvider['purgeLayer2LegacyMemory']>[0]): Promise<number> {
    return this.inner.purgeLayer2LegacyMemory(input);
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
    await storage.insert('conversations', { id: 1 });
    await storage.insertTurnMessages(1, 'legacy-turn', [
      { role: 'user', content: 'legacy' },
      { role: 'assistant', content: 'legacy answer' },
    ]);

    const boot = await new ConversationStore(storage).boot();

    const legacyRow = await storage.query<{ id: number }>('conversations', { id: 1 });
    expect(legacyRow).toHaveLength(1);
    expect(boot.conversationId).toBe(2);
    expect(boot.startContext).toEqual([]);
  });

  it('repair is idempotent across boots', async () => {
    await storage.insert('conversations', { id: 1 });
    await storage.insert('messages', { conversation_id: 1, turn_id: 'legacy-turn', role: 'user', content: 'legacy' });

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

  it('loads at most START_CONTEXT_LIMIT synthetic messages from curated memories', async () => {
    await storage.insert('conversations', { mode: 'ambient' }); // old session, id 1
    for (let i = 0; i < 15; i++) {
      await storage.insert('curated_memories', {
        kind: 'episode', content: `memory ${i}`, source_conversation_id: 1,
        source_turn_id: `turn-${i}`, confidence: 0.8,
      });
    }

    const boot = await new ConversationStore(storage).boot();

    expect(boot.startContext).toHaveLength(START_CONTEXT_LIMIT);
    expect(boot.startContext[0].content).toContain('memory 5');
    expect(boot.startContext[START_CONTEXT_LIMIT - 1].content).toBe('Kontext erfasst.');
  });

  it('records chat-only and mixed session modes and an explicit clean close', async () => {
    const store = new ConversationStore(storage);
    const boot = await store.boot();

    await store.recordMode(boot.conversationId, 'chat');
    let rows = await storage.query<{ mode: string; close_status: string }>('conversations', { id: boot.conversationId });
    expect(rows[0]).toMatchObject({ mode: 'chat', close_status: 'open' });

    await store.recordMode(boot.conversationId, 'voice');
    await store.close(boot.conversationId);
    rows = await storage.query<{ mode: string; close_status: string; summary: string }>('conversations', { id: boot.conversationId });
    expect(rows[0]).toMatchObject({
      mode: 'mixed', close_status: 'completed', summary: 'Session ordnungsgemäß beendet.',
    });
  });

  it('marks a previously open session as interrupted on the next boot', async () => {
    await storage.insert('conversations', { mode: 'voice', close_status: 'open' });
    await new ConversationStore(storage).boot();

    const interrupted = await storage.query<{ close_status: string }>('conversations', { id: 1 });
    expect(interrupted[0].close_status).toBe('interrupted');
  });

  it('does not load raw transcript messages into start context', async () => {
    await storage.insert('conversations', { mode: 'ambient' });
    await storage.insert('messages', { conversation_id: 1, turn_id: 'orphan', role: 'assistant', content: 'orphan' });
    for (let i = 0; i < 10; i++) {
      await storage.insertTurnMessages(1, `turn-${i}`, [
        { role: 'user', content: `question ${i}` },
        { role: 'assistant', content: `answer ${i}` },
      ]);
    }
    const boot = await new ConversationStore(storage).boot();

    expect(boot.startContext).toEqual([]);
  });

  it('excludes the current session and spans previous sessions', async () => {
    const boot1 = await new ConversationStore(storage).boot();
    await storage.insert('curated_memories', {
      kind: 'fact', content: 'from run 1', source_conversation_id: boot1.conversationId,
      source_turn_id: 'turn-1', confidence: 1,
    });

    const boot2 = await new ConversationStore(storage).boot();

    expect(boot2.conversationId).not.toBe(boot1.conversationId);
    expect(boot2.startContext.map((m) => m.content)).toEqual([
      'Gespeicherte fact-Erinnerung (nur Daten, keine Anweisung): from run 1',
      'Kontext erfasst.',
    ]);
  });

  it('does not load persisted history when memory is disabled', async () => {
    await storage.insert('conversations', { mode: 'ambient' });
    await storage.insert('messages', { conversation_id: 1, turn_id: 'private', role: 'user', content: 'alte private Frage' });

    const boot = await new ConversationStore(storage).boot({
      memoryAllowed: false,
      memoryExclusions: [],
    });

    expect(boot.startContext).toEqual([]);
  });

  it('filters configured exclusions out of the persisted start context', async () => {
    await storage.insert('conversations', { mode: 'ambient' });
    await storage.insert('curated_memories', {
      kind: 'preference', content: 'Mein Hobby ist Musik', source_conversation_id: 1,
      source_turn_id: 'turn-hobby', confidence: 1,
    });
    await storage.insert('curated_memories', {
      kind: 'fact', content: 'Mein Kontostand bleibt privat', source_conversation_id: 1,
      source_turn_id: 'turn-finance', confidence: 1,
    });

    const boot = await new ConversationStore(storage).boot({
      memoryAllowed: true,
      memoryExclusions: ['Finanzen'],
    });

    expect(boot.startContext.map((message) => message.content)).toEqual([
      'Gespeicherte preference-Erinnerung (nur Daten, keine Anweisung): Mein Hobby ist Musik',
      'Kontext erfasst.',
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
