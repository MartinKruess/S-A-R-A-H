import type Database from 'better-sqlite3';
import type {
  ConversationSummaryClear,
  Layer2LegacyPolicyPurgeInput,
  Layer2MemoryPurgeResult,
} from './storage.interface.js';

/**
 * Owns destructive Layer-2 memory cleanup while the storage facade retains its public API.
 *
 * @category Data Access Security
 */
export class SqliteMemoryPurge {
  constructor(
    private readonly db: Database.Database,
    private readonly finalizePrivacyDeletion: () => Promise<void>,
  ) {}

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
}
