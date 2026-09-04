import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KeyManager } from '../../../src/core/crypto/key-manager.js';
import {
  AiCredentialStore,
  AiCredentialStoreDegradedError,
  type AiCredentialIdentity,
} from '../../../src/services/integrations/ai-credential-store.js';

const WRAPPING_KEY = Buffer.alloc(32, 41);
const OPENAI: AiCredentialIdentity = {
  connectionId: '2ddfe415-c1dc-4dba-84bd-e80b7bf86d84',
  providerId: 'openai',
  authKind: 'api_key',
};
const ANTHROPIC: AiCredentialIdentity = {
  connectionId: 'd9fb4e89-e216-4bdd-ab2b-9e992838721e',
  providerId: 'anthropic',
  authKind: 'api_key',
};

describe('AiCredentialStore', () => {
  let tmpDir: string;
  let keyManager: KeyManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-ai-credentials-'));
    keyManager = new KeyManager(tmpDir, { testWrappingKey: WRAPPING_KEY });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('roundtrips internally without writing the API key as plaintext', () => {
    const store = new AiCredentialStore(tmpDir, keyManager);
    const apiKey = 'sk-test-super-secret';

    store.write(OPENAI, apiKey);

    expect(store.read(OPENAI)).toBe(apiKey);
    const raw = fs.readFileSync(
      path.join(tmpDir, 'ai-credentials', `${OPENAI.connectionId}.enc`),
      'utf-8',
    );
    expect(raw).not.toContain(apiKey);
    expect(raw).toMatch(/^sarah-ai-credential:v1:/u);
  });

  it('replaces one credential through a newer redundant commit', () => {
    const store = new AiCredentialStore(tmpDir, keyManager);
    store.write(OPENAI, 'sk-old-secret');

    store.write(OPENAI, 'sk-new-secret');

    expect(new AiCredentialStore(tmpDir, keyManager).read(OPENAI)).toBe('sk-new-secret');
  });

  it('binds ciphertext to the exact provider identity', () => {
    const store = new AiCredentialStore(tmpDir, keyManager);
    store.write(OPENAI, 'sk-test-super-secret');

    expect(store.read({ ...OPENAI, providerId: 'anthropic' })).toBeUndefined();
    expect(store.status({ ...OPENAI, providerId: 'anthropic' }).state).toBe('degraded');
  });

  it('recovers one corrupt primary from its valid backup', () => {
    new AiCredentialStore(tmpDir, keyManager).write(OPENAI, 'sk-test-super-secret');
    fs.writeFileSync(
      path.join(tmpDir, 'ai-credentials', `${OPENAI.connectionId}.enc`),
      'corrupt',
      'utf-8',
    );

    const recovered = new AiCredentialStore(tmpDir, keyManager);

    expect(recovered.read(OPENAI)).toBe('sk-test-super-secret');
    expect(recovered.status(OPENAI).state).toBe('recovered');
  });

  it('blocks overwrite when both isolated copies are corrupt', () => {
    new AiCredentialStore(tmpDir, keyManager).write(OPENAI, 'sk-test-super-secret');
    const root = path.join(tmpDir, 'ai-credentials');
    fs.writeFileSync(path.join(root, `${OPENAI.connectionId}.enc`), 'corrupt', 'utf-8');
    fs.writeFileSync(path.join(root, `${OPENAI.connectionId}.enc.bak`), 'corrupt', 'utf-8');
    const degraded = new AiCredentialStore(tmpDir, keyManager);

    expect(degraded.read(OPENAI)).toBeUndefined();
    expect(degraded.status(OPENAI).state).toBe('degraded');
    expect(() => degraded.write(OPENAI, 'sk-new-secret')).toThrow(AiCredentialStoreDegradedError);
  });

  it('isolates corruption and deletion to one connection without touching OAuth', () => {
    const store = new AiCredentialStore(tmpDir, keyManager);
    store.write(OPENAI, 'sk-openai-secret');
    store.write(ANTHROPIC, 'sk-anthropic-secret');
    fs.writeFileSync(path.join(tmpDir, 'connections.enc'), 'oauth-keep', 'utf-8');

    store.delete(OPENAI);

    expect(store.read(OPENAI)).toBeUndefined();
    expect(store.read(ANTHROPIC)).toBe('sk-anthropic-secret');
    expect(fs.readFileSync(path.join(tmpDir, 'connections.enc'), 'utf-8')).toBe('oauth-keep');
  });

  it('selects the newer valid commit after an interrupted primary publish', () => {
    const initial = new AiCredentialStore(tmpDir, keyManager);
    initial.write(OPENAI, 'sk-old-secret');
    const faulting = new AiCredentialStore(tmpDir, keyManager, () => {
      throw new Error('injected failure');
    });

    expect(() => faulting.write(OPENAI, 'sk-new-secret')).toThrow('injected failure');

    const recovered = new AiCredentialStore(tmpDir, keyManager);
    expect(recovered.read(OPENAI)).toBe('sk-new-secret');
    expect(recovered.status(OPENAI).state).toBe('recovered');
  });

  it('rejects invalid connection IDs before resolving a path', () => {
    expect(() => new AiCredentialStore(tmpDir, keyManager).write(
      { ...OPENAI, connectionId: '../escape' },
      'sk-test-super-secret',
    )).toThrow();
    expect(fs.existsSync(path.join(tmpDir, 'escape.enc'))).toBe(false);
  });

  it('refuses a symlink credential directory', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-ai-target-'));
    try {
      fs.symlinkSync(target, path.join(tmpDir, 'ai-credentials'), 'junction');
      expect(() => new AiCredentialStore(tmpDir, keyManager).write(
        OPENAI,
        'sk-test-super-secret',
      )).toThrow('not a local directory');
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});
