import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const KEY_FILE = 'sarah.key';
const KEY_BACKUP_FILE = 'sarah.key.bak';
const KEY_LENGTH = 32;
const SAFE_STORAGE_PREFIX = 'sarah-key:safe:v1:';
const TEST_STORAGE_PREFIX = 'sarah-key:test:v1:';
const EXISTING_ENCRYPTED_STORES = [
  'config.json',
  'config.json.bak',
  'sarah.db',
  'sarah.db-wal',
  'sarah.db-shm',
  'sarah.db-journal',
  'connections.enc',
  'connections.enc.bak',
] as const;

interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface KeyManagerOptions {
  /** Explicit, test-only wrapping key. Production must rely on Electron safeStorage. */
  testWrappingKey?: Buffer;
}

export type KeyAccessFailureReason =
  | 'safe-storage-unavailable'
  | 'key-files-unavailable'
  | 'encrypted-stores-without-key'
  | 'key-envelopes-unreadable';

/**
 * Distinguishes a permanent local key loss from a temporarily unavailable
 * operating-system key store.
 *
 * @category Security Service
 */
export class KeyAccessError extends Error {
  readonly code = 'KEY_ACCESS_FAILED';

  constructor(
    readonly reason: KeyAccessFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'KeyAccessError';
  }

  /** Whether the existing encrypted stores have no remaining readable key envelope. */
  get isFinalKeyLoss(): boolean {
    return this.reason === 'encrypted-stores-without-key'
      || this.reason === 'key-envelopes-unreadable';
  }
}

/**
 * Manages the encryption key for S.A.R.A.H.
 *
 * - Uses Electron safeStorage in production.
 * - Refuses weak machine-derived fallback protection.
 * - Refuses to replace a missing key while encrypted stores already exist.
 *
 * @category Security Service
 */
export class KeyManager {
  private cachedKey: Buffer | null = null;

  constructor(
    private storageDir: string,
    private options: KeyManagerOptions = {},
  ) {
    if (options.testWrappingKey && options.testWrappingKey.length !== KEY_LENGTH) {
      throw new Error(`testWrappingKey must contain exactly ${KEY_LENGTH} bytes`);
    }
  }

  /** Get the encryption key, creating one only for a genuinely new storage directory. */
  getOrCreateKey(): Buffer {
    if (this.cachedKey) return this.cachedKey;

    const keyPath = path.join(this.storageDir, KEY_FILE);
    const backupPath = path.join(this.storageDir, KEY_BACKUP_FILE);
    if (this.fileExists(keyPath)) {
      try {
        this.cachedKey = this.loadKey(keyPath);
        return this.cachedKey;
      } catch (primaryError) {
        if (!this.fileExists(backupPath)) {
          throw this.classifyUnreadableEnvelopes([primaryError]);
        }
        try {
          this.cachedKey = this.loadKey(backupPath);
          this.saveWrappedKey(keyPath, fs.readFileSync(backupPath, 'utf-8'));
          return this.cachedKey;
        } catch (backupError) {
          throw this.classifyUnreadableEnvelopes([primaryError, backupError]);
        }
      }
    }
    if (this.fileExists(backupPath)) {
      try {
        this.cachedKey = this.loadKey(backupPath);
        this.saveWrappedKey(keyPath, fs.readFileSync(backupPath, 'utf-8'));
        return this.cachedKey;
      } catch (backupError) {
        throw this.classifyUnreadableEnvelopes([backupError]);
      }
    }

    const existingStore = EXISTING_ENCRYPTED_STORES.find((name) =>
      this.fileExists(path.join(this.storageDir, name)),
    );
    if (existingStore) {
      throw new KeyAccessError(
        'encrypted-stores-without-key',
        `Der S.A.R.A.H.-Schlüssel fehlt, obwohl ${existingStore} vorhanden ist. `
        + 'Es wird kein Ersatzschlüssel erzeugt; eine Wiederherstellung ist erforderlich.',
      );
    }

    const freshKey = randomBytes(KEY_LENGTH);
    this.saveKey(keyPath, freshKey);
    this.cachedKey = freshKey;
    return freshKey;
  }

  private saveKey(keyPath: string, key: Buffer): void {
    const encrypted = this.wrapKey(key);
    this.saveWrappedKey(keyPath, encrypted);
    this.saveWrappedKey(path.join(this.storageDir, KEY_BACKUP_FILE), encrypted);
  }

