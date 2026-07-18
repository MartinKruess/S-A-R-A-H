import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TokenStore, type StoredToken } from './token-store.js';
import type { KeyManager } from '../../core/crypto/key-manager.js';

/** Stub KeyManager with a fixed 32-byte key (no filesystem key involved). */
function stubKeyManager(): KeyManager {
  const key = Buffer.alloc(32, 7);
  return { getOrCreateKey: () => key } as unknown as KeyManager;
}

const token: StoredToken = {
  refreshToken: 'refresh-secret-abc',
  accessToken: 'access-secret-xyz',
  expiresAt: 1_700_000_000_000,
  scope: 'user-modify-playback-state',
};

describe('TokenStore', () => {
  let tmpDir: string;
  let keyManager: KeyManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-tokens-'));
    keyManager = stubKeyManager();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('set → get round-trips through an encrypted file', () => {
    const store = new TokenStore(tmpDir, keyManager);
    store.set('spotify', token);
    expect(store.get('spotify')).toEqual(token);
    expect(store.has('spotify')).toBe(true);

    // A fresh instance reads it back from disk.
    const store2 = new TokenStore(tmpDir, keyManager);
    expect(store2.get('spotify')).toEqual(token);
  });

  it('on-disk file is encrypted (does not contain the token strings)', () => {
    const store = new TokenStore(tmpDir, keyManager);
    store.set('spotify', token);
    const raw = fs.readFileSync(path.join(tmpDir, 'connections.enc'), 'utf-8');
    expect(raw).not.toContain('refresh-secret-abc');
    expect(raw).not.toContain('access-secret-xyz');
    expect(raw).not.toContain('spotify');
  });

  it('delete removes the entry and persists', () => {
    const store = new TokenStore(tmpDir, keyManager);
    store.set('spotify', token);
    store.delete('spotify');
    expect(store.has('spotify')).toBe(false);
    expect(store.get('spotify')).toBeUndefined();

    const store2 = new TokenStore(tmpDir, keyManager);
    expect(store2.has('spotify')).toBe(false);
  });

  it('missing file → empty store', () => {
    const store = new TokenStore(tmpDir, keyManager);
    expect(store.get('spotify')).toBeUndefined();
    expect(store.has('anything')).toBe(false);
  });

  it('corrupt file → empty store (no throw)', () => {
    fs.writeFileSync(path.join(tmpDir, 'connections.enc'), 'not-valid-base64-or-cipher', 'utf-8');
    const store = new TokenStore(tmpDir, keyManager);
    expect(store.get('spotify')).toBeUndefined();
  });
});
