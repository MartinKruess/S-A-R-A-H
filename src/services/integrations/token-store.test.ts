import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createCipheriv } from 'crypto';
import { TokenStore, type StoredToken } from './token-store.js';
import type { KeyManager } from '../../core/crypto/key-manager.js';
import { encrypt } from '../../core/crypto/crypto.js';

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

function writeV1Store(filePath: string, data: Record<string, StoredToken>): void {
  const key = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()]);
  const wrapped = Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64');
  fs.writeFileSync(filePath, `sarah-oauth:v1:${wrapped}`, 'utf-8');
}

function writeV2Store(filePath: string, data: Record<string, StoredToken>, generation = 4): void {
  const wrapped = encrypt(JSON.stringify({
    version: 2,
    generation,
    commitId: 'legacy-v2-commit',
    data,
  }), Buffer.alloc(32, 7));
  fs.writeFileSync(filePath, `sarah-oauth:v2:${wrapped}`, 'utf-8');
}

function writeUnboundV3Store(filePath: string, data: Record<string, StoredToken>): void {
  const wrapped = encrypt(JSON.stringify({
    version: 3,
    generation: 1,
    commitId: 'unbound-v3-commit',
    data,
  }), Buffer.alloc(32, 7));
  fs.writeFileSync(filePath, `sarah-oauth:v3:${wrapped}`, 'utf-8');
}

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
    expect(raw.startsWith('sarah-oauth:v3:')).toBe(true);
  });

  it.each([
    { ...token, refreshToken: '' },
    { ...token, accessToken: '   ' },
    { ...token, expiresAt: Number.NaN },
    { ...token, expiresAt: -1 },
    { ...token, scope: 42 },
  ])('set rejects invalid token data before persistence', (invalidToken) => {
    const store = new TokenStore(tmpDir, keyManager);

    expect(() => store.set('spotify', invalidToken as StoredToken)).toThrow('Invalid token entry');
    expect(fs.existsSync(path.join(tmpDir, 'connections.enc'))).toBe(false);
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

  it.each(['corrupt', 'missing'] as const)(
    'does not resurrect a deleted token from backup when the primary is %s',
    (failure) => {
      const filePath = path.join(tmpDir, 'connections.enc');
      const store = new TokenStore(tmpDir, keyManager);
      store.set('spotify', token);
      store.delete('spotify');

      if (failure === 'corrupt') fs.writeFileSync(filePath, 'corrupt', 'utf-8');
      else fs.rmSync(filePath);

      const recovered = new TokenStore(tmpDir, keyManager);

      expect(recovered.get('spotify')).toBeUndefined();
      expect(recovered.has('spotify')).toBe(false);
      expect(recovered.getStatus()).toEqual(expect.objectContaining({ state: 'recovered' }));
    },
  );

  it('missing file → empty store', () => {
    const store = new TokenStore(tmpDir, keyManager);
    expect(store.get('spotify')).toBeUndefined();
    expect(store.has('anything')).toBe(false);
  });

  it('corrupt file enters a visible degraded state and cannot be overwritten', () => {
    const filePath = path.join(tmpDir, 'connections.enc');
    const corrupt = 'not-valid-base64-or-cipher';
    fs.writeFileSync(filePath, corrupt, 'utf-8');
    const store = new TokenStore(tmpDir, keyManager);
    expect(store.get('spotify')).toBeUndefined();
    expect(store.getStatus()).toEqual(expect.objectContaining({ state: 'degraded' }));
    expect(() => store.set('spotify', token)).toThrow('beschädigt');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(corrupt);
  });

  it('recovers from the last valid backup without treating connections as absent', () => {
    const store = new TokenStore(tmpDir, keyManager);
    store.set('spotify', token);
    store.set('spotify', { ...token, accessToken: 'new-access-token' });
    fs.writeFileSync(path.join(tmpDir, 'connections.enc'), 'corrupt', 'utf-8');

    const recovered = new TokenStore(tmpDir, keyManager);

    expect(recovered.get('spotify')).toEqual({ ...token, accessToken: 'new-access-token' });
    expect(recovered.getStatus()).toEqual(expect.objectContaining({ state: 'recovered' }));
  });

  it('recovers a valid backup when the primary token store is missing', () => {
    const store = new TokenStore(tmpDir, keyManager);
    store.set('spotify', token);
    store.set('spotify', { ...token, accessToken: 'new-access-token' });
    fs.rmSync(path.join(tmpDir, 'connections.enc'));

    const recovered = new TokenStore(tmpDir, keyManager);

    expect(recovered.get('spotify')).toEqual({ ...token, accessToken: 'new-access-token' });
    expect(recovered.getStatus()).toEqual(expect.objectContaining({ state: 'recovered' }));
  });

  it('selects the newer backup commit after a fault between backup and primary publication', () => {
    const store = new TokenStore(tmpDir, keyManager);
    store.set('spotify', token);
    const faultingStore = new TokenStore(tmpDir, keyManager, (point) => {
      if (point === 'after-backup-publish') throw new Error('simulated crash');
    });

    expect(() => faultingStore.delete('spotify')).toThrow('simulated crash');

    const recovered = new TokenStore(tmpDir, keyManager);
    expect(recovered.get('spotify')).toBeUndefined();
    expect(recovered.getStatus()).toEqual(expect.objectContaining({ state: 'recovered' }));
  });

  it('reads a V1 store only as a migration source and immediately publishes both V3 copies', () => {
    const filePath = path.join(tmpDir, 'connections.enc');
    writeV1Store(filePath, { spotify: token });
    const store = new TokenStore(tmpDir, keyManager);

    expect(store.get('spotify')).toEqual(token);
    expect(store.getStatus()).toEqual(expect.objectContaining({ state: 'recovered' }));

    expect(fs.readFileSync(filePath, 'utf-8')).toMatch(/^sarah-oauth:v3:/);
    expect(fs.readFileSync(`${filePath}.bak`, 'utf-8')).toMatch(/^sarah-oauth:v3:/);
    expect(new TokenStore(tmpDir, keyManager).get('spotify')).toEqual(token);
  });

  it('migrates an authenticated V2 envelope to AAD-bound V3 during the first read', () => {
    const filePath = path.join(tmpDir, 'connections.enc');
    writeV2Store(filePath, { spotify: token });

    const store = new TokenStore(tmpDir, keyManager);

    expect(store.get('spotify')).toEqual(token);
    expect(fs.readFileSync(filePath, 'utf-8')).toMatch(/^sarah-oauth:v3:/);
    expect(fs.readFileSync(`${filePath}.bak`, 'utf-8')).toMatch(/^sarah-oauth:v3:/);
  });

  it('rejects a V3 envelope that was not bound to the fixed product/store/schema context', () => {
    const filePath = path.join(tmpDir, 'connections.enc');
    writeUnboundV3Store(filePath, { spotify: token });

    const store = new TokenStore(tmpDir, keyManager);

    expect(store.get('spotify')).toBeUndefined();
    expect(store.getStatus()).toEqual(expect.objectContaining({ state: 'degraded' }));
    expect(fs.readFileSync(filePath, 'utf-8')).toMatch(/^sarah-oauth:v3:/);
  });

  it('uses a divergent V1 backup as the newer partially published snapshot', () => {
    const filePath = path.join(tmpDir, 'connections.enc');
    writeV1Store(filePath, { spotify: token });
    writeV1Store(`${filePath}.bak`, {});

    const recovered = new TokenStore(tmpDir, keyManager);

    expect(recovered.get('spotify')).toBeUndefined();
    expect(recovered.getStatus()).toEqual(expect.objectContaining({ state: 'recovered' }));
  });

  it('fails closed when the primary is missing and its backup is corrupt', () => {
    fs.writeFileSync(path.join(tmpDir, 'connections.enc.bak'), 'corrupt', 'utf-8');
    const recovered = new TokenStore(tmpDir, keyManager);

    expect(recovered.get('spotify')).toBeUndefined();
    expect(recovered.getStatus()).toEqual(expect.objectContaining({ state: 'degraded' }));
    expect(() => recovered.set('spotify', token)).toThrow('nicht lesbar');
  });

  it('reports a stable malformed-envelope failure for an undersized V3 payload', () => {
    const filePath = path.join(tmpDir, 'connections.enc');
    fs.writeFileSync(filePath, `sarah-oauth:v3:${Buffer.alloc(27).toString('base64')}`, 'utf-8');
    const store = new TokenStore(tmpDir, keyManager);

    expect(store.get('spotify')).toBeUndefined();
    expect(store.getStatus()).toMatchObject({
      state: 'degraded',
      message: expect.stringContaining('Encrypted envelope'),
    });
    expect(fs.readFileSync(filePath, 'utf-8')).toMatch(/^sarah-oauth:v3:/);
  });
});
