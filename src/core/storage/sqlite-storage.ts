import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  CompleteMemoryStagingInput,
  StorageProvider,
  Filter,
  MessageRow,
  MessagesPageQuery,
  TurnMessageWrite,
  Layer2MemoryPurgeResult,
  LegacyDbRecoveryResult,
  LegacyDbRecoveryWrite,
  ConversationSummaryClear,
  Layer2LegacyPolicyPurgeInput,
  ApplyMemoryAuthorDeltaInput,
  ApplyMemoryAuthorDeltaResult,
} from './storage.interface.js';
import {
  LEGACY_DB_RECOVERY_CONFIRMATION,
  LEGACY_DB_RECOVERY_LOCATIONS,
  MESSAGES_PAGE_MAX_LIMIT,
  MemoryAuthorStaleWriteError,
} from './storage.interface.js';

export const SQLITE_SCHEMA_VERSION = 4;

const REMINDERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS reminders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    due_local    TEXT NOT NULL,
    text         TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending', 'firing', 'delivered', 'cancelled')),
    source_kind  TEXT NOT NULL DEFAULT 'local' CHECK (source_kind IN ('local')),
    origin_mode  TEXT NOT NULL DEFAULT 'chat' CHECK (origin_mode IN ('chat', 'voice')),
    private_context INTEGER NOT NULL DEFAULT 1 CHECK (private_context IN (0, 1)),
    external_id  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    firing_at    TEXT,
    delivered_at TEXT,
    cancelled_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_state ON reminders(state);
