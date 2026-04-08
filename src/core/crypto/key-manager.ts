import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const KEY_FILE = 'sarah.key';
const KEY_LENGTH = 32;

/**
 * Manages the encryption key for S.A.R.A.H.
 *
 * In production (Electron), uses safeStorage to encrypt the key at rest.
 * In tests/fallback, uses a machine-derived key to encrypt the stored key.
 *
 * The stored file never contains the plaintext key.
 */
export class KeyManager {
  private cachedKey: Buffer | null = null;

  constructor(private storageDir: string) {}

  /** Get the encryption key, creating one if it doesn't exist. */
  getOrCreateKey(): Buffer {
    if (this.cachedKey) return this.cachedKey;

    const keyPath = path.join(this.storageDir, KEY_FILE);

    if (fs.existsSync(keyPath)) {
      this.cachedKey = this.loadKey(keyPath);
    } else {
      this.cachedKey = randomBytes(KEY_LENGTH);
      this.saveKey(keyPath, this.cachedKey);
    }

    return this.cachedKey;
  }

  private saveKey(keyPath: string, key: Buffer): void {
    const encrypted = this.wrapKey(key);
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    fs.writeFileSync(keyPath, encrypted, 'utf-8');
  }

  private loadKey(keyPath: string): Buffer {
    const encrypted = fs.readFileSync(keyPath, 'utf-8');
    return this.unwrapKey(encrypted);
  }

  private wrapKey(key: Buffer): string {
    try {
      const { safeStorage } = require('electron');
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.encryptString(key.toString('base64')).toString('base64');
      }
    } catch {
      // Not in Electron context
    }
    return this.fallbackWrap(key);
  }

  private unwrapKey(wrapped: string): Buffer {
    try {
      const { safeStorage } = require('electron');
      if (safeStorage.isEncryptionAvailable()) {
        const decrypted = safeStorage.decryptString(Buffer.from(wrapped, 'base64'));
        return Buffer.from(decrypted, 'base64');
      }
    } catch {
      // Not in Electron context
    }
    return this.fallbackUnwrap(wrapped);
  }

  private getMachineSecret(): Buffer {
    const info = `${os.hostname()}-${os.userInfo().username}-sarah-key-wrap`;
    return scryptSync(info, 'sarah-salt-v1', 32);
  }

  private fallbackWrap(key: Buffer): string {
    const wrapKey = this.getMachineSecret();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', wrapKey, iv);
    const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, tag]).toString('base64');
  }

  private fallbackUnwrap(wrapped: string): Buffer {
    const wrapKey = this.getMachineSecret();
    const data = Buffer.from(wrapped, 'base64');
    const iv = data.subarray(0, 12);
    const tag = data.subarray(data.length - 16);
    const encrypted = data.subarray(12, data.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', wrapKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
}
