/** Filter condition for queries. */
export interface Filter {
  [column: string]: unknown;
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

  /** Update rows matching filter. Returns number of affected rows. */
  update(table: string, filter: Filter, data: Record<string, unknown>): Promise<number>;

  /** Delete rows matching filter. Returns number of deleted rows. */
  delete(table: string, filter: Filter): Promise<number>;

  /** Close connections and clean up. */
  close(): Promise<void>;
}