`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS absolute_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS persistent_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL DEFAULT '',
    rule       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS session_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule       TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at   TEXT,
    mode       TEXT NOT NULL DEFAULT 'ambient',
    summary    TEXT DEFAULT '',
    close_status TEXT NOT NULL DEFAULT 'open' CHECK (close_status IN ('open', 'completed', 'interrupted'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    turn_id         TEXT NOT NULL DEFAULT 'legacy',
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    timestamp       TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS message_quarantine (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    original_id     INTEGER,
    conversation_id INTEGER,
    turn_id         TEXT,
    role            TEXT,
    content         TEXT,
    timestamp       TEXT,
    reason          TEXT NOT NULL,
    quarantined_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS storage_quarantine (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_table    TEXT NOT NULL,
    source_row_id   INTEGER,
    column_name     TEXT NOT NULL,
    ciphertext      TEXT NOT NULL,
    row_data        TEXT NOT NULL DEFAULT '{}',
    reason          TEXT NOT NULL,
    quarantined_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory_staging (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  INTEGER NOT NULL,
    turn_id          TEXT NOT NULL UNIQUE,
    source_content   TEXT NOT NULL,
    state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
    attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_started_at TEXT,
    policy_terms     TEXT NOT NULL DEFAULT '',
    decision         TEXT CHECK (decision IN ('add', 'update', 'merge', 'supersede', 'ignore')),
    decision_topic_id INTEGER,
    result_memory_id INTEGER,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_topics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT,
    version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS curated_memories (
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
    FOREIGN KEY (superseded_by_id) REFERENCES curated_memories(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS memory_sources (
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

  CREATE INDEX IF NOT EXISTS idx_curated_memories_topic_status
    ON curated_memories(topic_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_sources_staging ON memory_sources(source_staging_id);
  CREATE INDEX IF NOT EXISTS idx_memory_sources_turn
    ON memory_sources(source_conversation_id, source_turn_id);

  CREATE TABLE IF NOT EXISTS learned_facts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL DEFAULT '',
    fact       TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    source     TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

export class SqliteStorage implements StorageProvider {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const db = new Database(dbPath);
    try {
      const schemaVersion = db.pragma('user_version', { simple: true }) as number;
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
        throw new Error(`SQLite schema version is invalid: ${schemaVersion}`);
      }
      if (schemaVersion > SQLITE_SCHEMA_VERSION) {
        throw new Error(
          `SQLite database uses newer schema version ${schemaVersion}; this build supports up to ${SQLITE_SCHEMA_VERSION}`,
        );
      }
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        let version = schemaVersion;
        while (version < SQLITE_SCHEMA_VERSION) {
          switch (version) {
            case 0:
              db.exec(SCHEMA);
              this.migrateConversations(db);
              this.migrateMessages(db);
              this.migrateMemoryStaging(db);
              this.migrateStorageQuarantine(db);
              version = 1;
              db.pragma(`user_version = ${version}`);
              break;
            case 1:
              db.exec(REMINDERS_SCHEMA);
              version = 2;
              db.pragma(`user_version = ${version}`);
              break;
            case 2: {
              const columns = new Set((db.pragma('table_info(reminders)') as Array<{ name: string }>)
                .map(({ name }) => name));
              if (!columns.has('origin_mode')) {
                db.exec("ALTER TABLE reminders ADD COLUMN origin_mode TEXT NOT NULL DEFAULT 'chat' CHECK (origin_mode IN ('chat', 'voice'));");
              }
              if (!columns.has('private_context')) {
                db.exec('ALTER TABLE reminders ADD COLUMN private_context INTEGER NOT NULL DEFAULT 1 CHECK (private_context IN (0, 1));');
              }
              version = 3;
              db.pragma(`user_version = ${version}`);
              break;
            }
            case 3:
              this.migrateMemoryAuthor(db);
              version = 4;
              db.pragma(`user_version = ${version}`);
              break;
            default:
              throw new Error(`No SQLite migration path from version ${version} to ${SQLITE_SCHEMA_VERSION}`);
          }
        }
        if (version !== SQLITE_SCHEMA_VERSION) {
          throw new Error(`No SQLite migration path from version ${version} to ${SQLITE_SCHEMA_VERSION}`);
        }
      });
      migrate();
      db.pragma('secure_delete = FAST');
      db.pragma('foreign_keys = ON');
      const violations = db.pragma('foreign_key_check') as Array<Record<string, string | number>>;
      if (violations.length > 0) {
        throw new Error(`SQLite foreign-key validation failed with ${violations.length} violation(s)`);
      }
      this.db = db;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the schema/pragma error that made construction fail.
      }
      throw error;
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value) as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.db
      .prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, JSON.stringify(value), JSON.stringify(value));
  }

  async query<T = Record<string, unknown>>(table: string, filter?: Filter): Promise<T[]> {
    this.assertTableName(table);

    if (!filter || Object.keys(filter).length === 0) {
      return this.db.prepare(`SELECT * FROM ${table}`).all() as T[];
    }

    const keys = Object.keys(filter);
    const where = keys.map((k) => `${this.assertColumnName(k)} = ?`).join(' AND ');
    const values = keys.map((k) => filter[k]);

    return this.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...values) as T[];
  }

  async insert(table: string, data: Record<string, unknown>): Promise<number> {
    this.assertTableName(table);
    if (table === 'curated_memories' && data.topic_id == null) {
      return this.db.transaction(() => {
        const topicId = this.db.prepare('INSERT INTO memory_topics (title) VALUES (NULL)').run().lastInsertRowid as number;
        const memoryId = this.insertRow(table, {
          ...data,
          topic_id: topicId,
          status: data.deleted_at == null ? 'active' : 'deleted',
          created_by_action: data.kind === 'explicit' ? 'explicit' : 'legacy_import',
        });
        this.insertMemorySource(memoryId, {
          source_staging_id: data.source_staging_id,
          source_conversation_id: data.source_conversation_id,
          source_turn_id: data.source_turn_id,
          source_type: data.kind === 'explicit' ? 'explicit' : 'legacy',
        });
        return memoryId;
      })();
    }
    return this.insertRow(table, data);
  }

  private insertRow(table: string, data: Record<string, unknown>): number {
    const keys = Object.keys(data);
    const cols = keys.map((k) => this.assertColumnName(k)).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map((k) => data[k]);

    const result = this.db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`).run(...values);
    return result.lastInsertRowid as number;
  }

  async reserveRowIds(table: string, count: number): Promise<number[]> {
    this.assertTableName(table);
    if (!Number.isInteger(count) || count <= 0 || count > 10_000) {
      throw new Error(`Invalid row identity reservation count: ${count}`);
    }
    const tableSql = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { sql: string } | undefined;
    if (!tableSql?.sql.toUpperCase().includes('AUTOINCREMENT')) {
      throw new Error(`Table ${table} does not support reserved row identities`);
    }

    return this.db.transaction(() => {
      const sequence = this.db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as
        | { seq: number }
        | undefined;
      const maximum = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`).get() as { id: number };
      const first = Math.max(sequence?.seq ?? 0, maximum.id) + 1;
      const last = first + count - 1;
      const updated = this.db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(last, table);
      if (updated.changes === 0) {
        this.db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, last);
      }
      return Array.from({ length: count }, (_, index) => first + index);
    })();
  }

  async insertTurnMessages(
    conversationId: number,
    turnId: string,
    messages: readonly TurnMessageWrite[],
  ): Promise<void> {
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new Error(`Invalid conversationId: ${conversationId}`);
    }
    if (turnId.trim().length === 0) throw new Error('turnId must not be empty');
    if (messages.length === 0) return;
    const insert = this.db.prepare(
      'INSERT INTO messages (id, conversation_id, turn_id, role, content) VALUES (?, ?, ?, ?, ?)',
    );
    const writeTurn = this.db.transaction((rows: readonly TurnMessageWrite[]) => {
      for (const row of rows) insert.run(row.id ?? null, conversationId, turnId, row.role, row.content);
    });
    writeTurn(messages);
  }

  async persistTurnWithMemoryStaging(
    conversationId: number,
    turnId: string,
    messages: readonly TurnMessageWrite[],
    stagingSource: string,
    policyTerms = '',
    stagingId?: number,
  ): Promise<number> {
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new Error(`Invalid conversationId: ${conversationId}`);
    }
    if (turnId.trim().length === 0) throw new Error('turnId must not be empty');
    if (stagingSource.trim().length === 0) throw new Error('stagingSource must not be empty');

    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM memory_staging WHERE turn_id = ?').get(turnId) as
        | { id: number }
        | undefined;
      if (existing) return existing.id;
      // Heal a legacy partial write (messages committed, staging failed) before
      // replacing it with the new all-or-nothing representation.
      this.db.prepare(
        'DELETE FROM messages WHERE conversation_id = ? AND turn_id = ?',
      ).run(conversationId, turnId);
      const insertMessage = this.db.prepare(
        'INSERT INTO messages (id, conversation_id, turn_id, role, content) VALUES (?, ?, ?, ?, ?)',
      );
      for (const message of messages) {
        insertMessage.run(message.id ?? null, conversationId, turnId, message.role, message.content);
      }
      const result = this.db.prepare(`
        INSERT INTO memory_staging (
          id, conversation_id, turn_id, source_content, state, attempts,
          lease_started_at, policy_terms
        ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?)
      `).run(stagingId ?? null, conversationId, turnId, stagingSource, policyTerms);
      return result.lastInsertRowid as number;
    })();
  }

  async deleteTurnMessages(conversationId: number, turnId: string): Promise<number> {
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new Error(`Invalid conversationId: ${conversationId}`);
    }
    if (turnId.trim().length === 0) throw new Error('turnId must not be empty');
    return this.db
      .prepare('DELETE FROM messages WHERE conversation_id = ? AND turn_id = ?')
      .run(conversationId, turnId).changes;
  }

  async completeMemoryStaging(input: CompleteMemoryStagingInput): Promise<void> {
    if (!Number.isInteger(input.stagingId) || input.stagingId <= 0) {
      throw new Error(`Invalid stagingId: ${input.stagingId}`);
    }
    if (input.memory.sourceTurnId.trim().length === 0) {
      throw new Error('sourceTurnId must not be empty');
    }
    if (!Number.isFinite(input.memory.confidence) || input.memory.confidence < 0 || input.memory.confidence > 1) {
      throw new Error(`Invalid memory confidence: ${input.memory.confidence}`);
    }

    const complete = this.db.transaction(() => {
      const staging = this.db.prepare(
        'SELECT id, conversation_id, turn_id FROM memory_staging WHERE id = ?',
      ).get(input.stagingId) as { id: number; conversation_id: number; turn_id: string } | undefined;
      if (!staging) throw new Error(`Memory staging item ${input.stagingId} does not exist`);
      if (
        (input.memory.sourceConversationId !== null && input.memory.sourceConversationId !== staging.conversation_id) ||
        input.memory.sourceTurnId !== staging.turn_id
      ) {
        throw new Error(`Curated memory source does not match staging item ${input.stagingId}`);
      }

      const topicId = this.db.prepare(
        'INSERT INTO memory_topics (title) VALUES (NULL)',
      ).run().lastInsertRowid as number;
      this.db.prepare(`
        INSERT INTO curated_memories (
          id, source_staging_id, kind, content, source_conversation_id,
          source_turn_id, confidence, topic_id, created_by_action
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_staging_id) DO NOTHING
      `).run(
        input.memory.id ?? null,
        input.stagingId,
        input.memory.kind,
        input.memory.content,
        input.memory.sourceConversationId,
        input.memory.sourceTurnId,
        input.memory.confidence,
        topicId,
        input.memory.kind === 'explicit' ? 'explicit' : 'legacy_import',
      );
      const inserted = this.db.prepare(
        'SELECT id FROM curated_memories WHERE source_staging_id = ?',
      ).get(input.stagingId) as { id: number } | undefined;
      if (inserted) {
        this.insertMemorySource(inserted.id, {
          source_staging_id: input.stagingId,
          source_conversation_id: input.memory.sourceConversationId,
          source_turn_id: input.memory.sourceTurnId,
          source_type: 'turn',
        });
      } else {
        this.db.prepare('DELETE FROM memory_topics WHERE id = ?').run(topicId);
      }
      this.db.prepare(`
        UPDATE memory_staging
        SET state = 'completed', source_content = '', lease_started_at = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(input.stagingId);
      this.db.prepare(
        'DELETE FROM messages WHERE conversation_id = ? AND turn_id = ?',
      ).run(staging.conversation_id, staging.turn_id);
    });
    complete();
  }

  async applyMemoryAuthorDelta(
    input: ApplyMemoryAuthorDeltaInput,
  ): Promise<ApplyMemoryAuthorDeltaResult> {
    this.validateMemoryAuthorDelta(input);
    return this.db.transaction(() => {
      const staging = this.db.prepare(`
        SELECT id, conversation_id, turn_id, state
        FROM memory_staging WHERE id = ?
      `).get(input.stagingId) as {
        id: number;
        conversation_id: number;
        turn_id: string;
        state: string;
      } | undefined;
      if (!staging || staging.state !== 'processing') {
        throw new MemoryAuthorStaleWriteError(`Memory Author staging item ${input.stagingId} is stale`);
      }

      if (input.action === 'ignore') {
        this.db.prepare(`
          UPDATE memory_staging
          SET state = 'completed', source_content = '', policy_terms = '', decision = 'ignore',
            decision_topic_id = NULL, result_memory_id = NULL,
            lease_started_at = NULL, updated_at = datetime('now')
          WHERE id = ?
        `).run(input.stagingId);
        this.db.prepare(
          'DELETE FROM messages WHERE conversation_id = ? AND turn_id = ?',
        ).run(staging.conversation_id, staging.turn_id);
        return { action: 'ignore' as const, topicId: null, memoryId: null };
      }

      let topicId: number;
      if (input.newTopic) {
        topicId = this.insertRow('memory_topics', {
          id: input.newTopic.id,
          title: input.newTopic.title,
          version: 1,
        });
      } else {
        const topic = this.db.prepare(`
          SELECT id, version, deleted_at FROM memory_topics WHERE id = ?
        `).get(input.topic!.id) as { id: number; version: number; deleted_at: string | null } | undefined;
        if (!topic || topic.deleted_at !== null || topic.version !== input.topic!.version) {
          throw new MemoryAuthorStaleWriteError(`Memory Author topic ${input.topic!.id} is stale`);
        }
        topicId = topic.id;
      }

      const targets = input.targets.map((target) => {
        const row = this.db.prepare(`
          SELECT id, topic_id, revision, status FROM curated_memories WHERE id = ?
        `).get(target.id) as {
          id: number;
          topic_id: number;
          revision: number;
          status: string;
        } | undefined;
        if (!row || row.topic_id !== topicId || row.status !== 'active' || row.revision !== target.revision) {
          throw new MemoryAuthorStaleWriteError(`Memory Author target ${target.id} is stale`);
        }
        return row;
      });
      const statement = input.statement!;
      const revision = targets.length === 0
        ? 1
        : Math.max(...targets.map(({ revision: targetRevision }) => targetRevision)) + 1;
      const memoryId = this.insertRow('curated_memories', {
        id: statement.id,
        source_staging_id: input.stagingId,
        kind: statement.kind,
        content: statement.content,
        evidence: statement.evidence,
        source_conversation_id: staging.conversation_id,
        source_turn_id: staging.turn_id,
        confidence: statement.confidence,
        topic_id: topicId,
        status: 'active',
        revision,
        superseded_by_id: null,
        created_by_action: input.action,
        confirmation_count: 1,
        last_confirmed_at: new Date().toISOString(),
        deleted_at: null,
      });

      if (targets.length > 0) {
        const retire = this.db.prepare(`
          UPDATE curated_memories
          SET status = 'superseded', superseded_by_id = ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'active'
        `);
        for (const target of targets) {
          if (retire.run(memoryId, target.id).changes !== 1) {
            throw new MemoryAuthorStaleWriteError(`Memory Author target ${target.id} changed during commit`);
          }
          this.db.prepare(`
            INSERT OR IGNORE INTO memory_sources (
              memory_id, source_key, source_type, source_staging_id,
              source_conversation_id, source_turn_id, observed_at
            )
            SELECT ?, source_key, source_type, source_staging_id,
              source_conversation_id, source_turn_id, observed_at
            FROM memory_sources WHERE memory_id = ?
          `).run(memoryId, target.id);
        }
      }
      this.insertMemorySource(memoryId, {
        source_staging_id: input.stagingId,
        source_conversation_id: staging.conversation_id,
        source_turn_id: staging.turn_id,
        source_type: 'turn',
      });

      if (!input.newTopic) {
        const changed = this.db.prepare(`
          UPDATE memory_topics
          SET version = version + 1, updated_at = datetime('now')
          WHERE id = ? AND version = ? AND deleted_at IS NULL
        `).run(topicId, input.topic!.version).changes;
        if (changed !== 1) {
          throw new MemoryAuthorStaleWriteError(`Memory Author topic ${topicId} changed during commit`);
        }
      }
      this.db.prepare(`
        UPDATE memory_staging
        SET state = 'completed', source_content = '', decision = ?,
          decision_topic_id = ?, result_memory_id = ?, lease_started_at = NULL,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(input.action, topicId, memoryId, input.stagingId);
      this.db.prepare(
        'DELETE FROM messages WHERE conversation_id = ? AND turn_id = ?',
      ).run(staging.conversation_id, staging.turn_id);
      return { action: input.action, topicId, memoryId };
    })();
  }

  async discardMemoryStaging(stagingId: number): Promise<void> {
    if (!Number.isInteger(stagingId) || stagingId <= 0) {
      throw new Error(`Invalid stagingId: ${stagingId}`);
    }
    const discard = this.db.transaction(() => {
      const staging = this.db.prepare(
        'SELECT conversation_id, turn_id FROM memory_staging WHERE id = ?',
      ).get(stagingId) as { conversation_id: number; turn_id: string } | undefined;
      if (!staging) throw new Error(`Memory staging item ${stagingId} does not exist`);
      this.db.prepare(`
        UPDATE memory_staging
        SET state = 'completed', source_content = '', policy_terms = '',
          lease_started_at = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(stagingId);
      this.db.prepare(
        'DELETE FROM messages WHERE conversation_id = ? AND turn_id = ?',
      ).run(staging.conversation_id, staging.turn_id);
    });
    discard();
  }

  async failMemoryStaging(stagingId: number): Promise<void> {
    if (!Number.isInteger(stagingId) || stagingId <= 0) {
      throw new Error(`Invalid stagingId: ${stagingId}`);
    }
    this.db.transaction(() => {
      const staging = this.db.prepare(
        'SELECT conversation_id, turn_id FROM memory_staging WHERE id = ?',
      ).get(stagingId) as { conversation_id: number; turn_id: string } | undefined;
      if (!staging) throw new Error(`Memory staging item ${stagingId} does not exist`);
      this.db.prepare(`
        UPDATE memory_staging
        SET state = 'failed', lease_started_at = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(stagingId);
    })();
  }

  async purgeAllLayer2Memory(
    conversationSummaries?: readonly ConversationSummaryClear[],
  ): Promise<Layer2MemoryPurgeResult> {
    const result = this.db.transaction(() => {
      const conversations = this.db.prepare('SELECT id FROM conversations ORDER BY id').all() as Array<{ id: number }>;
      const summaries = conversationSummaries ?? conversations.map(({ id }) => ({ id, value: '' }));
      if (summaries.length !== conversations.length
        || new Set(summaries.map(({ id }) => id)).size !== summaries.length
        || conversations.some(({ id }) => !summaries.some((summary) => summary.id === id))
        || summaries.some(({ id, value }) => !Number.isInteger(id) || id <= 0 || typeof value !== 'string')) {
        throw new Error('Conversation summary purge does not cover the complete database');
      }
      const turnCount = this.db.prepare(
        "SELECT COUNT(DISTINCT conversation_id || ':' || turn_id) AS count FROM messages",
      ).get() as { count: number };
      const stagingCount = this.db.prepare('SELECT COUNT(*) AS count FROM memory_staging').get() as { count: number };
      const memoryCount = this.db.prepare('SELECT COUNT(*) AS count FROM curated_memories').get() as { count: number };
      const legacyCount = this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM learned_facts)
          + (SELECT COUNT(*) FROM persistent_rules)
          + (SELECT COUNT(*) FROM session_rules) AS count
      `).get() as { count: number };
      const messageQuarantineCount = this.db.prepare(
        'SELECT COUNT(*) AS count FROM message_quarantine',
      ).get() as { count: number };
      const quarantineCount = this.db.prepare(`
        WITH RECURSIVE related(id) AS (
          SELECT id FROM storage_quarantine
          WHERE source_table IN (
            'messages', 'memory_staging', 'curated_memories', 'memory_topics', 'memory_sources',
            'learned_facts', 'persistent_rules', 'session_rules', 'message_quarantine'
          )
             OR (source_table = 'conversations' AND column_name = 'summary')
          UNION
          SELECT quarantine.id
          FROM storage_quarantine AS quarantine
          JOIN related ON quarantine.source_table = 'storage_quarantine'
            AND quarantine.source_row_id = related.id
        )
        SELECT COUNT(*) AS count FROM related
      `).get() as { count: number };

      this.db.prepare('DELETE FROM curated_memories').run();
      this.db.prepare('DELETE FROM memory_sources').run();
      this.db.prepare('DELETE FROM memory_topics').run();
      this.db.prepare('DELETE FROM memory_staging').run();
      this.db.prepare('DELETE FROM messages').run();
      this.db.prepare('DELETE FROM message_quarantine').run();
      this.db.prepare('DELETE FROM learned_facts').run();
      this.db.prepare('DELETE FROM persistent_rules').run();
      this.db.prepare('DELETE FROM session_rules').run();
      const clearSummary = this.db.prepare('UPDATE conversations SET summary = ? WHERE id = ?');
      for (const summary of summaries) clearSummary.run(summary.value, summary.id);
      this.db.prepare(`
        WITH RECURSIVE related(id) AS (
          SELECT id FROM storage_quarantine
          WHERE source_table IN (
            'messages', 'memory_staging', 'curated_memories', 'memory_topics', 'memory_sources',
            'learned_facts', 'persistent_rules', 'session_rules', 'message_quarantine'
          )
             OR (source_table = 'conversations' AND column_name = 'summary')
          UNION
          SELECT quarantine.id
          FROM storage_quarantine AS quarantine
          JOIN related ON quarantine.source_table = 'storage_quarantine'
            AND quarantine.source_row_id = related.id
        )
        DELETE FROM storage_quarantine WHERE id IN (SELECT id FROM related)
      `).run();

      return {
        turns: turnCount.count,
        staging: stagingCount.count,
        memories: memoryCount.count,
        legacy: legacyCount.count,
        quarantine: messageQuarantineCount.count + quarantineCount.count,
      };
    })();
    await this.finalizePrivacyDeletion();
    return result;
  }

  /**
   * @param expectedIds - IDs shown to the user before destructive confirmation.
   *
   * - Verifies that the confirmed set still matches the database exactly.
   * - Deletes curated rows and their recursive quarantine copies in one transaction.
   *
   * @returns Number of deleted curated memories.
   *
   * @category Data Access Security
   */
  async deleteAllCuratedMemories(expectedIds: readonly number[]): Promise<number> {
    if (expectedIds.some((id) => !Number.isInteger(id) || id <= 0)
      || new Set(expectedIds).size !== expectedIds.length) {
      throw new Error('Curated-memory deletion requires unique positive integer IDs');
    }
    const confirmedIds = [...expectedIds].sort((left, right) => left - right);
    const deleted = this.db.transaction(() => {
      const currentIds = (this.db.prepare(
        'SELECT id FROM curated_memories ORDER BY id',
      ).all() as Array<{ id: number }>).map(({ id }) => id);
      if (currentIds.length !== confirmedIds.length
        || currentIds.some((id, index) => id !== confirmedIds[index])) {
        throw new Error('Curated memories changed after deletion was requested');
      }
      const result = this.db.prepare('DELETE FROM curated_memories').run();
      this.db.prepare('DELETE FROM memory_sources').run();
      this.db.prepare('DELETE FROM memory_topics').run();
      this.db.prepare(`
        WITH RECURSIVE related(id) AS (
          SELECT id FROM storage_quarantine
          WHERE source_table IN ('curated_memories', 'memory_topics', 'memory_sources')
          UNION
          SELECT quarantine.id
          FROM storage_quarantine AS quarantine
          JOIN related ON quarantine.source_table = 'storage_quarantine'
            AND quarantine.source_row_id = related.id
        )
        DELETE FROM storage_quarantine WHERE id IN (SELECT id FROM related)
      `).run();
      return result.changes;
    })();
    if (deleted > 0) await this.finalizePrivacyDeletion();
    return deleted;
  }

  async purgeLayer2LegacyMemory(input: Layer2LegacyPolicyPurgeInput): Promise<number> {
    const selected = {
      learned_facts: new Set(input.learnedFactIds),
      persistent_rules: new Set(input.persistentRuleIds),
      session_rules: new Set(input.sessionRuleIds),
    };
    for (const ids of Object.values(selected)) {
      if ([...ids].some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new Error('Legacy Layer-2 purge requires positive integer row IDs');
      }
    }

    return this.db.transaction(() => {
      const quarantined = this.db.prepare(`
        SELECT source_table, source_row_id
        FROM storage_quarantine
        WHERE source_table IN ('learned_facts', 'persistent_rules', 'session_rules')
          AND source_row_id IS NOT NULL
      `).all() as Array<{ source_table: keyof typeof selected; source_row_id: number }>;
      for (const row of quarantined) selected[row.source_table].add(row.source_row_id);

      let deleted = 0;
      for (const [table, ids] of Object.entries(selected)) {
        const remove = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
        for (const id of ids) deleted += remove.run(id).changes;
      }
      this.db.prepare(`
        WITH RECURSIVE related(id) AS (
          SELECT id FROM storage_quarantine
          WHERE source_table IN ('learned_facts', 'persistent_rules', 'session_rules')
          UNION
          SELECT quarantine.id
          FROM storage_quarantine AS quarantine
          JOIN related ON quarantine.source_table = 'storage_quarantine'
            AND quarantine.source_row_id = related.id
        )
        DELETE FROM storage_quarantine WHERE id IN (SELECT id FROM related)
      `).run();
      return deleted;
    })();
  }

  async purgeQuarantinedLayer2Memory(): Promise<Layer2MemoryPurgeResult> {
    return this.db.transaction(() => {
      const affectedCtes = `
        affected_turns(conversation_id, turn_id) AS (
          SELECT message.conversation_id, message.turn_id
          FROM messages AS message
          JOIN storage_quarantine AS quarantine
            ON quarantine.source_table = 'messages'
           AND quarantine.source_row_id = message.id
          UNION
          SELECT staging.conversation_id, staging.turn_id
          FROM memory_staging AS staging
          JOIN storage_quarantine AS quarantine
            ON quarantine.source_table = 'memory_staging'
           AND quarantine.source_row_id = staging.id
        ),
        affected_staging(id) AS (
          SELECT staging.id
          FROM memory_staging AS staging
          JOIN affected_turns AS turn
            ON turn.conversation_id = staging.conversation_id
           AND turn.turn_id = staging.turn_id
          UNION
          SELECT source_row_id FROM storage_quarantine
          WHERE source_table = 'memory_staging' AND source_row_id IS NOT NULL
        ),
        quarantined_topics(id) AS (
          SELECT source_row_id FROM storage_quarantine
          WHERE source_table = 'memory_topics' AND source_row_id IS NOT NULL
        ),
        affected_memories(id) AS (
          SELECT memory.id
          FROM curated_memories AS memory
          WHERE memory.source_staging_id IN (SELECT id FROM affected_staging)
             OR EXISTS (
               SELECT 1 FROM affected_turns AS turn
               WHERE turn.conversation_id = memory.source_conversation_id
                 AND turn.turn_id = memory.source_turn_id
             )
             OR EXISTS (
               SELECT 1 FROM memory_sources AS source
               WHERE source.memory_id = memory.id
                 AND (source.source_staging_id IN (SELECT id FROM affected_staging)
                   OR EXISTS (
                     SELECT 1 FROM affected_turns AS turn
                     WHERE turn.conversation_id = source.source_conversation_id
                       AND turn.turn_id = source.source_turn_id
                   ))
             )
             OR memory.topic_id IN (SELECT id FROM quarantined_topics)
          UNION
          SELECT source_row_id FROM storage_quarantine
          WHERE source_table = 'curated_memories' AND source_row_id IS NOT NULL
        ),
        affected_topics(id) AS (
          SELECT id FROM quarantined_topics
          UNION
          SELECT topic_id FROM curated_memories WHERE id IN (SELECT id FROM affected_memories)
        )
      `;
      const turns = this.db.prepare(`
        WITH ${affectedCtes}
        SELECT conversation_id, turn_id FROM affected_turns
      `).all() as Array<{ conversation_id: number; turn_id: string }>;
      const stagingIds = this.db.prepare(`
        WITH ${affectedCtes}
        SELECT id FROM affected_staging
      `).all() as Array<{ id: number }>;
      const memoryIds = this.db.prepare(`
        WITH ${affectedCtes}
        SELECT id FROM affected_memories
      `).all() as Array<{ id: number }>;
      const topicIds = this.db.prepare(`
        WITH ${affectedCtes}
        SELECT id FROM affected_topics
      `).all() as Array<{ id: number }>;
      const quarantineCount = this.db.prepare(`
        WITH RECURSIVE related(id) AS (
          SELECT id FROM storage_quarantine
          WHERE source_table IN ('messages', 'memory_staging', 'curated_memories', 'memory_topics', 'memory_sources', 'message_quarantine')
          UNION
          SELECT quarantine.id
          FROM storage_quarantine AS quarantine
          JOIN related ON quarantine.source_table = 'storage_quarantine'
            AND quarantine.source_row_id = related.id
        )
        SELECT COUNT(*) AS count FROM related
      `).get() as { count: number };
      const messageQuarantineCount = this.db.prepare(
        'SELECT COUNT(*) AS count FROM message_quarantine',
      ).get() as { count: number };

      const deleteMemory = this.db.prepare('DELETE FROM curated_memories WHERE id = ?');
      for (const memory of memoryIds) deleteMemory.run(memory.id);
      const deleteTopic = this.db.prepare(`
        DELETE FROM memory_topics
        WHERE id = ? AND NOT EXISTS (SELECT 1 FROM curated_memories WHERE topic_id = memory_topics.id)
      `);
      for (const topic of topicIds) deleteTopic.run(topic.id);
      const deleteStaging = this.db.prepare('DELETE FROM memory_staging WHERE id = ?');
      for (const staging of stagingIds) deleteStaging.run(staging.id);
      const deleteTurn = this.db.prepare(
        'DELETE FROM messages WHERE conversation_id = ? AND turn_id = ?',
      );
      for (const turn of turns) deleteTurn.run(turn.conversation_id, turn.turn_id);
      this.db.prepare('DELETE FROM message_quarantine').run();
      this.db.prepare(`
        WITH RECURSIVE related(id) AS (
          SELECT id FROM storage_quarantine
          WHERE source_table IN ('messages', 'memory_staging', 'curated_memories', 'memory_topics', 'memory_sources', 'message_quarantine')
          UNION
          SELECT quarantine.id
          FROM storage_quarantine AS quarantine
          JOIN related ON quarantine.source_table = 'storage_quarantine'
            AND quarantine.source_row_id = related.id
        )
        DELETE FROM storage_quarantine WHERE id IN (SELECT id FROM related)
      `).run();

      return {
        turns: turns.length,
        staging: stagingIds.length,
        memories: memoryIds.length,
        legacy: 0,
        quarantine: messageQuarantineCount.count + quarantineCount.count,
      };
    })();
  }

  async purgeQuarantinedReminders(): Promise<number> {
    return this.db.transaction(() => {
      const reminderIds = (this.db.prepare(`
        SELECT DISTINCT source_row_id AS id
        FROM storage_quarantine
        WHERE source_table = 'reminders' AND source_row_id IS NOT NULL
      `).all() as Array<{ id: number }>).map(({ id }) => id);
      const removeReminder = this.db.prepare('DELETE FROM reminders WHERE id = ?');
      for (const id of reminderIds) removeReminder.run(id);
      this.db.prepare(`
        WITH RECURSIVE related(id) AS (
          SELECT id FROM storage_quarantine WHERE source_table = 'reminders'
          UNION
          SELECT quarantine.id
          FROM storage_quarantine AS quarantine
          JOIN related ON quarantine.source_table = 'storage_quarantine'
            AND quarantine.source_row_id = related.id
        )
        DELETE FROM storage_quarantine WHERE id IN (SELECT id FROM related)
      `).run();
      return reminderIds.length;
    })();
  }

  async restoreReviewedLegacyDbValues(
    confirmation: string,
    writes: readonly LegacyDbRecoveryWrite[],
  ): Promise<LegacyDbRecoveryResult> {
    if (confirmation !== LEGACY_DB_RECOVERY_CONFIRMATION) {
      throw new Error('Explicit legacy DB recovery confirmation is required');
    }
    if (writes.length === 0) throw new Error('No reviewed legacy DB values selected');
    if (this.dbPath === ':memory:') throw new Error('Legacy DB recovery requires a file-backed database');

    const backupPath = `${this.dbPath}.legacy-recovery-${Date.now()}-${randomUUID()}.bak`;
    const escapedBackupPath = backupPath.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escapedBackupPath}'`);

    const restore = this.db.transaction(() => {
      const allowedLocations = new Set<string>(LEGACY_DB_RECOVERY_LOCATIONS);
      for (const write of writes) {
        const table = this.assertTableName(write.table);
        const column = this.assertColumnName(write.column);
        if (!allowedLocations.has(`${table}.${column}`)) {
          throw new Error(`Legacy DB recovery is not allowed for ${table}.${column}`);
        }
        const quarantine = this.db.prepare(`
          SELECT source_table, source_row_id, column_name, reason
          FROM storage_quarantine WHERE id = ?
        `).get(write.quarantineId) as {
          source_table: string;
          source_row_id: number | null;
          column_name: string;
          reason: string;
        } | undefined;
        if (!quarantine
          || quarantine.reason !== 'unbound_legacy_ciphertext'
          || quarantine.source_table !== table
          || quarantine.source_row_id !== write.rowId
          || quarantine.column_name !== column) {
          throw new Error(`Legacy recovery candidate ${write.quarantineId} changed after review`);
        }
        const current = this.db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(write.rowId) as
          | { value: string }
          | undefined;
        if (!current || current.value !== write.legacyCiphertext) {
          throw new Error(`Legacy recovery source ${table}:${write.rowId}:${column} changed after review`);
        }
        this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(write.encryptedValue, write.rowId);
      }
      for (const write of writes) {
        this.db.prepare(`
          WITH RECURSIVE related(id) AS (
            SELECT ?
            UNION
            SELECT quarantine.id FROM storage_quarantine AS quarantine
            JOIN related ON quarantine.source_table = 'storage_quarantine'
              AND quarantine.source_row_id = related.id
          )
          DELETE FROM storage_quarantine WHERE id IN (SELECT id FROM related)
        `).run(write.quarantineId);
      }
    });
    restore();
    return { restored: writes.length, backupPath };
  }

  async update(table: string, filter: Filter, data: Record<string, unknown>): Promise<number> {
    this.assertTableName(table);
    const setCols = Object.keys(data);
    const setClause = setCols.map((k) => `${this.assertColumnName(k)} = ?`).join(', ');
    const setValues = setCols.map((k) => data[k]);

    const filterKeys = Object.keys(filter);
    const whereClause = filterKeys.map((k) => `${this.assertColumnName(k)} = ?`).join(' AND ');
    const filterValues = filterKeys.map((k) => filter[k]);

    const result = this.db
      .prepare(`UPDATE ${table} SET ${setClause} WHERE ${whereClause}`)
      .run(...setValues, ...filterValues);
    return result.changes;
  }

  async delete(table: string, filter: Filter): Promise<number> {
    this.assertTableName(table);
    const keys = Object.keys(filter);
    const where = keys.map((k) => `${this.assertColumnName(k)} = ?`).join(' AND ');
    const values = keys.map((k) => filter[k]);

    const result = this.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...values);
    return result.changes;
  }

  /**
   * Scrubs remnants after an explicit privacy deletion without taxing ordinary deletes.
   *
   * - Enables full secure-delete only for the compaction window.
   * - Truncates WAL before and after a full database rebuild.
   * - Restores FAST mode for low-cost defense in depth during normal operation.
   *
   * @category Data Access Security
   */
  async finalizePrivacyDeletion(): Promise<void> {
    if (this.dbPath === ':memory:') return;
    this.db.pragma('secure_delete = ON');
    try {
      this.requireWalCheckpoint('before privacy VACUUM');
      this.db.exec('VACUUM');
      this.requireWalCheckpoint('after privacy VACUUM');
    } finally {
      this.db.pragma('secure_delete = FAST');
    }
  }

  async queryMessagesPage(query: MessagesPageQuery): Promise<MessageRow[]> {
    if (!Number.isInteger(query.limit) || query.limit <= 0 || query.limit > MESSAGES_PAGE_MAX_LIMIT) {
      throw new Error(`Invalid limit: ${query.limit} (must be an integer in 1..${MESSAGES_PAGE_MAX_LIMIT})`);
    }
    if (!Number.isInteger(query.excludeConversationId)) {
      throw new Error(`Invalid excludeConversationId: ${query.excludeConversationId} (must be an integer)`);
    }
    // messages.id is an INTEGER PRIMARY KEY (rowid alias): ORDER BY id DESC is a
    // backwards rowid scan that stops after `limit` matches — no extra index needed.
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id != ? ORDER BY id DESC LIMIT ?')
      .all(query.excludeConversationId, query.limit) as MessageRow[];
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private validateMemoryAuthorDelta(input: ApplyMemoryAuthorDeltaInput): void {
    if (!Number.isInteger(input.stagingId) || input.stagingId <= 0) {
      throw new Error(`Invalid Memory Author staging ID: ${input.stagingId}`);
    }
    const targetIds = input.targets.map(({ id }) => id);
    if (targetIds.some((id) => !Number.isInteger(id) || id <= 0)
      || new Set(targetIds).size !== targetIds.length
      || input.targets.some(({ revision }) => !Number.isInteger(revision) || revision <= 0)) {
      throw new Error('Memory Author targets must be unique positive IDs with positive revisions');
    }
    if (input.action === 'ignore') {
      if (input.topic || input.newTopic || input.statement || input.targets.length > 0) {
        throw new Error('Memory Author ignore must not contain write targets');
      }
      return;
    }
    if ((input.topic == null) === (input.newTopic == null)) {
      throw new Error('Memory Author write requires exactly one existing or new topic');
    }
    if (input.topic && (!Number.isInteger(input.topic.id) || input.topic.id <= 0
      || !Number.isInteger(input.topic.version) || input.topic.version <= 0)) {
      throw new Error('Memory Author topic snapshot is invalid');
    }
    if (input.newTopic && (typeof input.newTopic.title !== 'string' || input.newTopic.title.trim() === '')) {
      throw new Error('Memory Author new topic title must not be empty');
    }
    if (!input.statement
      || typeof input.statement.content !== 'string' || input.statement.content.trim() === ''
      || typeof input.statement.evidence !== 'string' || input.statement.evidence.trim() === ''
      || !Number.isFinite(input.statement.confidence)
      || input.statement.confidence < 0 || input.statement.confidence > 1) {
      throw new Error('Memory Author statement is invalid');
    }
    const expectedTargets = input.action === 'add'
      ? input.targets.length === 0
      : input.action === 'merge'
        ? input.targets.length >= 2
        : input.targets.length >= 1;
    if (!expectedTargets) throw new Error(`Memory Author ${input.action} target count is invalid`);
    if (input.action !== 'add' && input.newTopic) {
      throw new Error(`Memory Author ${input.action} requires an existing topic`);
    }
  }

  private insertMemorySource(
    memoryId: number,
    source: {
      source_staging_id?: unknown;
      source_conversation_id?: unknown;
      source_turn_id?: unknown;
      source_type: 'turn' | 'explicit' | 'manual' | 'legacy';
    },
  ): void {
    const stagingId = typeof source.source_staging_id === 'number' ? source.source_staging_id : null;
    const conversationId = typeof source.source_conversation_id === 'number'
      ? source.source_conversation_id
      : null;
    const turnId = typeof source.source_turn_id === 'string' && source.source_turn_id.trim()
      ? source.source_turn_id
      : null;
    const sourceKey = stagingId != null
      ? `staging:${stagingId}`
      : `turn:${conversationId ?? 'unknown'}:${turnId ?? 'unknown'}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO memory_sources (
        memory_id, source_key, source_type, source_staging_id,
        source_conversation_id, source_turn_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(memoryId, sourceKey, source.source_type, stagingId, conversationId, turnId);
  }

  private migrateMemoryAuthor(db: Database.Database): void {
    const memoryColumns = new Set((db.pragma('table_info(curated_memories)') as Array<{ name: string }>)
      .map(({ name }) => name));
    if (memoryColumns.size === 0) {
      db.exec(SCHEMA);
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

  /**
   * Rebuilds legacy messages with referential/role constraints and stable turn IDs.
   * Valid legacy rows are preserved; rows that cannot form a safe turn are quarantined.
   */
  private migrateMessages(db: Database.Database): void {
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

    const migrate = db.transaction(() => {
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
    });
    migrate();
  }

  private migrateConversations(db: Database.Database): void {
    const columns = db.pragma('table_info(conversations)') as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'close_status')) return;
    db.exec(`
      ALTER TABLE conversations
      ADD COLUMN close_status TEXT NOT NULL DEFAULT 'open'
      CHECK (close_status IN ('open', 'completed', 'interrupted'))
    `);
  }

  private migrateMemoryStaging(db: Database.Database): void {
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

  private migrateStorageQuarantine(db: Database.Database): void {
    const columns = db.pragma('table_info(storage_quarantine)') as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'row_data')) return;
    db.exec("ALTER TABLE storage_quarantine ADD COLUMN row_data TEXT NOT NULL DEFAULT '{}'");
  }

  private requireWalCheckpoint(stage: string): void {
    const [result] = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    if (!result || result.busy !== 0) {
      throw new Error(`SQLite privacy deletion could not truncate WAL ${stage}`);
    }
  }

  /** Prevent SQL injection by validating table/column names are alphanumeric + underscore. */
  private assertTableName(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid table name: ${name}`);
    }
    return name;
  }

  private assertColumnName(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid column name: ${name}`);
    }
    return name;
  }
}

interface LegacyMessageRow {
  id: number;
  conversation_id: number;
  turn_id: string;
  role: string;
  content: string;
  timestamp: string | null;
}
