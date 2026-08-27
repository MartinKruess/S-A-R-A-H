import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppContext, bootstrap, repairInvalidConfig } from './bootstrap.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('bootstrap', () => {
  let tmpDir: string;
  let ctx: AppContext;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-boot-'));
    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 93) });
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

  it('keeps normal trust defaults on a clean first installation', () => {
    expect(ctx.configErrors).toBeNull();
    expect(ctx.parsedConfig.trust).toEqual(expect.objectContaining({
      memoryAllowed: true,
      fileAccess: 'specific-folders',
      confirmationLevel: 'standard',
    }));
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

  it('persistently removes reserved custom-command collisions from an existing config', async () => {
    await ctx.config.set('root', {
      controls: {
        customCommands: [
          { command: ' /CONFIRM ', prompt: 'Kollision' },
          { command: '/meincommand', prompt: 'Bleibt erhalten' },
        ],
      },
    });
    await ctx.shutdown();

    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 93) });

    expect(ctx.parsedConfig.controls.customCommands).toEqual([
      { command: '/meincommand', prompt: 'Bleibt erhalten' },
    ]);
    const persisted = await ctx.config.get<{
      controls: { customCommands: Array<{ command: string; prompt: string }> };
    }>('root');
    expect(persisted?.controls.customCommands).toEqual([
      { command: '/meincommand', prompt: 'Bleibt erhalten' },
    ]);
  });

  it('persists validated defaults after an invalid config is accepted', async () => {
    await ctx.config.set('root', { controls: { voiceMode: 'invalid' } });
    await ctx.shutdown();
    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 93) });
    expect(ctx.configErrors).not.toBeNull();

    await repairInvalidConfig(ctx);
    expect(ctx.configErrors).toBeNull();
    expect(await ctx.config.get('root')).toEqual(ctx.parsedConfig);

    await ctx.shutdown();
    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 93) });
    expect(ctx.configErrors).toBeNull();
  });

  it('uses fail-closed trust defaults when config JSON and backup are unreadable', async () => {
    await ctx.shutdown();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{broken', 'utf-8');

    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 93) });

    expect(ctx.configErrors).not.toBeNull();
    expect(ctx.parsedConfig.trust).toEqual(expect.objectContaining({
      memoryAllowed: false,
      fileAccess: 'none',
      confirmationLevel: 'maximal',
    }));
    expect(ctx.lifecycle.snapshot.capabilities.storage?.state).toBe('degraded');
  });

  it('fails closed when persisted config material has no root value', async () => {
    await ctx.shutdown();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}', 'utf-8');

    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 93) });

    expect(ctx.configErrors).toEqual(expect.arrayContaining([expect.stringContaining('root-Wert')]));
    expect(ctx.parsedConfig.trust).toEqual(expect.objectContaining({
      memoryAllowed: false,
      fileAccess: 'none',
      confirmationLevel: 'maximal',
    }));
  });

  it('loads the valid config backup when the primary file is missing', async () => {
    await ctx.config.set('root', {
      ...ctx.parsedConfig,
      trust: {
        ...ctx.parsedConfig.trust,
        memoryAllowed: true,
        fileAccess: 'all',
        confirmationLevel: 'minimal',
        anonymousEnabled: true,
        showContextEnabled: true,
      },
    });
    await ctx.config.set('root', {
      ...ctx.parsedConfig,
      trust: {
        ...ctx.parsedConfig.trust,
        memoryAllowed: false,
        fileAccess: 'none',
        confirmationLevel: 'maximal',
        anonymousEnabled: false,
        showContextEnabled: false,
      },
    });
    await ctx.shutdown();
    fs.rmSync(path.join(tmpDir, 'config.json'));

    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 93) });

    expect(ctx.parsedConfig.trust).toEqual(expect.objectContaining({
      memoryAllowed: false,
      fileAccess: 'none',
      confirmationLevel: 'maximal',
      anonymousEnabled: false,
      showContextEnabled: false,
    }));
    expect(ctx.configErrors).toEqual(expect.arrayContaining([expect.stringContaining('fehlte')]));
    expect(ctx.lifecycle.snapshot.capabilities.storage?.state).toBe('degraded');
  });

  it('fails closed after encrypted config recovery discovers a permissive older backup', async () => {
    await ctx.config.set('root', {
      ...ctx.parsedConfig,
      trust: {
        ...ctx.parsedConfig.trust,
        memoryAllowed: true,
        fileAccess: 'all',
        confirmationLevel: 'minimal',
        anonymousEnabled: true,
        showContextEnabled: true,
      },
    });
    await ctx.config.set('root', {
      ...ctx.parsedConfig,
      trust: {
        ...ctx.parsedConfig.trust,
        memoryAllowed: false,
        fileAccess: 'none',
        confirmationLevel: 'maximal',
        anonymousEnabled: false,
        showContextEnabled: false,
      },
    });
    await ctx.shutdown();

    const configPath = path.join(tmpDir, 'config.json');
    const primary = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    primary.root = 'sarah-enc:v2:invalid-authenticated-ciphertext';
    fs.writeFileSync(configPath, JSON.stringify(primary), 'utf-8');

    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 93) });

    expect(ctx.parsedConfig.trust).toEqual(expect.objectContaining({
      memoryAllowed: false,
      fileAccess: 'none',
      confirmationLevel: 'maximal',
      anonymousEnabled: false,
      showContextEnabled: false,
    }));
    expect(ctx.configErrors).toEqual(expect.arrayContaining([
      expect.stringContaining('kryptografisch ungültig'),
    ]));
    expect(ctx.lifecycle.snapshot.capabilities.storage?.state).toBe('degraded');
  });

  it('shutdown is safe when called repeatedly', async () => {
    await expect(Promise.all([ctx.shutdown(), ctx.shutdown()])).resolves.not.toThrow();
    expect(ctx.lifecycle.snapshot.state).toBe('stopped');
  });

  it('releases partial storage resources when database bootstrap fails', async () => {
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-broken-'));
    const dbPath = path.join(brokenDir, 'sarah.db');
    fs.writeFileSync(dbPath, 'not a sqlite database');

    await expect(bootstrap(brokenDir, { testWrappingKey: Buffer.alloc(32, 93) })).rejects.toThrow();

    expect(() => fs.rmSync(brokenDir, { recursive: true, force: true })).not.toThrow();
  });
});
