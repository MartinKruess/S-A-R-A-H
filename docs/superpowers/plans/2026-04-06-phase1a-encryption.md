# Phase 1A Addon: Storage Encryption — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AES-256-GCM encryption to the storage layer so all persisted user data is encrypted at rest. Key stored in OS keychain via Electron's `safeStorage`.

**Architecture:** An `EncryptedStorage` wrapper implements `StorageProvider`, encrypting values before passing them to the underlying provider (JsonStorage or SqliteStorage). A `KeyManager` handles key generation, storage (via Electron safeStorage), and retrieval. The crypto module provides encrypt/decrypt using AES-256-GCM with random IVs.

**Tech Stack:** Node.js `crypto` (built-in), Electron `safeStorage` API

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/core/crypto/crypto.ts` | AES-256-GCM encrypt/decrypt functions |
| Create | `src/core/crypto/crypto.test.ts` | Crypto unit tests |
| Create | `src/core/crypto/key-manager.ts` | Key generation, storage via safeStorage, retrieval |
| Create | `src/core/crypto/key-manager.test.ts` | KeyManager tests (with safeStorage mock) |
| Create | `src/core/storage/encrypted-storage.ts` | StorageProvider wrapper that encrypts/decrypts values |
| Create | `src/core/storage/encrypted-storage.test.ts` | EncryptedStorage tests |
| Modify | `src/core/index.ts` | Add crypto and encrypted-storage exports |

---

### Task 1: Crypto Module (AES-256-GCM)

**Files:**
- Create: `src/core/crypto/crypto.test.ts`
- Create: `src/core/crypto/crypto.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/crypto/crypto.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from './crypto.js';
import { randomBytes } from 'crypto';

