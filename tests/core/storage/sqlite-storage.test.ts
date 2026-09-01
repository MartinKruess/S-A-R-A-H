import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLITE_SCHEMA_VERSION, SqliteStorage } from '../../../src/core/storage/sqlite-storage.js';
import { LEGACY_DB_RECOVERY_CONFIRMATION, MESSAGES_PAGE_MAX_LIMIT } from '../../../src/core/storage/storage.interface.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SqliteStorage', () => {
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

  describe('table operations', () => {
    it('scrubs explicit privacy deletions from the database and WAL without changing normal delete semantics', async () => {
      const marker = `privacy-marker-${Date.now()}-${'x'.repeat(80)}`;
      const id = await storage.insert('curated_memories', {
        kind: 'explicit',
        content: marker,
        source_turn_id: 'privacy-delete',
        confidence: 1,
      });
      expect(await storage.delete('curated_memories', { id })).toBe(1);

      await storage.finalizePrivacyDeletion();

      const dbPath = path.join(tmpDir, 'sarah.db');
      expect(fs.readFileSync(dbPath).includes(Buffer.from(marker))).toBe(false);
      const walPath = `${dbPath}-wal`;
      if (fs.existsSync(walPath)) expect(fs.statSync(walPath).size).toBe(0);
    });

    it('purges a quarantined message as a complete Layer-2 provenance chain', async () => {
      await storage.insert('conversations', { id: 1 });
      await storage.insertTurnMessages(1, 'turn-safe', [
        { id: 12, role: 'user', content: 'Bleibt' },
      ]);
      const stagingId = await storage.persistTurnWithMemoryStaging(
        1,
        'turn-corrupt',
        [
          { id: 10, role: 'user', content: 'Frage' },
          { id: 11, role: 'assistant', content: 'Antwort' },
        ],
        'Quelle',
        'fingerprint',
        20,
      );
      await storage.insert('curated_memories', {
        id: 30,
        source_staging_id: stagingId,
        kind: 'fact',
        content: 'Abgeleitet über Staging',
        source_conversation_id: 1,
        source_turn_id: 'turn-corrupt',
        confidence: 0.9,
      });
      await storage.insert('curated_memories', {
        id: 31,
        kind: 'episode',
        content: 'Abgeleitet über Turn',
        source_conversation_id: 1,
        source_turn_id: 'turn-corrupt',
        confidence: 0.8,
      });
      const quarantineId = await storage.insert('storage_quarantine', {
        source_table: 'messages',
        source_row_id: 10,
        column_name: 'content',
        ciphertext: 'isolated',
        row_data: '{}',
        reason: 'cipher_authentication_failed',
      });
      await storage.insert('storage_quarantine', {
        source_table: 'storage_quarantine',
        source_row_id: quarantineId,
        column_name: 'row_data',
        ciphertext: 'nested',
        row_data: '{}',
        reason: 'cipher_authentication_failed',
      });

      await expect(storage.purgeQuarantinedLayer2Memory()).resolves.toEqual({
        turns: 1,
        staging: 1,
        memories: 2,
        legacy: 0,
        quarantine: 2,
      });
      expect(await storage.query('messages', { turn_id: 'turn-corrupt' })).toEqual([]);
      expect(await storage.query('memory_staging', { id: stagingId })).toEqual([]);
      expect(await storage.query('curated_memories')).toEqual([]);
      expect(await storage.query('storage_quarantine')).toEqual([]);
      expect(await storage.query('messages', { turn_id: 'turn-safe' })).toHaveLength(1);
    });

    it('purges every statement of a quarantined topic and removes the topic graph', async () => {
      const topicId = await storage.insert('memory_topics', { title: 'Ciphertext', version: 1 });
      await storage.insert('curated_memories', {
        topic_id: topicId, kind: 'fact', content: 'A', evidence: 'A',
        source_turn_id: 'a', confidence: 0.8, status: 'active', revision: 1,
        created_by_action: 'add',
      });
      await storage.insert('curated_memories', {
        topic_id: topicId, kind: 'fact', content: 'B', evidence: 'B',
        source_turn_id: 'b', confidence: 0.8, status: 'active', revision: 1,
        created_by_action: 'add',
      });
      await storage.insert('storage_quarantine', {
        source_table: 'memory_topics', source_row_id: topicId, column_name: 'title',
        ciphertext: 'isolated', row_data: '{}', reason: 'cipher_authentication_failed',
      });

      await expect(storage.purgeQuarantinedLayer2Memory()).resolves.toEqual({
        turns: 0, staging: 0, memories: 2, legacy: 0, quarantine: 1,
      });
      expect(await storage.query('curated_memories')).toEqual([]);
      expect(await storage.query('memory_sources')).toEqual([]);
      expect(await storage.query('memory_topics')).toEqual([]);
      expect(await storage.query('storage_quarantine')).toEqual([]);
    });

    it('purges an unreadable reminder and its recursive quarantine copies', async () => {
      const reminderId = await storage.insert('reminders', {
        due_local: '2026-09-01T08:00',
        text: 'Ciphertext',
        state: 'pending',
        source_kind: 'local',
      });
      const quarantineId = await storage.insert('storage_quarantine', {
        source_table: 'reminders',
        source_row_id: reminderId,
        column_name: 'text',
        ciphertext: 'isolated',
        row_data: '{}',
        reason: 'cipher_authentication_failed',
      });
      await storage.insert('storage_quarantine', {
        source_table: 'storage_quarantine',
        source_row_id: quarantineId,
        column_name: 'row_data',
        ciphertext: 'nested',
        row_data: '{}',
        reason: 'cipher_authentication_failed',
      });

      await expect(storage.purgeQuarantinedReminders()).resolves.toBe(1);
      expect(await storage.query('reminders')).toEqual([]);
      expect(await storage.query('storage_quarantine')).toEqual([]);
    });

    it('purges legacy learned memory and its recursive quarantine but keeps absolute rules', async () => {
      const learnedId = await storage.insert('learned_facts', {
        category: 'person', fact: 'Alt', confidence: 0.7, source: 'legacy',
      });
      await storage.insert('persistent_rules', { category: 'user', rule: 'Nutzerregel' });
      await storage.insert('session_rules', { session_id: 'session', rule: 'Sitzungsregel' });
      await storage.insert('absolute_rules', { rule: 'Systemgrenze' });
      await storage.insert('message_quarantine', {
        original_id: 99, conversation_id: 1, turn_id: 'legacy', role: 'user',
        content: 'isolierter Legacy-Turn', reason: 'legacy',
      });
      const quarantineId = await storage.insert('storage_quarantine', {
        source_table: 'learned_facts',
        source_row_id: learnedId,
        column_name: 'fact',
        ciphertext: 'isolated',
        row_data: '{}',
        reason: 'cipher_authentication_failed',
      });
      await storage.insert('storage_quarantine', {
        source_table: 'storage_quarantine',
        source_row_id: quarantineId,
        column_name: 'row_data',
        ciphertext: 'nested',
        row_data: '{}',
        reason: 'cipher_authentication_failed',
      });

      const result = await storage.purgeAllLayer2Memory();

      expect(result.legacy).toBe(3);
      expect(result.quarantine).toBe(3);
      expect(await storage.query('learned_facts')).toEqual([]);
      expect(await storage.query('persistent_rules')).toEqual([]);
      expect(await storage.query('session_rules')).toEqual([]);
      expect(await storage.query('storage_quarantine')).toEqual([]);
      expect(await storage.query('message_quarantine')).toEqual([]);
      expect(await storage.query('absolute_rules')).toHaveLength(1);
    });

    it('rolls back every reviewed legacy write when one source changed after review', async () => {
      const firstId = await storage.insert('persistent_rules', { category: 'legacy', rule: 'legacy-a' });
      const secondId = await storage.insert('persistent_rules', { category: 'legacy', rule: 'legacy-b' });
      const firstQuarantine = await storage.insert('storage_quarantine', {
        source_table: 'persistent_rules', source_row_id: firstId, column_name: 'rule',
        ciphertext: 'wrapped-a', row_data: '{}', reason: 'unbound_legacy_ciphertext',
      });
      const secondQuarantine = await storage.insert('storage_quarantine', {
        source_table: 'persistent_rules', source_row_id: secondId, column_name: 'rule',
        ciphertext: 'wrapped-b', row_data: '{}', reason: 'unbound_legacy_ciphertext',
      });

      await expect(storage.restoreReviewedLegacyDbValues(
        LEGACY_DB_RECOVERY_CONFIRMATION,
        [
          {
            quarantineId: firstQuarantine, table: 'persistent_rules', rowId: firstId,
            column: 'rule', legacyCiphertext: 'legacy-a', encryptedValue: 'v2-a',
          },
          {
            quarantineId: secondQuarantine, table: 'persistent_rules', rowId: secondId,
            column: 'rule', legacyCiphertext: 'stale-value', encryptedValue: 'v2-b',
          },
        ],
      )).rejects.toThrow('changed after review');

      expect(await storage.query<{ rule: string }>('persistent_rules')).toEqual([
        expect.objectContaining({ id: firstId, rule: 'legacy-a' }),
        expect.objectContaining({ id: secondId, rule: 'legacy-b' }),
      ]);
      expect(await storage.query('storage_quarantine')).toHaveLength(2);
      expect(fs.readdirSync(tmpDir).some((name) => name.includes('.legacy-recovery-'))).toBe(true);
    });

    it('writes a completed multi-message turn through one transactional operation', async () => {
      await storage.insert('conversations', { id: 7 });
      await storage.insertTurnMessages(7, 'turn-7', [
        { role: 'user', content: 'Frage' },
        { role: 'assistant', content: 'Zwischenstand' },
        { role: 'assistant', content: 'Antwort' },
      ]);

      const rows = await storage.query<{ conversation_id: number; turn_id: string; role: string; content: string }>('messages');
      expect(rows).toEqual([
        expect.objectContaining({ conversation_id: 7, turn_id: 'turn-7', role: 'user', content: 'Frage' }),
        expect.objectContaining({ conversation_id: 7, turn_id: 'turn-7', role: 'assistant', content: 'Zwischenstand' }),
        expect.objectContaining({ conversation_id: 7, turn_id: 'turn-7', role: 'assistant', content: 'Antwort' }),
      ]);
    });

    it('rejects orphaned messages and invalid roles at the database boundary', async () => {
      await expect(storage.insert('messages', {
        conversation_id: 999,
        turn_id: 'turn-orphan',
        role: 'user',
        content: 'orphan',
      })).rejects.toThrow();
      await storage.insert('conversations', { id: 1 });
      await expect(storage.insert('messages', {
        conversation_id: 1,
        turn_id: 'turn-system',
        role: 'system',
        content: 'invalid',
      })).rejects.toThrow();
    });

    it('inserts and queries a row', async () => {
      const id = await storage.insert('persistent_rules', {
        category: 'naming',
        rule: 'Bilder: img-situation-person-datum',
      });

      expect(id).toBe(1);

      const rows = await storage.query<{ id: number; category: string; rule: string }>(
        'persistent_rules',
        { category: 'naming' },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].rule).toBe('Bilder: img-situation-person-datum');
    });

    it('queries all rows without filter', async () => {
      await storage.insert('persistent_rules', { category: 'a', rule: 'rule 1' });
      await storage.insert('persistent_rules', { category: 'b', rule: 'rule 2' });

      const rows = await storage.query('persistent_rules');
      expect(rows).toHaveLength(2);
    });

    it('updates rows matching filter', async () => {
      await storage.insert('persistent_rules', { category: 'naming', rule: 'old' });
      const updated = await storage.update(
        'persistent_rules',
        { category: 'naming' },
        { rule: 'new' },
      );

      expect(updated).toBe(1);
      const rows = await storage.query<{ rule: string }>('persistent_rules', { category: 'naming' });
      expect(rows[0].rule).toBe('new');
    });

    it('deletes rows matching filter', async () => {
      await storage.insert('persistent_rules', { category: 'temp', rule: 'delete me' });
      const deleted = await storage.delete('persistent_rules', { category: 'temp' });

      expect(deleted).toBe(1);
      const rows = await storage.query('persistent_rules', { category: 'temp' });
      expect(rows).toHaveLength(0);
    });
  });

  describe('key-value operations', () => {
    it('sets and gets a value', async () => {
      await storage.set('test_key', { hello: 'world' });
      expect(await storage.get('test_key')).toEqual({ hello: 'world' });
    });

    it('returns undefined for missing key', async () => {
      expect(await storage.get('missing')).toBeUndefined();
    });

    it('overwrites existing key', async () => {
      await storage.set('key', 'a');
      await storage.set('key', 'b');
      expect(await storage.get('key')).toBe('b');
    });
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

  describe('queryMessagesPage', () => {
    it('returns newest messages first, excluding the given conversation', async () => {
      await storage.insert('conversations', { id: 1 });
      await storage.insert('conversations', { id: 2 });
      await storage.insert('messages', { conversation_id: 1, role: 'user', content: 'old 1' });
      await storage.insert('messages', { conversation_id: 1, role: 'assistant', content: 'old 2' });
      await storage.insert('messages', { conversation_id: 2, role: 'user', content: 'current' });

      const rows = await storage.queryMessagesPage({ excludeConversationId: 2, limit: 10 });

      expect(rows.map((r) => r.content)).toEqual(['old 2', 'old 1']);
      expect(rows[0].conversation_id).toBe(1);
      expect(rows[0].role).toBe('assistant');
    });

    it('applies the limit after ordering', async () => {
      await storage.insert('conversations', { id: 1 });
      for (let i = 0; i < 5; i++) {
        await storage.insert('messages', { conversation_id: 1, role: 'user', content: `msg ${i}` });
      }

      const rows = await storage.queryMessagesPage({ excludeConversationId: 99, limit: 3 });

      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.content)).toEqual(['msg 4', 'msg 3', 'msg 2']);
    });

    it('returns empty array on empty table', async () => {
      const rows = await storage.queryMessagesPage({ excludeConversationId: 1, limit: 20 });
      expect(rows).toEqual([]);
    });

    it('rejects invalid limits at the storage boundary', async () => {
      await expect(storage.queryMessagesPage({ excludeConversationId: 1, limit: 0 })).rejects.toThrow('Invalid limit');
      await expect(storage.queryMessagesPage({ excludeConversationId: 1, limit: -5 })).rejects.toThrow('Invalid limit');
      await expect(storage.queryMessagesPage({ excludeConversationId: 1, limit: 2.5 })).rejects.toThrow('Invalid limit');
      await expect(
        storage.queryMessagesPage({ excludeConversationId: 1, limit: MESSAGES_PAGE_MAX_LIMIT + 1 }),
      ).rejects.toThrow('Invalid limit');
    });

    it('rejects a non-integer excludeConversationId', async () => {
      await expect(storage.queryMessagesPage({ excludeConversationId: 1.5, limit: 10 })).rejects.toThrow(
        'Invalid excludeConversationId',
      );
    });
  });

  it('migrates valid legacy turns and quarantines unsafe legacy rows', async () => {
    await storage.close();
    const dbPath = path.join(tmpDir, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        mode TEXT NOT NULL DEFAULT 'ambient',
        summary TEXT DEFAULT ''
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO conversations (id) VALUES (5);
      INSERT INTO messages (conversation_id, role, content) VALUES
        (5, 'assistant', 'orphan'),
        (5, 'user', 'question'),
        (5, 'assistant', 'answer'),
        (5, 'system', 'unsafe'),
        (6, 'user', 'missing parent');
    `);
    legacy.close();

    storage = new SqliteStorage(dbPath);

    const rows = await storage.query<{ turn_id: string; content: string }>('messages');
    expect(rows.map((row) => row.content)).toEqual(['question', 'answer']);
    expect(rows[0].turn_id).toBe(rows[1].turn_id);
    expect(await storage.query('conversations', { id: 5 })).toHaveLength(1);
    expect(await storage.query('conversations', { id: 6 })).toHaveLength(0);
    const quarantined = await storage.query<{ reason: string }>('message_quarantine');
    expect(quarantined.map((row) => row.reason).sort()).toEqual([
      'invalid_role',
      'missing_conversation',
      'orphan_assistant',
    ]);
  });

  it('migrates legacy memory staging to failed-state and provenance support', async () => {
    await storage.close();
    const dbPath = path.join(tmpDir, 'legacy-memory.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        mode TEXT NOT NULL DEFAULT 'ambient',
        summary TEXT DEFAULT ''
      );
      CREATE TABLE memory_staging (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        turn_id TEXT NOT NULL UNIQUE,
        source_content TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_started_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO conversations (id) VALUES (1);
      INSERT INTO memory_staging (conversation_id, turn_id, source_content)
      VALUES (1, 'legacy-memory', 'Quelle');
    `);
    legacy.close();

    storage = new SqliteStorage(dbPath);
    expect(await storage.update('memory_staging', { turn_id: 'legacy-memory' }, {
      state: 'failed',
      policy_terms: 'quelle',
    })).toBe(1);
    expect(await storage.query('memory_staging', { state: 'failed' })).toHaveLength(1);
  });
});
