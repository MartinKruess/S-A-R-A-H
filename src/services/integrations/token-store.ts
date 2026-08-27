// src/services/integrations/token-store.ts
// Encrypted at-rest store for OAuth tokens. Mirrors the AES-256-GCM fallback
// pattern in core/crypto/key-manager.ts: 12-byte random IV prepended, 16-byte
// auth tag appended, whole blob base64 into `<storageDir>/connections.enc`.
// Never writes plaintext tokens to disk.

import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { KeyManager } from '../../core/crypto/key-manager.js';

const STORE_FILE = 'connections.enc';
const STORE_PREFIX_V1 = 'sarah-oauth:v1:';
const STORE_PREFIX_V2 = 'sarah-oauth:v2:';

export type StoredToken = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scope: string;
};

type StoreData = Record<string, StoredToken>;

type StoreEnvelopeV2 = {
  version: 2;
  generation: number;
  commitId: string;
  data: StoreData;
};

type StoreSnapshot = {
  data: StoreData;
  generation: number;
  commitId?: string;
  format: 1 | 2;
};

export type TokenStoreFaultPoint = 'after-backup-publish';

export type TokenStoreStatus =
  | { state: 'ready' }
  | { state: 'recovered'; message: string }
  | { state: 'degraded'; message: string };

export class TokenStoreDegradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenStoreDegradedError';
  }
}

export class TokenStore {
  private data: StoreData | null = null;
  private generation = 0;
  private status: TokenStoreStatus = { state: 'ready' };

  constructor(
    private storageDir: string,
    private keyManager: KeyManager,
    private faultInjector?: (point: TokenStoreFaultPoint) => void,
  ) {}