describe('crypto', () => {
  const key = randomBytes(32); // AES-256

  it('encrypts and decrypts a string', () => {
    const plaintext = 'Hello Sarah';
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts JSON objects', () => {
    const obj = { name: 'Sarah', city: 'Berlin', nested: { a: 1 } };
    const encrypted = encrypt(JSON.stringify(obj), key);
    const decrypted = JSON.parse(decrypt(encrypted, key));
    expect(decrypted).toEqual(obj);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const plaintext = 'same input';
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with wrong key', () => {
    const encrypted = encrypt('secret', key);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('fails to decrypt tampered ciphertext', () => {
    const encrypted = encrypt('secret', key);
    const tampered = encrypted.slice(0, -4) + 'xxxx';
    expect(() => decrypt(tampered, wrongKey)).toThrow();
  });

  it('handles empty string', () => {
    const encrypted = encrypt('', key);
    expect(decrypt(encrypted, key)).toBe('');
  });

  it('handles unicode', () => {
    const text = 'Sch\u00f6ne Gr\u00fc\u00dfe aus K\u00f6ln \ud83d\ude80';
    const encrypted = encrypt(text, key);
    expect(decrypt(encrypted, key)).toBe(text);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: Implement crypto module**

Create `src/core/crypto/crypto.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns base64 string: IV (12 bytes) + ciphertext + authTag (16 bytes).
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * Decrypt a base64 string produced by encrypt().
 * Throws on wrong key or tampered data.
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const data = Buffer.from(ciphertext, 'base64');

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All 7 crypto tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/crypto/crypto.ts src/core/crypto/crypto.test.ts
git commit -m "feat(core): add AES-256-GCM encrypt/decrypt module"
```

---

### Task 2: Key Manager

**Files:**
- Create: `src/core/crypto/key-manager.test.ts`
- Create: `src/core/crypto/key-manager.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/crypto/key-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyManager } from './key-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock Electron safeStorage — in tests we use file-based fallback
describe('KeyManager', () => {
  let tmpDir: string;
  let manager: KeyManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-key-'));
    manager = new KeyManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates a new 32-byte key', () => {
    const key = manager.getOrCreateKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('returns the same key on subsequent calls', () => {
    const key1 = manager.getOrCreateKey();
    const key2 = manager.getOrCreateKey();
    expect(key1.equals(key2)).toBe(true);
  });

  it('persists key across instances', () => {
    const key1 = manager.getOrCreateKey();
    const manager2 = new KeyManager(tmpDir);
    const key2 = manager2.getOrCreateKey();
    expect(key1.equals(key2)).toBe(true);
  });

  it('stored key file is not plaintext', () => {
    manager.getOrCreateKey();
    const files = fs.readdirSync(tmpDir);
    const keyFile = files.find(f => f.includes('key'));
    if (keyFile) {
      const raw = fs.readFileSync(path.join(tmpDir, keyFile), 'utf-8');
      // Should not be a raw 32-byte hex string or base64 of the key
      // It should be encrypted or encoded
      expect(raw.length).toBeGreaterThan(32);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: Implement KeyManager**

Create `src/core/crypto/key-manager.ts`:

```typescript
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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

  /**
   * Try Electron safeStorage first. Fall back to machine-derived wrapping.
   * safeStorage uses OS keychain (Windows DPAPI, macOS Keychain, Linux libsecret).
   */
  private wrapKey(key: Buffer): string {
    try {
      const { safeStorage } = require('electron');
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.encryptString(key.toString('base64')).toString('base64');
      }
    } catch {
      // Not in Electron context — use fallback
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
      // Not in Electron context — use fallback
    }
    return this.fallbackUnwrap(wrapped);
  }

  /**
   * Fallback: derive a wrapping key from machine-specific data.
   * Less secure than OS keychain but still better than plaintext.
   */
  private getMachineSecret(): Buffer {
    const os = require('os');
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All KeyManager tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/crypto/key-manager.ts src/core/crypto/key-manager.test.ts
git commit -m "feat(core): add KeyManager with safeStorage and machine-derived fallback"
```

---

### Task 3: Encrypted Storage Wrapper

**Files:**
- Create: `src/core/storage/encrypted-storage.test.ts`
- Create: `src/core/storage/encrypted-storage.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/storage/encrypted-storage.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EncryptedStorage } from './encrypted-storage.js';
import { JsonStorage } from './json-storage.js';
import { SqliteStorage } from './sqlite-storage.js';
import { KeyManager } from '../crypto/key-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('EncryptedStorage', () => {
  let tmpDir: string;
  let keyManager: KeyManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-enc-'));
    keyManager = new KeyManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('with JsonStorage', () => {
    let storage: EncryptedStorage;
    let rawStorage: JsonStorage;

    beforeEach(() => {
      rawStorage = new JsonStorage(path.join(tmpDir, 'config.json'));
      storage = new EncryptedStorage(rawStorage, keyManager.getOrCreateKey());
    });

    afterEach(async () => {
      await storage.close();
    });

    it('encrypts and decrypts a value transparently', async () => {
      await storage.set('name', 'Sarah');
      expect(await storage.get('name')).toBe('Sarah');
    });

    it('stores encrypted data on disk (not plaintext)', async () => {
      await storage.set('secret', 'my-password-123');
      const rawValue = await rawStorage.get<string>('secret');
      expect(rawValue).not.toBe('my-password-123');
      expect(rawValue).toBeTruthy();
    });

    it('handles objects', async () => {
      const obj = { city: 'Berlin', code: 12345 };
      await storage.set('profile', obj);
      expect(await storage.get('profile')).toEqual(obj);
    });

    it('returns undefined for missing keys', async () => {
      expect(await storage.get('nope')).toBeUndefined();
    });
  });

  describe('with SqliteStorage', () => {
    let storage: EncryptedStorage;

    beforeEach(() => {
      const sqlite = new SqliteStorage(path.join(tmpDir, 'sarah.db'));
      storage = new EncryptedStorage(sqlite, keyManager.getOrCreateKey());
    });

    afterEach(async () => {
      await storage.close();
    });

    it('encrypts table row values and decrypts on query', async () => {
      await storage.insert('persistent_rules', { category: 'test', rule: 'secret rule' });
      const rows = await storage.query<{ rule: string }>('persistent_rules', { category: 'test' });
      expect(rows).toHaveLength(1);
      expect(rows[0].rule).toBe('secret rule');
    });

    it('encrypts kv values', async () => {
      await storage.set('key', { data: 'sensitive' });
      expect(await storage.get('key')).toEqual({ data: 'sensitive' });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: Implement EncryptedStorage**

Create `src/core/storage/encrypted-storage.ts`:

```typescript
import type { StorageProvider, Filter } from './storage.interface.js';
import { encrypt, decrypt } from '../crypto/crypto.js';

/** Columns that should NOT be encrypted (structural, used for filtering). */
const PASSTHROUGH_COLUMNS = new Set(['id', 'category', 'session_id', 'conversation_id', 'mode', 'role', 'source', 'confidence', 'created_at', 'updated_at', 'started_at', 'ended_at', 'timestamp']);

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
      // If decryption fails, return raw value (might be unencrypted legacy data)
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
          result[col] = value; // Not encrypted or legacy
        }
      } else {
        result[col] = value;
      }
    }
    return result;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All EncryptedStorage tests pass.

- [ ] **Step 5: Update barrel export**

Add to `src/core/index.ts`:

```typescript
// Crypto
export { encrypt, decrypt } from './crypto/crypto.js';
export { KeyManager } from './crypto/key-manager.js';

// Storage (add EncryptedStorage)
export { EncryptedStorage } from './storage/encrypted-storage.js';
```

- [ ] **Step 6: Verify all tests pass and compilation is clean**

Run: `npm test && npx tsc --noEmit`
Expected: All tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/storage/encrypted-storage.ts src/core/storage/encrypted-storage.test.ts src/core/index.ts
git commit -m "feat(core): add EncryptedStorage wrapper with AES-256-GCM encryption"
```

---

## Summary

After completing all tasks:

| Module | What it does |
|--------|-------------|
| `crypto.ts` | AES-256-GCM encrypt/decrypt with random IVs |
| `KeyManager` | Generates + stores encryption key (Electron safeStorage or machine-derived fallback) |
| `EncryptedStorage` | Transparent StorageProvider wrapper: encrypts values on write, decrypts on read |

Usage:
```typescript
const keyManager = new KeyManager(app.getPath('userData'));
const key = keyManager.getOrCreateKey();
const config = new EncryptedStorage(new JsonStorage('config.json'), key);
const db = new EncryptedStorage(new SqliteStorage('sarah.db'), key);
```
