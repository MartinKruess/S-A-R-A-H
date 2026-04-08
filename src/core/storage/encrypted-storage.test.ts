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