  private saveWrappedKey(keyPath: string, encrypted: string): void {
    if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
    const tempPath = `${keyPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, encrypted, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      const handle = fs.openSync(tempPath, 'r+');
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.renameSync(tempPath, keyPath);
    } finally {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // A leftover temporary key is never loaded as the productive key.
      }
    }
  }

  private loadKey(keyPath: string): Buffer {
    const wrapped = fs.readFileSync(keyPath, 'utf-8');
    const key = this.unwrapKey(wrapped);
    if (key.length !== KEY_LENGTH) throw new Error('Stored S.A.R.A.H. key has an invalid length');
    return key;
  }

  private wrapKey(key: Buffer): string {
    const safeStorage = this.safeStorage();
    try {
      if (safeStorage?.isEncryptionAvailable()) {
        return `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(key.toString('base64')).toString('base64')}`;
      }
    } catch {
      throw new KeyAccessError(
        'safe-storage-unavailable',
        'Electron safeStorage konnte nicht initialisiert werden. Es wurden keine Windows-Dienste neu gestartet.',
      );
    }
    if (this.options.testWrappingKey) {
      return `${TEST_STORAGE_PREFIX}${this.testWrap(key, this.options.testWrappingKey)}`;
    }
    throw new KeyAccessError(
      'safe-storage-unavailable',
      'Electron safeStorage ist nicht verfügbar. Der Verschlüsselungsschlüssel wird nicht unsicher gespeichert.',
    );
  }

  private unwrapKey(wrapped: string): Buffer {
    if (wrapped.startsWith(TEST_STORAGE_PREFIX)) {
      if (!this.options.testWrappingKey) {
        throw new Error('Ein testverschlüsselter Schlüssel darf nicht im Produktivbetrieb geladen werden');
      }
      return this.testUnwrap(wrapped.slice(TEST_STORAGE_PREFIX.length), this.options.testWrappingKey);
    }

    const safeStorage = this.safeStorage();
    let encryptionAvailable = false;
    try {
      encryptionAvailable = safeStorage?.isEncryptionAvailable() === true;
    } catch {
      throw new KeyAccessError(
        'safe-storage-unavailable',
        'Electron safeStorage konnte nicht initialisiert werden. Die vorhandenen Schlüsseldateien bleiben unverändert.',
      );
    }
    if (!encryptionAvailable || !safeStorage) {
      throw new KeyAccessError(
        'safe-storage-unavailable',
        'Electron safeStorage ist zum Entschlüsseln des S.A.R.A.H.-Schlüssels nicht verfügbar',
      );
    }
    const payload = wrapped.startsWith(SAFE_STORAGE_PREFIX)
      ? wrapped.slice(SAFE_STORAGE_PREFIX.length)
      : wrapped; // Explicit migration path for legacy safeStorage files.
    return Buffer.from(safeStorage.decryptString(Buffer.from(payload, 'base64')), 'base64');
  }

  private safeStorage(): SafeStorageAdapter | null {
    try {
      const electron = require('electron') as { safeStorage?: SafeStorageAdapter };
      return electron.safeStorage ?? null;
    } catch {
      return null;
    }
  }

  private classifyUnreadableEnvelopes(errors: readonly unknown[]): KeyAccessError {
    const transient = errors.find((error) => (
      error instanceof KeyAccessError && !error.isFinalKeyLoss
    ));
    if (transient instanceof KeyAccessError) return transient;
    if (errors.some((error) => this.isFileAccessFailure(error))) {
      return new KeyAccessError(
        'key-files-unavailable',
        'Die S.A.R.A.H.-Schlüsseldateien sind vorübergehend nicht zugreifbar und bleiben unverändert.',
      );
    }
    return new KeyAccessError(
      'key-envelopes-unreadable',
      'Keine vorhandene S.A.R.A.H.-Schlüsselkopie konnte entschlüsselt werden. Die verschlüsselten Daten bleiben unverändert.',
    );
  }

  private fileExists(filePath: string): boolean {
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      return true;
    } catch (error) {
      if (this.isMissingFile(error)) return false;
      throw new KeyAccessError(
        'key-files-unavailable',
        `Der S.A.R.A.H.-Speicher ist vorübergehend nicht zugreifbar (${path.basename(filePath)}).`,
      );
    }
  }

  private isMissingFile(error: unknown): boolean {
    return this.errorCode(error) === 'ENOENT';
  }

  private isFileAccessFailure(error: unknown): boolean {
    const code = this.errorCode(error);
    return code !== null && code !== 'ENOENT';
  }

  private errorCode(error: unknown): string | null {
    if (error === null || typeof error !== 'object' || !('code' in error)) return null;
    const code = (error as { code?: string }).code;
    return typeof code === 'string' ? code : null;
  }

  private testWrap(key: Buffer, wrappingKey: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
  }

  private testUnwrap(wrapped: string, wrappingKey: Buffer): Buffer {
    const data = Buffer.from(wrapped, 'base64');
    if (data.length < 29) throw new Error('Test key envelope is invalid');
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]);
  }
}
