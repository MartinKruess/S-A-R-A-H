/** Filter condition for queries. */
export interface Filter {
  [column: string]: unknown;
}

/** A row from the messages table. `content` is decrypted when read via EncryptedStorage. */
export interface MessageRow {
  id: number;
  conversation_id: number;
  turn_id: string;
  role: string;
  content: string;
  timestamp: string;
}

/** Upper bound for queryMessagesPage limits — keeps the start read small by contract. */
export const MESSAGES_PAGE_MAX_LIMIT = 100;

/** Parameters for the ordered/limited messages query. */
export interface MessagesPageQuery {
  /** Messages of this conversation are excluded (the current session). Integer. */
  excludeConversationId: number;
  /** Maximum number of rows returned. Integer in 1..MESSAGES_PAGE_MAX_LIMIT. */
  limit: number;
}

export interface TurnMessageWrite {
  /** Reserved storage identity used internally for authenticated row binding. */
  id?: number;
  role: 'user' | 'assistant';
  content: string;
}

export type CuratedMemoryKind = 'fact' | 'preference' | 'episode' | 'explicit';

export interface CompleteMemoryStagingInput {
  stagingId: number;
  memory: {
    /** Reserved storage identity used internally for authenticated row binding. */
    id?: number;
    kind: CuratedMemoryKind;
    content: string;
    sourceConversationId: number | null;
    sourceTurnId: string;
    confidence: number;
  };
}

export interface Layer2MemoryPurgeResult {
  turns: number;
  staging: number;
  memories: number;
  /** Legacy learned facts and user/session rules removed with Layer-2 memory. */
  legacy: number;
  quarantine: number;
}

export interface ConversationSummaryClear {
  id: number;
  /** Empty summary encrypted for this conversation row, or empty only for raw test providers. */
  value: string;
}

export interface Layer2LegacyPolicyPurgeInput {
  learnedFactIds: readonly number[];
  persistentRuleIds: readonly number[];
  sessionRuleIds: readonly number[];
}

export const LEGACY_DB_RECOVERY_CONFIRMATION = 'restore-reviewed-unbound-legacy-values';

export interface LegacyDbRecoveryCandidate {
  quarantineId: number;
  table: string;
  rowId: number;
  column: string;
  /** Local-only, length-limited plaintext preview for an informed operator decision. */
  preview: string;
}

export interface LegacyDbRecoveryReview {
  candidates: LegacyDbRecoveryCandidate[];
  warning: string;
}

export interface LegacyDbRecoveryWrite extends Omit<LegacyDbRecoveryCandidate, 'preview'> {
  /** Exact quarantined V1/unversioned value, used for an atomic compare-before-write. */
  legacyCiphertext: string;
  /** V2 value authenticated for the reviewed table/row/column identity. */
  encryptedValue: string;
}

export interface LegacyDbRecoveryResult {
  restored: number;
  backupPath: string;
}

export const LEGACY_DB_RECOVERY_LOCATIONS = [
  'absolute_rules.rule',
  'persistent_rules.rule',
  'session_rules.rule',
  'conversations.summary',
  'messages.content',
  'memory_staging.source_content',
  'memory_staging.policy_terms',
  'curated_memories.content',
  'learned_facts.fact',
] as const;

/**
 * Abstract storage provider.
 * Currently backed by JSON files (config) and SQLite (rules/memory).
 * Later replaceable with PostgreSQL or cloud-sync provider.
 */
export interface StorageProvider {
  /** Get a value by key (config-style). */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /** Set a value by key (config-style). */
  set(key: string, value: unknown): Promise<void>;

  /** Optional provider-specific recovery of the last valid atomic snapshot. */
  recoverLastValidSnapshot?(): Promise<boolean>;

  /** Query rows from a table with optional filter. */
  query<T = Record<string, unknown>>(table: string, filter?: Filter): Promise<T[]>;

  /** Insert a row into a table. Returns the inserted row's ID. */
  insert(table: string, data: Record<string, unknown>): Promise<number>;

  /** Atomically reserves AUTOINCREMENT identities so encrypted values can bind to their final row. */
  reserveRowIds(table: string, count: number): Promise<number[]>;

  /** Writes every message of one completed turn atomically. */
  insertTurnMessages(
    conversationId: number,
    turnId: string,
    messages: readonly TurnMessageWrite[],
  ): Promise<void>;

  /** Atomically persists a completed turn and its pending memory-staging job. */
  persistTurnWithMemoryStaging(
    conversationId: number,
    turnId: string,
    messages: readonly TurnMessageWrite[],
    stagingSource: string,
    policyTerms?: string,
    stagingId?: number,
  ): Promise<number>;

  /** Removes every persisted message belonging to one turn atomically. */
  deleteTurnMessages(conversationId: number, turnId: string): Promise<number>;

  /** Atomically writes a curated memory and marks its staging item complete. */
  completeMemoryStaging(input: CompleteMemoryStagingInput): Promise<void>;

  /** Atomically discards an irrelevant staging item and its retained raw turn. */
  discardMemoryStaging(stagingId: number): Promise<void>;

  /** Atomically dead-letters a staging item, removes its raw source and retained turn. */
  failMemoryStaging(stagingId: number): Promise<void>;

  /** Atomically removes all persisted Layer-2 memory, including quarantine copies. */
  purgeAllLayer2Memory(
    conversationSummaries?: readonly ConversationSummaryClear[],
  ): Promise<Layer2MemoryPurgeResult>;

  /** Atomically deletes exactly the confirmed set of curated memories. */
  deleteAllCuratedMemories?(expectedIds: readonly number[]): Promise<number>;

  /** Atomically removes unreadable/quarantined Layer-2 originals and their recovery copies. */
  purgeQuarantinedLayer2Memory(): Promise<Layer2MemoryPurgeResult>;

  /** Atomically removes policy-matching legacy memories plus every unreadable legacy original/copy. */
  purgeLayer2LegacyMemory(input: Layer2LegacyPolicyPurgeInput): Promise<number>;

  /**
   * Restores explicitly reviewed, unbound legacy cells as row-bound V2 values.
   * Implementations must create a complete DB backup before the all-or-nothing write.
   */
  restoreReviewedLegacyDbValues?(
    confirmation: string,
    writes: readonly LegacyDbRecoveryWrite[],
  ): Promise<LegacyDbRecoveryResult>;

  /** Lists isolated legacy cells without exposing their untrusted plaintext. */
  reviewLegacyDbRecovery?(): Promise<LegacyDbRecoveryReview>;

  /** Restores only explicitly selected cells after operator acknowledgement. */
  restoreLegacyDbRecovery?(
    quarantineIds: readonly number[],
    confirmation: string,
  ): Promise<LegacyDbRecoveryResult>;

  /** Update rows matching filter. Returns number of affected rows. */
  update(table: string, filter: Filter, data: Record<string, unknown>): Promise<number>;

  /** Delete rows matching filter. Returns number of deleted rows. */
  delete(table: string, filter: Filter): Promise<number>;

  /**
   * Completes an explicit privacy deletion by scrubbing free pages and WAL remnants.
   * Optional for providers that do not persist deleted row content on disk.
   */
  finalizePrivacyDeletion?(): Promise<void>;

  /**
   * Newest messages excluding one conversation, newest first
   * (ORDER BY id DESC, LIMIT). The only ordered/limited query the
   * storage layer exposes — no raw SQL crosses this interface.
   */
  queryMessagesPage(query: MessagesPageQuery): Promise<MessageRow[]>;

  /** Close connections and clean up. */
  close(): Promise<void>;
}
