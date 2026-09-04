import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KeyAccessError, KeyManager } from '../../../src/core/crypto/key-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('KeyManager', () => {
  let tmpDir: string;
  let manager: KeyManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-key-'));
    manager = new KeyManager(tmpDir, { testWrappingKey: Buffer.alloc(32, 91) });
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
    const manager2 = new KeyManager(tmpDir, { testWrappingKey: Buffer.alloc(32, 91) });
    const key2 = manager2.getOrCreateKey();
    expect(key1.equals(key2)).toBe(true);
  });

  it('stored key file is not plaintext', () => {
    const key = manager.getOrCreateKey();
    const files = fs.readdirSync(tmpDir);
    const keyFile = files.find(f => f.includes('key'));
    expect(keyFile).toBeTruthy();
    if (keyFile) {
      const raw = fs.readFileSync(path.join(tmpDir, keyFile), 'utf-8');
      // The raw file should NOT contain the key in plain base64 or hex
      const keyBase64 = key.toString('base64');
      const keyHex = key.toString('hex');
      expect(raw).not.toBe(keyBase64);
      expect(raw).not.toBe(keyHex);
      expect(raw.length).toBeGreaterThan(32);
    }
  });

  it('restores a missing primary key from its redundant copy', () => {
    const key = manager.getOrCreateKey();
    fs.rmSync(path.join(tmpDir, 'sarah.key'));

    const restored = new KeyManager(tmpDir, { testWrappingKey: Buffer.alloc(32, 91) }).getOrCreateKey();

    expect(restored.equals(key)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sarah.key'))).toBe(true);
  });

  it('restores a corrupt primary key from its redundant copy', () => {
    const key = manager.getOrCreateKey();
    fs.writeFileSync(path.join(tmpDir, 'sarah.key'), 'broken', 'utf-8');

    const restored = new KeyManager(tmpDir, { testWrappingKey: Buffer.alloc(32, 91) }).getOrCreateKey();

    expect(restored.equals(key)).toBe(true);
  });

  it.each([
    'config.json',
    'config.json.bak',
    'sarah.db',
    'sarah.db-wal',
    'sarah.db-shm',
    'sarah.db-journal',
    'connections.enc',
    'connections.enc.bak',
  ])('refuses to create a replacement key when %s exists', (storeName) => {
    fs.writeFileSync(path.join(tmpDir, storeName), 'existing-store', 'utf-8');
    let failure: KeyAccessError | null = null;
    try {
      manager.getOrCreateKey();
    } catch (error) {
      if (error instanceof KeyAccessError) failure = error;
    }
    expect(failure?.reason).toBe('encrypted-stores-without-key');
    expect(failure?.isFinalKeyLoss).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sarah.key'))).toBe(false);
  });

  it('refuses to create a replacement key when isolated AI credentials exist', () => {
    const credentialDir = path.join(tmpDir, 'ai-credentials');
    fs.mkdirSync(credentialDir);
    fs.writeFileSync(path.join(credentialDir, 'connection.enc'), 'existing-store', 'utf-8');

    let failure: KeyAccessError | null = null;
    try {
      manager.getOrCreateKey();
    } catch (error) {
      if (error instanceof KeyAccessError) failure = error;
    }

    expect(failure?.reason).toBe('encrypted-stores-without-key');
    expect(fs.existsSync(path.join(tmpDir, 'sarah.key'))).toBe(false);
  });

  it('classifies two unreadable key envelopes as final loss', () => {
    manager.getOrCreateKey();

    const wrongManager = new KeyManager(tmpDir, { testWrappingKey: Buffer.alloc(32, 92) });
    let failure: KeyAccessError | null = null;
    try {
      wrongManager.getOrCreateKey();
    } catch (error) {
      if (error instanceof KeyAccessError) failure = error;
    }

    expect(failure?.reason).toBe('key-envelopes-unreadable');
    expect(failure?.isFinalKeyLoss).toBe(true);
  });

  it('does not classify isolated encrypted-store corruption as key loss', () => {
    const key = manager.getOrCreateKey();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), 'corrupt-ciphertext', 'utf-8');

    const loaded = new KeyManager(tmpDir, { testWrappingKey: Buffer.alloc(32, 91) }).getOrCreateKey();

    expect(loaded.equals(key)).toBe(true);
  });

  it('keeps unavailable safeStorage transient even when both envelopes exist', () => {
    const wrapped = 'sarah-key:safe:v1:bm90LWEtcmVhbC1lbnZlbG9wZQ==';
    fs.writeFileSync(path.join(tmpDir, 'sarah.key'), wrapped, 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'sarah.key.bak'), wrapped, 'utf-8');

    let failure: KeyAccessError | null = null;
    try {
      new KeyManager(tmpDir).getOrCreateKey();
    } catch (error) {
      if (error instanceof KeyAccessError) failure = error;
    }

    expect(failure?.reason).toBe('safe-storage-unavailable');
    expect(failure?.isFinalKeyLoss).toBe(false);
  });

  it('fails closed without safeStorage or an explicit test wrapping key', () => {
    const productionManager = new KeyManager(tmpDir);
    let failure: KeyAccessError | null = null;
    try {
      productionManager.getOrCreateKey();
    } catch (error) {
      if (error instanceof KeyAccessError) failure = error;
    }
    expect(failure?.reason).toBe('safe-storage-unavailable');
    expect(failure?.isFinalKeyLoss).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'sarah.key'))).toBe(false);
  });
});
