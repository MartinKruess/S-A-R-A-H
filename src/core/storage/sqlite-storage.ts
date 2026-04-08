import Database from 'better-sqlite3';
import type { StorageProvider, Filter } from './storage.interface.js';

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
    summary    TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    timestamp       TEXT DEFAULT (datetime('now'))
  );

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

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
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
    const keys = Object.keys(data);
    const cols = keys.map((k) => this.assertColumnName(k)).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map((k) => data[k]);

    const result = this.db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`).run(...values);
    return result.lastInsertRowid as number;
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

  async close(): Promise<void> {
    this.db.close();
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
