import type Database from 'better-sqlite3';
import { SQLITE_SCHEMA } from './sqlite-schema.js';

interface LegacyMessageRow {
  id: number;
  conversation_id: number;
  turn_id: string;
  role: string;
  content: string;
  timestamp: string | null;
}

/**
 * @param db - Open database being upgraded from the legacy unversioned schema.
 *
 * - Adds missing conversation and staging fields.
 * - Rebuilds unsafe legacy message rows and quarantines invalid data.
 * - Adds the structured quarantine payload field.
 *
 * @category Data Access
 */
export function migrateLegacySqliteSchema(db: Database.Database): void {
  migrateConversations(db);
  migrateMessages(db);
  migrateMemoryStaging(db);
  migrateStorageQuarantine(db);
}

/**
 * @param db - Open version-three database.
 *
 * - Introduces topics, revisions, and provenance for curated memory.
 * - Preserves existing curated memories as legacy imports.
 *
 * @category Data Access
 */
export function migrateMemoryAuthorSchema(db: Database.Database): void {
  const memoryColumns = new Set((db.pragma('table_info(curated_memories)') as Array<{ name: string }>)
    .map(({ name }) => name));
  if (memoryColumns.size === 0) {
    db.exec(SQLITE_SCHEMA);
    return;
  }
  if (memoryColumns.has('topic_id')) return;

  const stagingColumns = new Set((db.pragma('table_info(memory_staging)') as Array<{ name: string }>)
    .map(({ name }) => name));
  db.exec(`
    CREATE TABLE memory_topics (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT,
      version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );
    INSERT INTO memory_topics (id, title, created_at, updated_at, deleted_at)
    SELECT id, NULL, COALESCE(created_at, datetime('now')),
      COALESCE(updated_at, created_at, datetime('now')), deleted_at
    FROM curated_memories;

    CREATE TABLE curated_memories_v4 (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      source_staging_id      INTEGER UNIQUE,
      kind                   TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'episode', 'explicit')),
      content                TEXT NOT NULL,
      source_conversation_id INTEGER,
      source_turn_id         TEXT NOT NULL,
      confidence             REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      topic_id               INTEGER NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'deleted')),
      revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      superseded_by_id       INTEGER,
      created_by_action      TEXT NOT NULL DEFAULT 'legacy_import' CHECK (created_by_action IN ('legacy_import', 'add', 'update', 'merge', 'supersede', 'explicit', 'manual')),
      evidence               TEXT NOT NULL DEFAULT '',
      confirmation_count     INTEGER NOT NULL DEFAULT 1 CHECK (confirmation_count > 0),
      last_confirmed_at      TEXT,
      created_at             TEXT DEFAULT (datetime('now')),
      updated_at             TEXT DEFAULT (datetime('now')),
      deleted_at             TEXT,
      FOREIGN KEY (source_staging_id) REFERENCES memory_staging(id) ON DELETE SET NULL,
      FOREIGN KEY (source_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
      FOREIGN KEY (topic_id) REFERENCES memory_topics(id) ON DELETE CASCADE,
      FOREIGN KEY (superseded_by_id) REFERENCES curated_memories_v4(id) ON DELETE SET NULL
    );
    INSERT INTO curated_memories_v4 (
      id, source_staging_id, kind, content, source_conversation_id, source_turn_id,
      confidence, topic_id, status, revision, created_by_action, evidence,
      confirmation_count, last_confirmed_at, created_at, updated_at, deleted_at
    )
    SELECT id, source_staging_id, kind, content, source_conversation_id, source_turn_id,
      confidence, id, CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END,
      1, 'legacy_import', '', 1, created_at, created_at, updated_at, deleted_at
    FROM curated_memories;
    DROP TABLE curated_memories;
    ALTER TABLE curated_memories_v4 RENAME TO curated_memories;

    CREATE TABLE memory_sources (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id              INTEGER NOT NULL,
      source_key             TEXT NOT NULL,
      source_type            TEXT NOT NULL CHECK (source_type IN ('turn', 'explicit', 'manual', 'legacy')),
      source_staging_id      INTEGER,
      source_conversation_id INTEGER,
      source_turn_id         TEXT,
      observed_at            TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (memory_id, source_key),
      FOREIGN KEY (memory_id) REFERENCES curated_memories(id) ON DELETE CASCADE,
      FOREIGN KEY (source_staging_id) REFERENCES memory_staging(id) ON DELETE SET NULL,
      FOREIGN KEY (source_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );
    INSERT INTO memory_sources (
      memory_id, source_key, source_type, source_staging_id,
      source_conversation_id, source_turn_id, observed_at
    )
    SELECT id,
      CASE WHEN source_staging_id IS NOT NULL THEN 'staging:' || source_staging_id
        ELSE 'turn:' || COALESCE(source_conversation_id, 'unknown') || ':' || source_turn_id END,
      CASE WHEN kind = 'explicit' THEN 'explicit' ELSE 'legacy' END,
      source_staging_id, source_conversation_id, source_turn_id,
      COALESCE(created_at, datetime('now'))
    FROM curated_memories;

    CREATE INDEX idx_curated_memories_topic_status
      ON curated_memories(topic_id, status, updated_at DESC);
    CREATE INDEX idx_memory_sources_staging ON memory_sources(source_staging_id);
    CREATE INDEX idx_memory_sources_turn
      ON memory_sources(source_conversation_id, source_turn_id);
  `);
  if (!stagingColumns.has('decision')) {
    db.exec("ALTER TABLE memory_staging ADD COLUMN decision TEXT CHECK (decision IN ('add', 'update', 'merge', 'supersede', 'ignore')); ");
  }
  if (!stagingColumns.has('decision_topic_id')) {
    db.exec('ALTER TABLE memory_staging ADD COLUMN decision_topic_id INTEGER;');
  }
  if (!stagingColumns.has('result_memory_id')) {
    db.exec('ALTER TABLE memory_staging ADD COLUMN result_memory_id INTEGER;');
  }
}

