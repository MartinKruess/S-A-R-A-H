/** Filter condition for queries. */
export interface Filter {
  [column: string]: unknown;
}

/** A row from the messages table. `content` is decrypted when read via EncryptedStorage. */
export interface MessageRow {
  id: number;
  conversation_id: number;
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
  role: 'user' | 'assistant';
  content: string;
}

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

  /** Query rows from a table with optional filter. */
  query<T = Record<string, unknown>>(table: string, filter?: Filter): Promise<T[]>;

  /** Insert a row into a table. Returns the inserted row's ID. */
  insert(table: string, data: Record<string, unknown>): Promise<number>;

  /** Writes every message of one completed turn atomically. */
  insertTurnMessages(conversationId: number, messages: readonly TurnMessageWrite[]): Promise<void>;

  /** Update rows matching filter. Returns number of affected rows. */
  update(table: string, filter: Filter, data: Record<string, unknown>): Promise<number>;

  /** Delete rows matching filter. Returns number of deleted rows. */
  delete(table: string, filter: Filter): Promise<number>;

  /**
   * Newest messages excluding one conversation, newest first
   * (ORDER BY id DESC, LIMIT). The only ordered/limited query the
   * storage layer exposes — no raw SQL crosses this interface.
   */
  queryMessagesPage(query: MessagesPageQuery): Promise<MessageRow[]>;

  /** Close connections and clean up. */
  close(): Promise<void>;
}
