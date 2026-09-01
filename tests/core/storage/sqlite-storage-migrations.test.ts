import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLITE_SCHEMA_VERSION, SqliteStorage } from '../../../src/core/storage/sqlite-storage.js';
import { LEGACY_DB_RECOVERY_CONFIRMATION, MESSAGES_PAGE_MAX_LIMIT } from '../../../src/core/storage/storage.interface.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';


describe('SqliteStorage migrations', () => {
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