function migrateMessages(db: Database.Database): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as
    | { sql: string }
    | undefined;
  if (!table) return;

  const columns = db.pragma('table_info(messages)') as Array<{ name: string }>;
  const hasTurnId = columns.some((column) => column.name === 'turn_id');
  const normalizedSql = table.sql.replace(/\s+/g, ' ').toLowerCase();
  const alreadyConstrained =
    hasTurnId &&
    normalizedSql.includes("check (role in ('user', 'assistant'))") &&
    normalizedSql.includes('references conversations(id)');
  if (alreadyConstrained) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE messages_migrated (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        turn_id         TEXT NOT NULL DEFAULT 'legacy',
        role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content         TEXT NOT NULL,
        timestamp       TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    `);

    const rows = db.prepare(
      hasTurnId
        ? 'SELECT id, conversation_id, turn_id, role, content, timestamp FROM messages ORDER BY conversation_id, id'
        : "SELECT id, conversation_id, 'legacy' AS turn_id, role, content, timestamp FROM messages ORDER BY conversation_id, id",
    ).all() as LegacyMessageRow[];
    const insertMessage = db.prepare(`
      INSERT INTO messages_migrated (id, conversation_id, turn_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const quarantine = db.prepare(`
      INSERT INTO message_quarantine (
        original_id, conversation_id, turn_id, role, content, timestamp, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const conversationIds = new Set(
      (db.prepare('SELECT id FROM conversations').all() as Array<{ id: number }>).map((row) => row.id),
    );
    const activeLegacyTurns = new Map<number, string>();

    for (const row of rows) {
      if (!Number.isInteger(row.conversation_id) || row.conversation_id <= 0) {
        quarantine.run(row.id, row.conversation_id, row.turn_id, row.role, row.content, row.timestamp, 'invalid_conversation_id');
        continue;
      }
      if (!conversationIds.has(row.conversation_id)) {
        quarantine.run(row.id, row.conversation_id, row.turn_id, row.role, row.content, row.timestamp, 'missing_conversation');
        continue;
      }
      if (row.role !== 'user' && row.role !== 'assistant') {
        quarantine.run(row.id, row.conversation_id, row.turn_id, row.role, row.content, row.timestamp, 'invalid_role');
        continue;
      }

      const explicitTurnId = row.turn_id && row.turn_id !== 'legacy' ? row.turn_id.trim() : '';
      let turnId = explicitTurnId;
      if (!turnId && row.role === 'user') {
        turnId = `legacy-${row.conversation_id}-${row.id}`;
        activeLegacyTurns.set(row.conversation_id, turnId);
      } else if (!turnId) {
        turnId = activeLegacyTurns.get(row.conversation_id) ?? '';
      }

      if (!turnId) {
        quarantine.run(row.id, row.conversation_id, row.turn_id, row.role, row.content, row.timestamp, 'orphan_assistant');
        continue;
      }
      insertMessage.run(row.id, row.conversation_id, turnId, row.role, row.content, row.timestamp);
    }

    db.exec('DROP TABLE messages; ALTER TABLE messages_migrated RENAME TO messages;');
  })();
}

function migrateConversations(db: Database.Database): void {
  const columns = db.pragma('table_info(conversations)') as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'close_status')) return;
  db.exec(`
    ALTER TABLE conversations
    ADD COLUMN close_status TEXT NOT NULL DEFAULT 'open'
    CHECK (close_status IN ('open', 'completed', 'interrupted'))
  `);
}

function migrateMemoryStaging(db: Database.Database): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_staging'").get() as
    | { sql: string }
    | undefined;
  if (!table) return;
  const columns = db.pragma('table_info(memory_staging)') as Array<{ name: string }>;
  const hasPolicyTerms = columns.some((column) => column.name === 'policy_terms');
  const permitsFailed = table.sql.replace(/\s+/g, ' ').toLowerCase().includes("'failed'");
  if (hasPolicyTerms && permitsFailed) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE memory_staging_migrated (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id  INTEGER NOT NULL,
        turn_id          TEXT NOT NULL UNIQUE,
        source_content   TEXT NOT NULL,
        state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
        attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_started_at TEXT,
        policy_terms     TEXT NOT NULL DEFAULT '',
        created_at       TEXT DEFAULT (datetime('now')),
        updated_at       TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `);
    db.exec(`
      INSERT INTO memory_staging_migrated (
        id, conversation_id, turn_id, source_content, state, attempts,
        lease_started_at, policy_terms, created_at, updated_at
      )
      SELECT id, conversation_id, turn_id, source_content, state, attempts,
        lease_started_at, ${hasPolicyTerms ? 'policy_terms' : "''"}, created_at, updated_at
      FROM memory_staging;
      DROP TABLE memory_staging;
      ALTER TABLE memory_staging_migrated RENAME TO memory_staging;
    `);
  })();
}

function migrateStorageQuarantine(db: Database.Database): void {
  const columns = db.pragma('table_info(storage_quarantine)') as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'row_data')) return;
  db.exec("ALTER TABLE storage_quarantine ADD COLUMN row_data TEXT NOT NULL DEFAULT '{}'");
}
