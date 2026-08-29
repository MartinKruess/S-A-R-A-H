import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  CompleteMemoryStagingInput,
  StorageProvider,
  Filter,
  MessageRow,
  MessagesPageQuery,
  TurnMessageWrite,
  Layer2MemoryPurgeResult,
} from './storage.interface.js';

/**
 * JSON file-based storage for config/settings.
 * Supports key-value get/set with dot-notation for nested access.
 * Table operations (query/insert/update/delete) are not supported — use SqliteStorage for those.
 */
export class JsonStorage implements StorageProvider {
  private data: Record<string, unknown> = {};
  private primaryHealthy = true;
  private unrecoverable = false;
  private recoveryIssues: string[] = [];

  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      const backupPath = this.backupPath();
      if (!fs.existsSync(backupPath)) return;
      this.primaryHealthy = false;
      try {
        this.data = this.readObject(backupPath);
        this.recoveryIssues.push(
          'config.json fehlte; die letzte gültige Sicherung wurde geladen.',
        );
      } catch (backupError) {
        this.unrecoverable = true;
        this.recoveryIssues.push(
          `config.json fehlt und ihre Sicherung ist nicht lesbar; sichere Wiederherstellung ist erforderlich (${this.errorMessage(backupError instanceof Error ? backupError : null)}).`,
        );
      }
      return;
    }

    try {
      this.data = this.readObject(this.filePath);
      return;
    } catch (primaryError) {
      this.primaryHealthy = false;
      const backupPath = this.backupPath();
      try {
        this.data = this.readObject(backupPath);
        this.recoveryIssues.push(
          `config.json konnte nicht gelesen werden; die letzte gültige Sicherung wurde geladen (${this.errorMessage(primaryError instanceof Error ? primaryError : null)}).`,
        );
        return;
      } catch (backupError) {
        this.data = {};
        this.unrecoverable = true;
        this.recoveryIssues.push(
          `config.json und ihre Sicherung sind nicht lesbar; sichere Wiederherstellung ist erforderlich (${this.errorMessage(primaryError instanceof Error ? primaryError : null)}; Backup: ${this.errorMessage(backupError instanceof Error ? backupError : null)}).`,
        );
      }
    }
  }

  /** Recovery warnings detected while opening the primary file or its backup. */
  getRecoveryIssues(): readonly string[] {
    return [...this.recoveryIssues];
  }

  /** True when neither the primary file nor its last valid backup could be loaded. */
  requiresFailClosedDefaults(): boolean {
    return this.unrecoverable;
  }

  /** True when config material already exists and this is not a clean first start. */
  hasPersistedSnapshot(): boolean {
    return fs.existsSync(this.filePath) || fs.existsSync(this.backupPath());
  }

  async recoverLastValidSnapshot(): Promise<boolean> {
    this.primaryHealthy = false;
    try {
      this.data = this.readObject(this.backupPath());
      this.unrecoverable = false;
      this.recoveryIssues.push('Die primäre Konfiguration war kryptografisch ungültig; die letzte gültige Sicherung wurde geladen.');
      return true;
    } catch (error) {
      this.unrecoverable = true;
      this.recoveryIssues.push(
        `Auch die Konfigurationssicherung konnte nicht wiederhergestellt werden (${this.errorMessage(error instanceof Error ? error : null)}).`,
      );
      return false;
    }
  }

  private save(nextData: Record<string, unknown>): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const backupPath = this.backupPath();
    const backupTempPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      this.writeDurably(tempPath, JSON.stringify(nextData, null, 2));

      fs.renameSync(tempPath, this.filePath);
      this.syncDirectory(dir);

      // The backup represents the same successfully committed snapshot, not
      // the previous one. Recovery therefore cannot silently undo the user's
      // most recent settings change.
      fs.copyFileSync(this.filePath, backupTempPath);
      this.syncFile(backupTempPath);
      fs.renameSync(backupTempPath, backupPath);
      this.syncDirectory(dir);
      this.primaryHealthy = true;
      this.unrecoverable = false;
      this.recoveryIssues = [];
    } finally {
      this.removeTempFile(tempPath);
      this.removeTempFile(backupTempPath);
    }
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
    const nextData = structuredClone(this.data);

    if (parts.length === 1) {
      nextData[key] = value;
    } else {
      let current: Record<string, unknown> = nextData;
      for (let i = 0; i < parts.length - 1; i++) {
        if (
          !(parts[i] in current) ||
          current[parts[i]] === null ||
          Array.isArray(current[parts[i]]) ||
          typeof current[parts[i]] !== 'object'
        ) {
          current[parts[i]] = {};
        }
        current = current[parts[i]] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
    }

    this.save(nextData);
    this.data = nextData;
  }

  async query<T>(_table: string, _filter?: Filter): Promise<T[]> {
    throw new Error('JsonStorage does not support table queries. Use SqliteStorage.');
  }

  async insert(_table: string, _data: Record<string, unknown>): Promise<number> {
    throw new Error('JsonStorage does not support table operations. Use SqliteStorage.');
  }

  async reserveRowIds(_table: string, _count: number): Promise<number[]> {
    throw new Error('JsonStorage does not support table operations. Use SqliteStorage.');
  }

  async insertTurnMessages(
    _conversationId: number,
    _turnId: string,
    _messages: readonly TurnMessageWrite[],
  ): Promise<void> {
    throw new Error('JsonStorage does not support message operations. Use SqliteStorage.');
  }

  async persistTurnWithMemoryStaging(
    _conversationId: number,
    _turnId: string,
    _messages: readonly TurnMessageWrite[],
    _stagingSource: string,
    _policyTerms?: string,
    _stagingId?: number,
  ): Promise<number> {
    throw new Error('JsonStorage does not support memory operations. Use SqliteStorage.');
  }

  async deleteTurnMessages(_conversationId: number, _turnId: string): Promise<number> {
    throw new Error('JsonStorage does not support message operations. Use SqliteStorage.');
  }

  async completeMemoryStaging(_input: CompleteMemoryStagingInput): Promise<void> {
    throw new Error('JsonStorage does not support memory operations. Use SqliteStorage.');
  }

  async discardMemoryStaging(_stagingId: number): Promise<void> {
    throw new Error('JsonStorage does not support memory operations. Use SqliteStorage.');
  }

  async failMemoryStaging(_stagingId: number): Promise<void> {
    throw new Error('JsonStorage does not support memory operations. Use SqliteStorage.');
  }

  async purgeAllLayer2Memory(): Promise<Layer2MemoryPurgeResult> {
    throw new Error('JsonStorage does not support memory operations. Use SqliteStorage.');
  }

  async purgeQuarantinedLayer2Memory(): Promise<Layer2MemoryPurgeResult> {
    throw new Error('JsonStorage does not support memory operations. Use SqliteStorage.');
  }

  async purgeLayer2LegacyMemory(): Promise<number> {
    throw new Error('JsonStorage does not support memory operations. Use SqliteStorage.');
  }

  async update(_table: string, _filter: Filter, _data: Record<string, unknown>): Promise<number> {
    throw new Error('JsonStorage does not support table operations. Use SqliteStorage.');
  }

  async delete(_table: string, _filter: Filter): Promise<number> {
    throw new Error('JsonStorage does not support table operations. Use SqliteStorage.');
  }

  async queryMessagesPage(_query: MessagesPageQuery): Promise<MessageRow[]> {
    throw new Error('JsonStorage does not support message queries. Use SqliteStorage.');
  }

  async close(): Promise<void> {
    // No-op for JSON storage.
  }

  private readObject(filePath: string): Record<string, unknown> {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('JSON root must be an object');
    }
    return parsed as Record<string, unknown>;
  }

  private backupPath(): string {
    return `${this.filePath}.bak`;
  }

  private writeDurably(filePath: string, content: string): void {
    const handle = fs.openSync(filePath, 'w');
    try {
      fs.writeFileSync(handle, content, 'utf-8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }

  private syncFile(filePath: string): void {
    const handle = fs.openSync(filePath, 'r+');
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }

  private syncDirectory(directoryPath: string): void {
    try {
      const handle = fs.openSync(directoryPath, 'r');
      try {
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      // Windows does not consistently allow directory handles through Node.
      // Both file payloads are still fsync'd before their atomic rename.
    }
  }

  private removeTempFile(filePath: string): void {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // A leftover temp file is never considered valid configuration on load.
    }
  }

  private errorMessage(error: Error | null): string {
    return error?.message ?? 'unbekannter Lesefehler';
  }
}
