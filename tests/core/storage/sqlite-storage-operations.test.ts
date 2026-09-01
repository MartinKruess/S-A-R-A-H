import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLITE_SCHEMA_VERSION, SqliteStorage } from '../../../src/core/storage/sqlite-storage.js';
import { LEGACY_DB_RECOVERY_CONFIRMATION, MESSAGES_PAGE_MAX_LIMIT } from '../../../src/core/storage/storage.interface.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';


describe('SqliteStorage operations', () => {
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
});
