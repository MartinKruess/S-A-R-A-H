import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStorage } from './sqlite-storage.js';
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
    it('creates expected tables', async () => {
      await storage.insert('absolute_rules', { rule: 'test' });
      await storage.insert('persistent_rules', { category: 'test', rule: 'test' });
      await storage.insert('session_rules', { rule: 'test', session_id: 'abc' });
      await storage.insert('conversations', { mode: 'ambient', summary: 'test' });
      await storage.insert('messages', { conversation_id: 1, role: 'user', content: 'hi' });
      await storage.insert('learned_facts', { category: 'test', fact: 'test', confidence: 0.9, source: 'user' });

      expect(await storage.query('absolute_rules')).toHaveLength(1);
      expect(await storage.query('persistent_rules')).toHaveLength(1);
      expect(await storage.query('session_rules')).toHaveLength(1);
      expect(await storage.query('conversations')).toHaveLength(1);
      expect(await storage.query('messages')).toHaveLength(1);
      expect(await storage.query('learned_facts')).toHaveLength(1);
    });
  });
});
