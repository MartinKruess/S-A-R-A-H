// src/services/integrations/token-store.ts
// Encrypted at-rest store for OAuth tokens. Mirrors the AES-256-GCM fallback
// pattern in core/crypto/key-manager.ts: 12-byte random IV prepended, 16-byte
// auth tag appended, whole blob base64 into `<storageDir>/connections.enc`.
// Never writes plaintext tokens to disk.

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { KeyManager } from '../../core/crypto/key-manager.js';

const STORE_FILE = 'connections.enc';

export type StoredToken = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scope: string;
};

type StoreData = Record<string, StoredToken>;

export class TokenStore {
  private data: StoreData | null = null;

  constructor(
    private storageDir: string,
    private keyManager: KeyManager,
  ) {}

  get(id: string): StoredToken | undefined {
    return this.load()[id];
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  set(id: string, token: StoredToken): void {
    const data = this.load();
    data[id] = token;
    this.persist();
  }

  delete(id: string): void {
    const data = this.load();
    if (id in data) {
      delete data[id];
      this.persist();
    }
  }

  /** Lazily load and decrypt the store; tolerate a missing/corrupt file (start empty). */
  private load(): StoreData {
    if (this.data) return this.data;
    const filePath = path.join(this.storageDir, STORE_FILE);
    try {
      if (fs.existsSync(filePath)) {
        const wrapped = fs.readFileSync(filePath, 'utf-8');
        this.data = JSON.parse(this.decrypt(wrapped)) as StoreData;
      } else {
        this.data = {};
      }
    } catch {
      // Missing/corrupt/undecryptable file → start empty.
      this.data = {};
    }
    return this.data;
  }

  private persist(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    const wrapped = this.encrypt(JSON.stringify(this.data ?? {}));
    fs.writeFileSync(path.join(this.storageDir, STORE_FILE), wrapped, 'utf-8');
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
}
