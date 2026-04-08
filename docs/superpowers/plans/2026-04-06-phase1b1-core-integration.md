# Phase 1B-1: Core Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the new core infrastructure (MessageBus, ServiceRegistry, EncryptedStorage) into Electron's main process, replacing the manual config loading/saving. The wizard and splash keep working, but now use the proper storage layer with encryption.

**Architecture:** main.ts bootstraps the ServiceRegistry and storage on app startup. Config IPC handlers delegate to JsonStorage (wrapped in EncryptedStorage). The preload API stays the same — the renderer doesn't know about the change.

**Tech Stack:** Existing core modules, Electron main process

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/core/bootstrap.ts` | App initialization: creates bus, registry, storage, wires everything |
| Create | `src/core/bootstrap.test.ts` | Bootstrap tests |
| Modify | `src/main.ts` | Use bootstrap instead of manual config functions |
| Modify | `src/preload.ts` | No changes needed (API stays the same) |

---

### Task 1: Bootstrap Module

**Files:**
- Create: `src/core/bootstrap.test.ts`
- Create: `src/core/bootstrap.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/bootstrap.test.ts`:

```typescript
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

    // Read raw file — should NOT contain plaintext
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './bootstrap.js'`

- [ ] **Step 3: Implement bootstrap module**

Create `src/core/bootstrap.ts`:

```typescript
import * as path from 'path';
import { MessageBus } from './message-bus.js';
import { ServiceRegistry } from './service-registry.js';
import { JsonStorage } from './storage/json-storage.js';
import { SqliteStorage } from './storage/sqlite-storage.js';
import { EncryptedStorage } from './storage/encrypted-storage.js';
import { KeyManager } from './crypto/key-manager.js';
import type { StorageProvider } from './storage/storage.interface.js';

export interface AppContext {
  bus: MessageBus;
  registry: ServiceRegistry;
  config: StorageProvider;
  db: StorageProvider;
  shutdown: () => Promise<void>;
}

/**
 * Bootstrap the S.A.R.A.H. application.
 * Creates and wires up all core infrastructure.
 *
 * @param userDataPath — Electron's app.getPath('userData') or a test directory
 */
export async function bootstrap(userDataPath: string): Promise<AppContext> {
  // Key management
  const keyManager = new KeyManager(userDataPath);
  const encryptionKey = keyManager.getOrCreateKey();

  // Message bus
  const bus = new MessageBus();

  // Service registry
  const registry = new ServiceRegistry(bus);

  // Storage: config (JSON) and database (SQLite), both encrypted
  const rawConfig = new JsonStorage(path.join(userDataPath, 'config.json'));
  const rawDb = new SqliteStorage(path.join(userDataPath, 'sarah.db'));
  const config = new EncryptedStorage(rawConfig, encryptionKey);
  const db = new EncryptedStorage(rawDb, encryptionKey);

  // Initialize all registered services
  await registry.initAll();

  return {
    bus,
    registry,
    config,
    db,
    shutdown: async () => {
      await registry.destroyAll();
      await config.close();
      await db.close();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All 5 bootstrap tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/bootstrap.ts src/core/bootstrap.test.ts
git commit -m "feat(core): add bootstrap module for app initialization"
```

---

### Task 2: Update barrel export

**Files:**
- Modify: `src/core/index.ts`

- [ ] **Step 1: Add bootstrap export**

Read `src/core/index.ts`, then add at the end:

```typescript
// Bootstrap
export { bootstrap } from './bootstrap.js';
export type { AppContext } from './bootstrap.js';
```

- [ ] **Step 2: Verify compilation and tests**

Run: `npm test && npx tsc --noEmit`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/core/index.ts
git commit -m "feat(core): export bootstrap module from barrel"
```

---

### Task 3: Migrate main.ts to use core infrastructure

**Files:**
- Modify: `src/main.ts`

This is the key migration. Replace manual `loadConfig`/`saveConfig` with the bootstrap module. The IPC handlers stay the same from the renderer's perspective.

- [ ] **Step 1: Read current main.ts**

Read the full `src/main.ts` to understand current structure.

- [ ] **Step 2: Refactor main.ts**

Replace the manual config functions and integrate bootstrap. Key changes:

1. Remove `loadConfig()` and `saveConfig()` functions
2. Remove `getConfigPath()` function
3. Add `import { bootstrap, AppContext } from './core/bootstrap.js'`
4. Create an `appContext` variable at module level
5. In `app.whenReady()`, call `bootstrap(app.getPath('userData'))` to initialize
6. Update IPC handlers to use `appContext.config` instead of `loadConfig()`/`saveConfig()`

The updated IPC handlers should work like this:

```typescript
// Before:
ipcMain.handle('get-config', () => {
  return loadConfig();
});

// After:
ipcMain.handle('get-config', async () => {
  // Read all keys from config — we need to reconstruct the full object
  // For now, use a simple approach: store entire config under 'root' key
  return await appContext.config.get('root') ?? {};
});
```

For the config, use a single 'root' key approach since the renderer expects a flat config object:

```typescript
ipcMain.handle('save-config', async (_event, config: Record<string, unknown>) => {
  const existing = (await appContext.config.get<Record<string, unknown>>('root')) ?? {};
  const merged = { ...existing, ...config };
  await appContext.config.set('root', merged);
  return merged;
});

ipcMain.handle('is-first-run', async () => {
  const config = (await appContext.config.get<Record<string, unknown>>('root')) ?? {};
  return !(config as any).onboarding?.setupComplete;
});
```

Update the `splash-done` handler similarly:

```typescript
ipcMain.on('splash-done', async () => {
  if (mainWindow) {
    mainWindow.maximize();
    const config = (await appContext.config.get<Record<string, unknown>>('root')) ?? {};
    if ((config as any).onboarding?.setupComplete) {
      mainWindow.loadFile(path.join(__dirname, '..', 'dashboard.html'));
    } else {
      mainWindow.loadFile(path.join(__dirname, '..', 'wizard.html'));
    }
  }
});
```

Add shutdown on app quit:

```typescript
app.on('window-all-closed', async () => {
  if (appContext) {
    await appContext.shutdown();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Test manually**

Run: `npm start`
Expected: App launches, splash screen shows, wizard opens (or dashboard if already completed).

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "refactor: migrate main.ts to use core bootstrap and encrypted storage"
```

---

## Summary

After completing all tasks:

| Change | What it does |
|--------|-------------|
| `bootstrap.ts` | Single entry point for app initialization — creates bus, registry, encrypted storage |
| `main.ts` refactored | Uses bootstrap instead of manual file I/O, config is now encrypted at rest |
| Renderer unchanged | Same IPC API, wizard keeps working, no frontend changes needed |

The config file on disk is now encrypted. Old plaintext config files will need migration (handled gracefully by EncryptedStorage's fallback decryption).
