import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLITE_SCHEMA_VERSION, SqliteStorage } from '../../../src/core/storage/sqlite-storage.js';
import { LEGACY_DB_RECOVERY_CONFIRMATION, MESSAGES_PAGE_MAX_LIMIT } from '../../../src/core/storage/storage.interface.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';


describe('SqliteStorage schema', () => {
  let storage: SqliteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-sqlite-'));
    const dbPath = path.join(tmpDir, 'sarah.db');
    storage = new SqliteStorage(dbPath);
  });

  afterEach(async () => {
    await storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });


  describe('schema initialization', () => {
    it('records the current schema version after transactional initialization', async () => {
      const dbPath = path.join(tmpDir, 'versioned.db');
      const versioned = new SqliteStorage(dbPath);
      await versioned.close();
      const raw = new Database(dbPath, { readonly: true });
      expect(raw.pragma('user_version', { simple: true })).toBe(SQLITE_SCHEMA_VERSION);
      raw.close();
    });

    it('rejects an unknown newer schema before mutating the database', () => {
      const dbPath = path.join(tmpDir, 'newer.db');
      const raw = new Database(dbPath);
      raw.exec('CREATE TABLE future_data (value TEXT NOT NULL); INSERT INTO future_data VALUES (\'keep\');');
      raw.pragma(`user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
      raw.close();

      expect(() => new SqliteStorage(dbPath)).toThrow(/newer schema version/);

      const unchanged = new Database(dbPath, { readonly: true });
      expect(unchanged.prepare('SELECT value FROM future_data').pluck().get()).toBe('keep');
      expect(unchanged.pragma('user_version', { simple: true })).toBe(SQLITE_SCHEMA_VERSION + 1);
      unchanged.close();
    });

    it('rolls back every schema change when one migration step fails', () => {
      const dbPath = path.join(tmpDir, 'broken-migration.db');
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT,
          ended_at TEXT,
          mode TEXT NOT NULL DEFAULT 'ambient',
          summary TEXT DEFAULT ''
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TEXT
        );
        CREATE TABLE messages_migrated (id INTEGER PRIMARY KEY);
      `);
      raw.close();

      expect(() => new SqliteStorage(dbPath)).toThrow();

      const unchanged = new Database(dbPath, { readonly: true });
      const conversationColumns = unchanged.pragma('table_info(conversations)') as Array<{ name: string }>;
      expect(conversationColumns.some(({ name }) => name === 'close_status')).toBe(false);
      expect(unchanged.pragma('user_version', { simple: true })).toBe(0);
      expect(unchanged.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_quarantine'",
      ).get()).toBeUndefined();
      unchanged.close();
    });

    it('creates expected tables', async () => {
      await storage.insert('absolute_rules', { rule: 'test' });
      await storage.insert('persistent_rules', { category: 'test', rule: 'test' });
      await storage.insert('session_rules', { rule: 'test', session_id: 'abc' });
      await storage.insert('conversations', { mode: 'ambient', summary: 'test' });
      await storage.insert('messages', { conversation_id: 1, role: 'user', content: 'hi' });
      await storage.insert('learned_facts', { category: 'test', fact: 'test', confidence: 0.9, source: 'user' });
      await storage.insert('reminders', {
        due_local: '2026-08-31T10:00',
        text: 'test',
        state: 'pending',
        source_kind: 'local',
      });

      expect(await storage.query('absolute_rules')).toHaveLength(1);
      expect(await storage.query('persistent_rules')).toHaveLength(1);
      expect(await storage.query('session_rules')).toHaveLength(1);
      expect(await storage.query('conversations')).toHaveLength(1);
      expect(await storage.query('messages')).toHaveLength(1);
      expect(await storage.query('learned_facts')).toHaveLength(1);
      expect(await storage.query('reminders')).toHaveLength(1);
    });

    it('migrates schema v1 to the current version without losing existing data', async () => {
      const dbPath = path.join(tmpDir, 'v1-reminder-migration.db');
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE persistent_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL DEFAULT '',
          rule TEXT NOT NULL,
          created_at TEXT,
          updated_at TEXT
        );
        INSERT INTO persistent_rules (category, rule) VALUES ('keep', 'existing');
      `);
      raw.pragma('user_version = 1');
      raw.close();

      const migrated = new SqliteStorage(dbPath);
      expect(await migrated.query<{ rule: string }>('persistent_rules')).toEqual([
        expect.objectContaining({ rule: 'existing' }),
      ]);
      const reminderId = await migrated.insert('reminders', {
        due_local: '2026-09-01T08:00',
        text: 'Migration prüfen',
        state: 'pending',
        source_kind: 'local',
      });
      expect(reminderId).toBe(1);
      await migrated.close();

      const verified = new Database(dbPath, { readonly: true });
      expect(verified.pragma('user_version', { simple: true })).toBe(SQLITE_SCHEMA_VERSION);
      expect(verified.prepare('SELECT COUNT(*) FROM reminders').pluck().get()).toBe(1);
      verified.close();
    });

    it('migrates v2 reminders with fail-closed legacy provenance', async () => {
      const dbPath = path.join(tmpDir, 'v2-reminder-provenance.db');
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          due_local TEXT NOT NULL,
          text TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          source_kind TEXT NOT NULL DEFAULT 'local',
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          firing_at TEXT,
          delivered_at TEXT,
          cancelled_at TEXT
        );
        INSERT INTO reminders (due_local, text) VALUES ('2026-09-01T08:00', 'Altbestand');
      `);
      raw.pragma('user_version = 2');
      raw.close();

      const migrated = new SqliteStorage(dbPath);
      expect(await migrated.query('reminders')).toEqual([
        expect.objectContaining({ origin_mode: 'chat', private_context: 1 }),
      ]);
      await migrated.close();

      const verified = new Database(dbPath, { readonly: true });
      expect(verified.pragma('user_version', { simple: true })).toBe(SQLITE_SCHEMA_VERSION);
      verified.close();
    });

    it('migrates v3 curated memories without changing their row-bound ciphertext', async () => {
      const dbPath = path.join(tmpDir, 'v3-memory-author.db');
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT, ended_at TEXT, mode TEXT NOT NULL DEFAULT 'ambient',
          summary TEXT DEFAULT '', close_status TEXT NOT NULL DEFAULT 'open'
        );
        CREATE TABLE memory_staging (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL,
          turn_id TEXT NOT NULL UNIQUE,
          source_content TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_started_at TEXT,
          policy_terms TEXT NOT NULL DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE curated_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_staging_id INTEGER UNIQUE,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          source_conversation_id INTEGER,
          source_turn_id TEXT NOT NULL,
          confidence REAL NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          deleted_at TEXT
        );
        INSERT INTO conversations (id) VALUES (1);
        INSERT INTO memory_staging (
          id, conversation_id, turn_id, source_content, state, policy_terms
        ) VALUES (7, 1, 'legacy-turn', '', 'completed', 'fingerprint');
        INSERT INTO curated_memories (
          id, source_staging_id, kind, content, source_conversation_id,
          source_turn_id, confidence
        ) VALUES (11, 7, 'fact', 'sarah-enc:v2:unchanged-ciphertext', 1, 'legacy-turn', 0.8);
      `);
      raw.pragma('user_version = 3');
      raw.close();

      const migrated = new SqliteStorage(dbPath);
      const [memory] = await migrated.query<{
        id: number; content: string; topic_id: number; status: string; revision: number;
      }>('curated_memories');
      expect(memory).toEqual(expect.objectContaining({
        id: 11,
        content: 'sarah-enc:v2:unchanged-ciphertext',
        topic_id: 11,
        status: 'active',
        revision: 1,
      }));
      expect(await migrated.query('memory_topics', { id: 11 })).toHaveLength(1);
      expect(await migrated.query('memory_sources', { memory_id: 11 })).toEqual([
        expect.objectContaining({ source_staging_id: 7, source_turn_id: 'legacy-turn' }),
      ]);
      expect(await migrated.query('memory_staging', { id: 7 })).toEqual([
        expect.objectContaining({ decision: null, decision_topic_id: null, result_memory_id: null }),
      ]);
      await migrated.close();
    });

    it('rolls back the v1 migration when the reminder schema conflicts', () => {
      const dbPath = path.join(tmpDir, 'broken-reminder-migration.db');
      const raw = new Database(dbPath);
      raw.exec('CREATE TABLE reminders (id INTEGER PRIMARY KEY);');
      raw.pragma('user_version = 1');
      raw.close();

      expect(() => new SqliteStorage(dbPath)).toThrow();

      const unchanged = new Database(dbPath, { readonly: true });
      expect(unchanged.pragma('user_version', { simple: true })).toBe(1);
      expect(unchanged.pragma('table_info(reminders)')).toEqual([
        expect.objectContaining({ name: 'id' }),
      ]);
      unchanged.close();
    });

    it('atomically completes a staging item without duplicating curated memory', async () => {
      await storage.insert('conversations', { id: 1 });
      const stagingId = await storage.insert('memory_staging', {
        conversation_id: 1,
        turn_id: 'turn-memory',
        source_content: 'Quelle',
      });
      await storage.insertTurnMessages(1, 'turn-memory', [
        { role: 'user', content: 'Rohfrage' },
        { role: 'assistant', content: 'Rohantwort' },
      ]);
      const input = {
        stagingId,
        memory: {
          kind: 'fact' as const,
          content: 'Fakt',
          sourceConversationId: 1,
          sourceTurnId: 'turn-memory',
          confidence: 0.9,
        },
      };

      await storage.completeMemoryStaging(input);
      await storage.completeMemoryStaging(input);

      expect(await storage.query('curated_memories')).toHaveLength(1);
      expect(await storage.query('memory_staging', { state: 'completed', source_content: '' })).toHaveLength(1);
      expect(await storage.query('messages', { turn_id: 'turn-memory' })).toHaveLength(0);
    });

    it('atomically applies an add delta and records its source and staging decision', async () => {
      await storage.insert('conversations', { id: 1 });
      const stagingId = await storage.persistTurnWithMemoryStaging(
        1,
        'turn-author-add',
        [{ role: 'user', content: 'Ich spiele gern Schach.' }],
        'USER: Ich spiele gern Schach.',
        'fingerprint',
      );
      await storage.update('memory_staging', { id: stagingId }, { state: 'processing' });

      const result = await storage.applyMemoryAuthorDelta({
        stagingId,
        action: 'add',
        newTopic: { title: 'Schach' },
        targets: [],
        statement: {
          kind: 'preference',
          content: 'Martin spielt gern Schach.',
          evidence: 'Ich spiele gern Schach.',
          confidence: 0.94,
        },
      });

      expect(result).toEqual({ action: 'add', topicId: expect.any(Number), memoryId: expect.any(Number) });
      expect(await storage.query('messages', { turn_id: 'turn-author-add' })).toEqual([]);
      expect(await storage.query('memory_staging', { id: stagingId })).toEqual([
        expect.objectContaining({
          state: 'completed', decision: 'add',
          decision_topic_id: result.topicId, result_memory_id: result.memoryId,
        }),
      ]);
      expect(await storage.query('memory_sources', { memory_id: result.memoryId! })).toEqual([
        expect.objectContaining({ source_staging_id: stagingId, source_turn_id: 'turn-author-add' }),
      ]);
    });

    it('rejects a stale topic snapshot without partially consuming the staging turn', async () => {
      await storage.insert('conversations', { id: 1 });
      const topicId = await storage.insert('memory_topics', { title: 'Schach', version: 2 });
      const stagingId = await storage.persistTurnWithMemoryStaging(
        1,
        'turn-author-stale',
        [{ role: 'user', content: 'Noch ein Detail.' }],
        'USER: Noch ein Detail.',
        'fingerprint',
      );
      await storage.update('memory_staging', { id: stagingId }, { state: 'processing' });

      await expect(storage.applyMemoryAuthorDelta({
        stagingId,
        action: 'add',
        topic: { id: topicId, version: 1 },
        targets: [],
        statement: {
          kind: 'fact', content: 'Ein Detail.', evidence: 'Noch ein Detail.', confidence: 0.8,
        },
      })).rejects.toThrow('topic');

      expect(await storage.query('curated_memories')).toEqual([]);
      expect(await storage.query('messages', { turn_id: 'turn-author-stale' })).toHaveLength(1);
      expect(await storage.query('memory_staging', { id: stagingId })).toEqual([
        expect.objectContaining({ state: 'processing', decision: null, result_memory_id: null }),
      ]);
    });

    it('merges offered active targets while preserving every source', async () => {
      await storage.insert('conversations', { id: 1 });
      const topicId = await storage.insert('memory_topics', { title: 'Schach', version: 1 });
      const firstId = await storage.insert('curated_memories', {
        topic_id: topicId, kind: 'fact', content: 'Spielt Schach', evidence: 'A',
        source_turn_id: 'old-a', confidence: 0.8, status: 'active', revision: 1,
        created_by_action: 'add',
      });
      const secondId = await storage.insert('curated_memories', {
        topic_id: topicId, kind: 'fact', content: 'Spielt oft Schach', evidence: 'B',
        source_turn_id: 'old-b', confidence: 0.8, status: 'active', revision: 1,
        created_by_action: 'add',
      });
      await storage.insert('memory_sources', {
        memory_id: firstId, source_key: 'turn:1:old-a', source_type: 'turn',
        source_conversation_id: 1, source_turn_id: 'old-a',
      });
      await storage.insert('memory_sources', {
        memory_id: secondId, source_key: 'turn:1:old-b', source_type: 'turn',
        source_conversation_id: 1, source_turn_id: 'old-b',
      });
      const stagingId = await storage.persistTurnWithMemoryStaging(
        1,
        'turn-merge',
        [{ role: 'user', content: 'Ich spiele häufig Schach.' }],
        'USER: Ich spiele häufig Schach.',
        'fingerprint',
      );
      await storage.update('memory_staging', { id: stagingId }, { state: 'processing' });

      const result = await storage.applyMemoryAuthorDelta({
        stagingId,
        action: 'merge',
        topic: { id: topicId, version: 1 },
        targets: [{ id: firstId, revision: 1 }, { id: secondId, revision: 1 }],
        statement: {
          kind: 'fact', content: 'Martin spielt häufig Schach.',
          evidence: 'Ich spiele häufig Schach.', confidence: 0.95,
        },
      });

      expect(await storage.query('curated_memories', { status: 'superseded' })).toEqual([
        expect.objectContaining({ id: firstId, superseded_by_id: result.memoryId }),
        expect.objectContaining({ id: secondId, superseded_by_id: result.memoryId }),
      ]);
      expect(await storage.query('memory_sources', { memory_id: result.memoryId! })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source_key: 'turn:1:old-a' }),
          expect.objectContaining({ source_key: 'turn:1:old-b' }),
          expect.objectContaining({ source_staging_id: stagingId }),
        ]),
      );
      expect(await storage.query('memory_topics', { id: topicId })).toEqual([
        expect.objectContaining({ version: 2 }),
      ]);
    });

    it('atomically discards an irrelevant staging item and its retained raw turn', async () => {
      await storage.insert('conversations', { id: 1 });
      const stagingId = await storage.insert('memory_staging', {
        conversation_id: 1,
        turn_id: 'turn-discard',
        source_content: 'Nicht relevant',
      });
      await storage.insertTurnMessages(1, 'turn-discard', [
        { role: 'user', content: 'Rohfrage' },
        { role: 'assistant', content: 'Rohantwort' },
      ]);

      await storage.discardMemoryStaging(stagingId);

      expect(await storage.query('memory_staging', {
        id: stagingId,
        state: 'completed',
        source_content: '',
      })).toHaveLength(1);
      expect(await storage.query('messages', { turn_id: 'turn-discard' })).toHaveLength(0);
      expect(await storage.query('curated_memories')).toHaveLength(0);
    });

    it('atomically persists a completed turn together with its staging job', async () => {
      await storage.insert('conversations', { id: 1 });

      const stagingId = await storage.persistTurnWithMemoryStaging(
        1,
        'turn-atomic',
        [
          { role: 'user', content: 'Frage' },
          { role: 'assistant', content: 'Antwort' },
        ],
        'USER: Frage\nASSISTANT: Antwort',
        'frage antwort',
      );

      expect(await storage.query('messages', { turn_id: 'turn-atomic' })).toHaveLength(2);
      expect(await storage.query('memory_staging', { id: stagingId, state: 'pending' })).toHaveLength(1);
    });

    it('rolls back all turn rows if the atomic staging write fails', async () => {
      await storage.insert('conversations', { id: 1 });

      await expect(storage.persistTurnWithMemoryStaging(
        1,
        'turn-rollback',
        [
          { id: 50, role: 'user', content: 'Frage' },
          { id: 50, role: 'assistant', content: 'Antwort' },
        ],
        'Quelle',
      )).rejects.toThrow();

      expect(await storage.query('messages', { turn_id: 'turn-rollback' })).toEqual([]);
      expect(await storage.query('memory_staging', { turn_id: 'turn-rollback' })).toEqual([]);
    });

    it('atomically dead-letters staging and removes its retained raw turn', async () => {
      await storage.insert('conversations', { id: 1 });
      const stagingId = await storage.persistTurnWithMemoryStaging(
        1,
        'turn-failed',
        [{ role: 'user', content: 'Rohfrage' }],
        'USER: Rohfrage',
        'rohfrage',
      );

      await storage.failMemoryStaging(stagingId);

      const [failed] = await storage.query<{
        state: string;
        source_content: string;
        policy_terms: string;
      }>('memory_staging', { id: stagingId });
      expect(failed).toMatchObject({
        state: 'failed',
        source_content: 'USER: Rohfrage',
        policy_terms: 'rohfrage',
      });
      expect(await storage.query('messages', { turn_id: 'turn-failed' })).toHaveLength(1);
    });
  });
});