  get(id: string): StoredToken | undefined {
    const token = this.load()[id];
    return token ? { ...token } : undefined;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  set(id: string, token: StoredToken): void {
    if (!id.trim()) throw new Error('Token provider id must not be empty');
    if (!this.isStoredToken(token)) throw new Error(`Invalid token entry: ${id}`);
    const data = { ...this.load(), [id]: { ...token } };
    const generation = this.persist(data);
    this.data = data;
    this.generation = generation;
  }

  delete(id: string): void {
    const data = { ...this.load() };
    if (id in data) {
      delete data[id];
      const generation = this.persist(data);
      this.data = data;
      this.generation = generation;
    }
  }

  getStatus(): TokenStoreStatus {
    this.load();
    return { ...this.status };
  }

  /** Lazily load and decrypt the store; corruption is reported and blocks writes. */
  private load(): StoreData {
    if (this.data) return this.data;
    const filePath = path.join(this.storageDir, STORE_FILE);
    const backupPath = `${filePath}.bak`;
    const primaryExists = fs.existsSync(filePath);
    const backupExists = fs.existsSync(backupPath);
    if (!primaryExists && !backupExists) {
      this.data = {};
      this.generation = 0;
      this.status = { state: 'ready' };
      return this.data;
    }

    let primary: StoreSnapshot | undefined;
    let backup: StoreSnapshot | undefined;
    let primaryError = '';
    let backupError = '';
    if (primaryExists) {
      try {
        primary = this.readStore(filePath);
      } catch (error) {
        primaryError = error instanceof Error ? error.message : 'unbekannter Entschlüsselungsfehler';
      }
    }
    if (backupExists) {
      try {
        backup = this.readStore(backupPath);
      } catch (error) {
        backupError = error instanceof Error ? error.message : 'unbekannter Entschlüsselungsfehler';
      }
    }

    if (!primary && !backup) {
      const detail = [primaryError, backupError].filter(Boolean).join('; ');
      this.data = {};
      this.generation = 0;
      this.status = {
        state: 'degraded',
        message: !primaryExists && backupExists
          ? `Der OAuth-Token-Speicher fehlt und seine Sicherung ist nicht lesbar (${backupError || 'unbekannter Entschlüsselungsfehler'}). Die Sicherung bleibt unverändert.`
          : `Der OAuth-Token-Speicher ist beschädigt oder mit einem anderen Schlüssel verschlüsselt (${detail || 'keine gültige Kopie'}). Die Dateien bleiben unverändert.`,
      };
      return this.data;
    }

    const selected = this.selectNewest(primary, backup);
    if (!selected) {
      this.data = {};
      this.generation = 0;
      this.status = {
        state: 'degraded',
        message: 'Der OAuth-Token-Speicher enthält widersprüchliche Commits derselben Generation. Die Dateien bleiben unverändert.',
      };
      return this.data;
    }

    this.data = selected.data;
    this.generation = selected.generation;
    const bothCurrent = primary !== undefined && backup !== undefined &&
      primary.format === 2 && backup.format === 2 &&
      primary.generation === backup.generation && primary.commitId === backup.commitId;
    this.status = bothCurrent
      ? { state: 'ready' }
      : {
          state: 'recovered',
          message: 'Der OAuth-Token-Speicher verwendet den neuesten gültigen Commit; die redundanten Kopien werden beim nächsten Speichern angeglichen.',
        };
    return this.data;
  }

  private persist(data: StoreData): number {
    if (this.status.state === 'degraded') {
      throw new TokenStoreDegradedError(this.status.message);
    }
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    const filePath = path.join(this.storageDir, STORE_FILE);
    const backupPath = `${filePath}.bak`;
    const tempPath = path.join(this.storageDir, `.${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`);
    const backupTempPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
    const nextGeneration = this.generation + 1;
    const envelope: StoreEnvelopeV2 = {
      version: 2,
      generation: nextGeneration,
      commitId: randomUUID(),
      data,
    };
    try {
      const wrapped = `${STORE_PREFIX_V2}${this.encrypt(JSON.stringify(envelope))}`;
      this.writeDurably(tempPath, wrapped);
      this.writeDurably(backupTempPath, wrapped);

      fs.renameSync(backupTempPath, backupPath);
      this.faultInjector?.('after-backup-publish');
      fs.renameSync(tempPath, filePath);
      this.status = { state: 'ready' };
      return nextGeneration;
    } catch (error) {
      // A commit may already be present in one slot. Force the next operation
      // to compare both slots instead of continuing from stale in-memory data.
      this.data = null;
      this.generation = 0;
      this.status = { state: 'ready' };
      throw error;
    } finally {
      this.removeTempFile(tempPath);
      this.removeTempFile(backupTempPath);
    }
  }

  private encrypt(plaintext: string): string {
    const key = this.keyManager.getOrCreateKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, tag]).toString('base64');
  }

  private decrypt(wrapped: string): string {
    const key = this.keyManager.getOrCreateKey();
    const data = Buffer.from(wrapped, 'base64');
    const iv = data.subarray(0, 12);
    const tag = data.subarray(data.length - 16);
    const encrypted = data.subarray(12, data.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
  }

  private readStore(filePath: string): StoreSnapshot {
    const wrapped = fs.readFileSync(filePath, 'utf-8');
    const isV2 = wrapped.startsWith(STORE_PREFIX_V2);
    const ciphertext = isV2
      ? wrapped.slice(STORE_PREFIX_V2.length)
      : wrapped.startsWith(STORE_PREFIX_V1)
        ? wrapped.slice(STORE_PREFIX_V1.length)
        : wrapped;
    const parsed = JSON.parse(this.decrypt(ciphertext)) as object;
    if (isV2) {
      const envelope = this.parseV2Envelope(parsed);
      return { ...envelope, format: 2 };
    }

    return {
      data: this.parseStoreData(parsed),
      generation: 0,
      format: 1,
    };
  }

  private parseV2Envelope(value: object | null): Omit<StoreSnapshot, 'format'> {
    if (value === null || Array.isArray(value)) throw new Error('Token store envelope must be an object');
    const candidate = value as Partial<Record<keyof StoreEnvelopeV2, object | string | number>>;
    if (
      candidate.version !== 2 ||
      typeof candidate.generation !== 'number' ||
      !Number.isSafeInteger(candidate.generation) ||
      candidate.generation < 1 ||
      typeof candidate.commitId !== 'string' ||
      !candidate.commitId.trim() ||
      typeof candidate.data !== 'object' ||
      candidate.data === null ||
      Array.isArray(candidate.data)
    ) {
      throw new Error('Invalid token store commit envelope');
    }
    return {
      data: this.parseStoreData(candidate.data),
      generation: candidate.generation,
      commitId: candidate.commitId,
    };
  }

  private parseStoreData(parsed: object | null): StoreData {
    if (parsed === null || Array.isArray(parsed)) throw new Error('Token store root must be an object');

    const result: StoreData = {};
    for (const [id, candidate] of Object.entries(parsed)) {
      if (!this.isStoredToken(candidate)) throw new Error(`Invalid token entry: ${id}`);
      result[id] = candidate;
    }
    return result;
  }

  private selectNewest(
    primary: StoreSnapshot | undefined,
    backup: StoreSnapshot | undefined,
  ): StoreSnapshot | undefined {
    if (!primary) return backup;
    if (!backup) return primary;
    if (primary.format === 1 && backup.format === 1) {
      // The V1 writer published backup before primary. If valid V1 copies
      // differ after a crash, the backup is therefore the newer snapshot.
      return backup;
    }
    if (primary.generation !== backup.generation) {
      return primary.generation > backup.generation ? primary : backup;
    }
    if (primary.format !== backup.format) return primary.format === 2 ? primary : backup;
    return primary.commitId === backup.commitId ? primary : undefined;
  }

  private isStoredToken(value: object | null): value is StoredToken {
    if (value === null || Array.isArray(value)) return false;
    const candidate = value as Partial<Record<keyof StoredToken, object | string | number>>;
    return (
      typeof candidate.refreshToken === 'string' &&
      candidate.refreshToken.trim().length > 0 &&
      typeof candidate.accessToken === 'string' &&
      candidate.accessToken.trim().length > 0 &&
      typeof candidate.expiresAt === 'number' &&
      Number.isSafeInteger(candidate.expiresAt) &&
      candidate.expiresAt > 0 &&
      typeof candidate.scope === 'string'
    );
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

  private removeTempFile(filePath: string): void {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Temp files are never considered token stores on load.
    }
  }
}
