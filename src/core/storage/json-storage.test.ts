import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonStorage } from './json-storage.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('JsonStorage', () => {
  let storage: JsonStorage;
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-test-'));
    filePath = path.join(tmpDir, 'config.json');
    storage = new JsonStorage(filePath);
  });

  afterEach(async () => {
    await storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined for missing keys', async () => {
    expect(await storage.get('nonexistent')).toBeUndefined();
  });

  it('sets and gets a value', async () => {
    await storage.set('name', 'Sarah');
    expect(await storage.get('name')).toBe('Sarah');
  });

  it('sets and gets nested objects', async () => {
    await storage.set('profile', { name: 'Sarah', city: 'Berlin' });
    expect(await storage.get('profile')).toEqual({ name: 'Sarah', city: 'Berlin' });
  });

  it('overwrites existing values', async () => {
    await storage.set('color', 'blue');
    await storage.set('color', 'red');
    expect(await storage.get('color')).toBe('red');
  });

  it('persists to disk', async () => {
    await storage.set('persisted', true);

    const storage2 = new JsonStorage(filePath);
    expect(await storage2.get('persisted')).toBe(true);
    await storage2.close();
  });

  it('handles dot-notation keys for nested access', async () => {
    await storage.set('onboarding.setupComplete', true);
    expect(await storage.get('onboarding.setupComplete')).toBe(true);
    expect(await storage.get<Record<string, unknown>>('onboarding')).toEqual({ setupComplete: true });
  });

  it('creates the file if it does not exist', async () => {
    const newPath = path.join(tmpDir, 'new.json');
    const s = new JsonStorage(newPath);
    await s.set('key', 'val');
    expect(fs.existsSync(newPath)).toBe(true);
    await s.close();
  });

  it('recovers the last valid snapshot when the primary file is corrupt', async () => {
    await storage.set('version', 1);
    await storage.set('version', 2);
    fs.writeFileSync(filePath, '{broken', 'utf-8');

    const recovered = new JsonStorage(filePath);

    expect(await recovered.get('version')).toBe(1);
    expect(recovered.getRecoveryIssues()).toHaveLength(1);
    expect(recovered.requiresFailClosedDefaults()).toBe(false);
    await recovered.close();
  });

  it('reports an unrecoverable primary without silently treating it as a clean empty config', async () => {
    fs.writeFileSync(filePath, '{broken', 'utf-8');

    const recovered = new JsonStorage(filePath);

    expect(recovered.getRecoveryIssues()).toHaveLength(1);
    expect(recovered.requiresFailClosedDefaults()).toBe(true);
    await recovered.close();
  });

  it('loads a valid backup when the primary config is missing', async () => {
    fs.writeFileSync(`${filePath}.bak`, JSON.stringify({ trust: { memoryAllowed: false } }), 'utf-8');

    const recovered = new JsonStorage(filePath);

    expect(await recovered.get('trust.memoryAllowed')).toBe(false);
    expect(recovered.requiresFailClosedDefaults()).toBe(false);
    expect(recovered.getRecoveryIssues()).toEqual([expect.stringContaining('fehlte')]);
    await recovered.close();
  });

  it('fails closed when the primary is missing and the backup is corrupt', async () => {
    fs.writeFileSync(`${filePath}.bak`, '{broken', 'utf-8');

    const recovered = new JsonStorage(filePath);

    expect(recovered.requiresFailClosedDefaults()).toBe(true);
    expect(recovered.getRecoveryIssues()).toEqual([expect.stringContaining('nicht lesbar')]);
    await recovered.close();
  });
});
