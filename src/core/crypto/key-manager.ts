import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const KEY_FILE = 'sarah.key';
const KEY_LENGTH = 32;
const SAFE_STORAGE_PREFIX = 'sarah-key:safe:v1:';
const TEST_STORAGE_PREFIX = 'sarah-key:test:v1:';
const EXISTING_ENCRYPTED_STORES = [
  'config.json',
  'config.json.bak',
  'sarah.db',
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
    if (fs.existsSync(keyPath)) {
      this.cachedKey = this.loadKey(keyPath);
      return this.cachedKey;
    }

    const existingStore = EXISTING_ENCRYPTED_STORES.find((name) =>
      fs.existsSync(path.join(this.storageDir, name)),
    );
    if (existingStore) {
      throw new Error(
        `Der S.A.R.A.H.-Schlüssel fehlt, obwohl ${existingStore} vorhanden ist. `
        + 'Es wird kein Ersatzschlüssel erzeugt; eine Wiederherstellung ist erforderlich.',
      );
    }

    this.cachedKey = randomBytes(KEY_LENGTH);
    this.saveKey(keyPath, this.cachedKey);
    return this.cachedKey;
  }

  private saveKey(keyPath: string, key: Buffer): void {
    const encrypted = this.wrapKey(key);
    if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
    const tempPath = `${keyPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, encrypted, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
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
    if (safeStorage?.isEncryptionAvailable()) {
      return `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(key.toString('base64')).toString('base64')}`;
    }
    if (this.options.testWrappingKey) {
      return `${TEST_STORAGE_PREFIX}${this.testWrap(key, this.options.testWrappingKey)}`;
    }
    throw new Error(
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
    if (!safeStorage?.isEncryptionAvailable()) {
      throw new Error('Electron safeStorage ist zum Entschlüsseln des S.A.R.A.H.-Schlüssels nicht verfügbar');
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
