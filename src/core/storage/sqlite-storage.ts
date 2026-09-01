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
import {
  REMINDERS_SCHEMA,
  SQLITE_SCHEMA,
  SQLITE_SCHEMA_VERSION,
} from './sqlite-schema.js';
import {
  migrateLegacySqliteSchema,
  migrateMemoryAuthorSchema,
} from './sqlite-migrations.js';
import { SqliteMemoryPurge } from './sqlite-memory-purge.js';

export { SQLITE_SCHEMA_VERSION } from './sqlite-schema.js';

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
              db.exec(SQLITE_SCHEMA);
              migrateLegacySqliteSchema(db);
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
              migrateMemoryAuthorSchema(db);
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
    return this.createMemoryPurge().purgeAllLayer2Memory(conversationSummaries);
  }

  async deleteAllCuratedMemories(expectedIds: readonly number[]): Promise<number> {
    return this.createMemoryPurge().deleteAllCuratedMemories(expectedIds);
  }

  async purgeLayer2LegacyMemory(input: Layer2LegacyPolicyPurgeInput): Promise<number> {
    return this.createMemoryPurge().purgeLayer2LegacyMemory(input);
  }

  async purgeQuarantinedLayer2Memory(): Promise<Layer2MemoryPurgeResult> {
    return this.createMemoryPurge().purgeQuarantinedLayer2Memory();
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

  private createMemoryPurge(): SqliteMemoryPurge {
    return new SqliteMemoryPurge(this.db, () => this.finalizePrivacyDeletion());
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
