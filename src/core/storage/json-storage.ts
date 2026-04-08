import * as fs from 'fs';
import type { StorageProvider, Filter } from './storage.interface.js';

/**
 * JSON file-based storage for config/settings.
 * Supports key-value get/set with dot-notation for nested access.
 * Table operations (query/insert/update/delete) are not supported — use SqliteStorage for those.
 */
export class JsonStorage implements StorageProvider {
  private data: Record<string, unknown> = {};

  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.data = JSON.parse(raw);
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    const dir = this.filePath.replace(/[/\\][^/\\]+$/, '');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const parts = key.split('.');
    let current: unknown = this.data;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    const parts = key.split('.');

    if (parts.length === 1) {
      this.data[key] = value;
    } else {
      let current: Record<string, unknown> = this.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
          current[parts[i]] = {};
        }
        current = current[parts[i]] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
    }

    this.save();
  }

  async query<T>(_table: string, _filter?: Filter): Promise<T[]> {
    throw new Error('JsonStorage does not support table queries. Use SqliteStorage.');
  }

  async insert(_table: string, _data: Record<string, unknown>): Promise<number> {
    throw new Error('JsonStorage does not support table operations. Use SqliteStorage.');
  }

  async update(_table: string, _filter: Filter, _data: Record<string, unknown>): Promise<number> {
    throw new Error('JsonStorage does not support table operations. Use SqliteStorage.');
  }

  async delete(_table: string, _filter: Filter): Promise<number> {
    throw new Error('JsonStorage does not support table operations. Use SqliteStorage.');
  }

  async close(): Promise<void> {
    // No-op for JSON storage.
  }
}
