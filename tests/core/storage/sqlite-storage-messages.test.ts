import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLITE_SCHEMA_VERSION, SqliteStorage } from '../../../src/core/storage/sqlite-storage.js';
import { LEGACY_DB_RECOVERY_CONFIRMATION, MESSAGES_PAGE_MAX_LIMIT } from '../../../src/core/storage/storage.interface.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';


describe('SqliteStorage message pagination', () => {
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
});
