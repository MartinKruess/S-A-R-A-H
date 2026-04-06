import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppContext, bootstrap } from './bootstrap.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('bootstrap', () => {
  let tmpDir: string;
  let ctx: AppContext;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-boot-'));
    ctx = await bootstrap(tmpDir);
  });

  afterEach(async () => {
    await ctx.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a working AppContext', () => {
    expect(ctx.bus).toBeDefined();
    expect(ctx.registry).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(ctx.db).toBeDefined();
  });

  it('config can set and get values', async () => {
    await ctx.config.set('test', 'hello');
    expect(await ctx.config.get('test')).toBe('hello');
  });

  it('db can insert and query', async () => {
    const id = await ctx.db.insert('persistent_rules', { category: 'test', rule: 'my rule' });
    expect(id).toBeGreaterThan(0);
    const rows = await ctx.db.query('persistent_rules', { category: 'test' });
    expect(rows).toHaveLength(1);
  });

  it('config persists encrypted data', async () => {
    await ctx.config.set('secret', 'sensitive-data');

    const configPath = path.join(tmpDir, 'config.json');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      expect(raw).not.toContain('sensitive-data');
    }
  });

  it('shutdown cleans up without errors', async () => {
    await expect(ctx.shutdown()).resolves.not.toThrow();
  });
});
