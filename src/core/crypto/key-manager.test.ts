import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KeyManager } from './key-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
});
