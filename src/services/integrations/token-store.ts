// src/services/integrations/token-store.ts
// Encrypted at-rest store for OAuth tokens. V3 uses the shared AES-256-GCM
// envelope with fixed product/store/schema AAD and keeps a durable backup copy.
// V1/V2 remain readable only as controlled migration sources.

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { KeyManager } from '../../core/crypto/key-manager.js';
import { decrypt, encrypt } from '../../core/crypto/crypto.js';

const STORE_FILE = 'connections.enc';
const STORE_PREFIX_V1 = 'sarah-oauth:v1:';
const STORE_PREFIX_V2 = 'sarah-oauth:v2:';
const STORE_PREFIX_V3 = 'sarah-oauth:v3:';
const STORE_V3_AAD = 'sarah:oauth-token-store:connections:v3';

export type StoredToken = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scope: string;
};

type StoreData = Record<string, StoredToken>;

type StoreEnvelope = {
  version: 2 | 3;
  generation: number;
  commitId: string;
  data: StoreData;
};

type StoreSnapshot = {
  data: StoreData;
  generation: number;
  commitId?: string;
  format: 1 | 2 | 3;
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
    if (selected.format < 3) {
      // V1/V2 are accepted only as a one-time authenticated migration source.
      // Publishing both V3 copies immediately closes the unbound legacy read window.
      this.status = { state: 'ready' };
      try {
        this.generation = this.persist(selected.data);
        this.data = selected.data;
        this.status = {
          state: 'recovered',
          message: 'Der OAuth-Token-Speicher wurde in das aktuelle, kontextgebundene Format migriert.',
        };
        return this.data;
      } catch (error) {
        this.data = selected.data;
        this.generation = selected.generation;
        this.status = {
          state: 'recovered',
          message: `Der OAuth-Token-Speicher ist lesbar, konnte aber noch nicht in V3 migriert werden (${error instanceof Error ? error.message : 'unbekannter Fehler'}).`,
        };
        return this.data;
      }
    }

    const bothCurrent = primary !== undefined && backup !== undefined &&
      primary.format === 3 && backup.format === 3 &&
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
    const envelope: StoreEnvelope = {
      version: 3,
      generation: nextGeneration,
      commitId: randomUUID(),
      data,
    };
    try {
      const wrapped = `${STORE_PREFIX_V3}${this.encryptV3(JSON.stringify(envelope))}`;
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

  private encryptV3(plaintext: string): string {
    return encrypt(plaintext, this.keyManager.getOrCreateKey(), STORE_V3_AAD);
  }

  private decryptEnvelope(wrapped: string, aad?: string): string {
    return decrypt(wrapped, this.keyManager.getOrCreateKey(), aad);
  }

  private readStore(filePath: string): StoreSnapshot {
    const wrapped = fs.readFileSync(filePath, 'utf-8');
    const isV3 = wrapped.startsWith(STORE_PREFIX_V3);
    const isV2 = wrapped.startsWith(STORE_PREFIX_V2);
    const ciphertext = isV3
      ? wrapped.slice(STORE_PREFIX_V3.length)
      : isV2
      ? wrapped.slice(STORE_PREFIX_V2.length)
      : wrapped.startsWith(STORE_PREFIX_V1)
        ? wrapped.slice(STORE_PREFIX_V1.length)
        : wrapped;
    const parsed = JSON.parse(this.decryptEnvelope(ciphertext, isV3 ? STORE_V3_AAD : undefined)) as object;
    if (isV3 || isV2) {
      const format = isV3 ? 3 : 2;
      const envelope = this.parseEnvelope(parsed, format);
      return { ...envelope, format };
    }

    return {
      data: this.parseStoreData(parsed),
      generation: 0,
      format: 1,
    };
  }

  private parseEnvelope(value: object | null, expectedVersion: 2 | 3): Omit<StoreSnapshot, 'format'> {
    if (value === null || Array.isArray(value)) throw new Error('Token store envelope must be an object');
    const candidate = value as Partial<Record<keyof StoreEnvelope, object | string | number>>;
    if (
      candidate.version !== expectedVersion ||
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
    if (primary.format !== backup.format) return primary.format > backup.format ? primary : backup;
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
