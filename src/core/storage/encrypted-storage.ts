import type { StorageProvider, Filter } from './storage.interface.js';
import { encrypt, decrypt } from '../crypto/crypto.js';

/** Columns that should NOT be encrypted (structural, used for filtering). */
const PASSTHROUGH_COLUMNS = new Set([
  'id', 'category', 'session_id', 'conversation_id', 'mode', 'role',
  'source', 'confidence', 'created_at', 'updated_at', 'started_at',
  'ended_at', 'timestamp',
]);

/**
 * Transparent encryption wrapper around any StorageProvider.
 * Encrypts sensitive field values on write, decrypts on read.
 * Structural columns (IDs, categories, timestamps) pass through unencrypted
 * so they remain filterable/queryable.
 */
export class EncryptedStorage implements StorageProvider {
  constructor(
    private inner: StorageProvider,
    private key: Buffer,
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.inner.get<string>(key);
    if (raw === undefined) return undefined;
    try {
      const decrypted = decrypt(raw, this.key);
      return JSON.parse(decrypted) as T;
    } catch {
      return raw as T;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const encrypted = encrypt(JSON.stringify(value), this.key);
    await this.inner.set(key, encrypted);
  }

  async query<T = Record<string, unknown>>(table: string, filter?: Filter): Promise<T[]> {
    const rows = await this.inner.query<Record<string, unknown>>(table, filter);
    return rows.map((row) => this.decryptRow(row)) as T[];
  }

  async insert(table: string, data: Record<string, unknown>): Promise<number> {
    return this.inner.insert(table, this.encryptRow(data));
  }

  async update(table: string, filter: Filter, data: Record<string, unknown>): Promise<number> {
    return this.inner.update(table, filter, this.encryptRow(data));
  }

  async delete(table: string, filter: Filter): Promise<number> {
    return this.inner.delete(table, filter);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  private encryptRow(row: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [col, value] of Object.entries(row)) {
      if (PASSTHROUGH_COLUMNS.has(col) || value === null || value === undefined) {
        result[col] = value;
      } else {
        result[col] = encrypt(JSON.stringify(value), this.key);
      }
    }
    return result;
  }

  private decryptRow(row: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [col, value] of Object.entries(row)) {
      if (PASSTHROUGH_COLUMNS.has(col) || value === null || value === undefined) {
        result[col] = value;
      } else if (typeof value === 'string') {
        try {
          const decrypted = decrypt(value, this.key);
          result[col] = JSON.parse(decrypted);
        } catch {
          result[col] = value;
        }
      } else {
        result[col] = value;
      }
    }
    return result;
  }
}
