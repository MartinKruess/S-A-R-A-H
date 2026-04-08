# Phase 1A: Core Infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundational service infrastructure (Message-Bus, Service-Registry, Storage-Interface) that all future S.A.R.A.H. services depend on.

**Architecture:** Event-driven service-layer within Electron's main process. Services register with a central registry, communicate via a typed message-bus, and persist data through an abstracted storage layer. The main process (`src/core/`) is CommonJS (Electron main), tested with Vitest.

**Tech Stack:** TypeScript 6, Electron 41, Vitest (new), SQLite via `better-sqlite3` (new)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/core/types.ts` | Shared types: BusMessage, ServiceStatus |
| Create | `src/core/message-bus.ts` | Typed EventEmitter for inter-service communication |
| Create | `src/core/message-bus.test.ts` | Message-bus tests |
| Create | `src/core/service.interface.ts` | SarahService interface contract |
| Create | `src/core/service-registry.ts` | Registers, initializes, destroys services |
| Create | `src/core/service-registry.test.ts` | Service-registry tests |
| Create | `src/core/storage/storage.interface.ts` | StorageProvider interface |
| Create | `src/core/storage/json-storage.ts` | JSON file-based storage for config |
| Create | `src/core/storage/json-storage.test.ts` | JSON storage tests |
| Create | `src/core/storage/sqlite-storage.ts` | SQLite storage for rules/memory |
| Create | `src/core/storage/sqlite-storage.test.ts` | SQLite storage tests |
| Create | `src/core/index.ts` | Public API barrel export |
| Modify | `package.json` | Add vitest, better-sqlite3 |
| Create | `vitest.config.ts` | Vitest configuration |

---

### Task 1: Set Up Test Framework

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install vitest**

```bash
npm install --save-dev vitest
```

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Add test script to package.json**

In `package.json`, add to `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Verify setup with a smoke test**

Create `src/core/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('test setup', () => {
  it('works', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `npm test`
Expected: 1 test passes.

- [ ] **Step 5: Delete smoke test and commit**

Delete `src/core/smoke.test.ts`.

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest test framework"
```

---

### Task 2: Core Types

**Files:**
- Create: `src/core/types.ts`

- [ ] **Step 1: Create shared types**

Create `src/core/types.ts`:

```typescript
/** A message sent through the message bus between services. */
export interface BusMessage {
  /** Source service ID, e.g. 'voice', 'actions'. Set by the bus. */
  source: string;
  /** Event topic, e.g. 'voice:transcript', 'actions:executed'. */
  topic: string;
  /** Arbitrary payload. */
  data: Record<string, unknown>;
  /** ISO timestamp, set by the bus. */
  timestamp: string;
}

/** Lifecycle status of a service. */
export type ServiceStatus = 'pending' | 'running' | 'stopped' | 'error';
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat(core): add shared BusMessage and ServiceStatus types"
```

---

### Task 3: Message Bus

**Files:**
- Create: `src/core/message-bus.test.ts`
- Create: `src/core/message-bus.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/message-bus.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from './message-bus.js';
import type { BusMessage } from './types.js';

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  it('delivers a message to a subscriber', () => {
    const handler = vi.fn();
    bus.on('test:hello', handler);

    bus.emit('test-service', 'test:hello', { greeting: 'hi' });

    expect(handler).toHaveBeenCalledOnce();
    const msg: BusMessage = handler.mock.calls[0][0];
    expect(msg.source).toBe('test-service');
    expect(msg.topic).toBe('test:hello');
    expect(msg.data).toEqual({ greeting: 'hi' });
    expect(msg.timestamp).toBeTruthy();
  });

  it('delivers to multiple subscribers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('test:multi', h1);
    bus.on('test:multi', h2);

    bus.emit('svc', 'test:multi', {});

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('does not deliver after unsubscribe', () => {
    const handler = vi.fn();
    const unsub = bus.on('test:unsub', handler);

    unsub();
    bus.emit('svc', 'test:unsub', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports wildcard * to receive all messages', () => {
    const handler = vi.fn();
    bus.on('*', handler);

    bus.emit('a', 'topic:one', {});
    bus.emit('b', 'topic:two', {});

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].topic).toBe('topic:one');
    expect(handler.mock.calls[1][0].topic).toBe('topic:two');
  });

  it('does not crash when emitting with no subscribers', () => {
    expect(() => bus.emit('svc', 'nobody:listens', {})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './message-bus.js'`

- [ ] **Step 3: Implement MessageBus**

Create `src/core/message-bus.ts`:

```typescript
import type { BusMessage } from './types.js';

export type MessageHandler = (msg: BusMessage) => void;

export class MessageBus {
  private listeners = new Map<string, Set<MessageHandler>>();

  /**
   * Subscribe to a topic. Use '*' to receive all messages.
   * Returns an unsubscribe function.
   */
  on(topic: string, handler: MessageHandler): () => void {
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, new Set());
    }
    this.listeners.get(topic)!.add(handler);

    return () => {
      this.listeners.get(topic)?.delete(handler);
    };
  }

  /** Emit a message to all subscribers of the topic and wildcard listeners. */
  emit(source: string, topic: string, data: Record<string, unknown>): void {
    const msg: BusMessage = {
      source,
      topic,
      data,
      timestamp: new Date().toISOString(),
    };

    this.listeners.get(topic)?.forEach((h) => h(msg));

    if (topic !== '*') {
      this.listeners.get('*')?.forEach((h) => h(msg));
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All 5 tests pass.

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/message-bus.ts src/core/message-bus.test.ts
git commit -m "feat(core): add MessageBus with topic subscriptions and wildcard support"
```

---

### Task 4: Service Interface

**Files:**
- Create: `src/core/service.interface.ts`

- [ ] **Step 1: Create service interface**

Create `src/core/service.interface.ts`:

```typescript
import type { BusMessage, ServiceStatus } from './types.js';

/**
 * Every S.A.R.A.H. service implements this interface.
 * Services are registered with the ServiceRegistry and communicate via the MessageBus.
 */
export interface SarahService {
  /** Unique service ID, e.g. 'llm', 'voice', 'actions'. */
  readonly id: string;

  /** Current lifecycle status. */
  readonly status: ServiceStatus;

  /** Initialize the service. Called once by the registry at startup. */
  init(): Promise<void>;

  /** Shut down the service. Called once by the registry at shutdown. */
  destroy(): Promise<void>;

  /** Handle an incoming bus message. Called by the registry for subscribed topics. */
  onMessage(msg: BusMessage): void;

  /** Topics this service subscribes to. The registry wires these up automatically. */
  readonly subscriptions: string[];
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/service.interface.ts
git commit -m "feat(core): add SarahService interface contract"
```

---

### Task 5: Service Registry

**Files:**
- Create: `src/core/service-registry.test.ts`
- Create: `src/core/service-registry.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/service-registry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceRegistry } from './service-registry.js';
import { MessageBus } from './message-bus.js';
import type { SarahService } from './service.interface.js';
import type { BusMessage, ServiceStatus } from './types.js';

function createMockService(id: string, subs: string[] = []): SarahService {
  return {
    id,
    status: 'pending' as ServiceStatus,
    subscriptions: subs,
    init: vi.fn(async function (this: any) { this.status = 'running'; }),
    destroy: vi.fn(async function (this: any) { this.status = 'stopped'; }),
    onMessage: vi.fn(),
  };
}

describe('ServiceRegistry', () => {
  let bus: MessageBus;
  let registry: ServiceRegistry;

  beforeEach(() => {
    bus = new MessageBus();
    registry = new ServiceRegistry(bus);
  });

  it('registers and initializes a service', async () => {
    const svc = createMockService('test');
    registry.register(svc);

    await registry.initAll();

    expect(svc.init).toHaveBeenCalledOnce();
  });

  it('wires up subscriptions on init', async () => {
    const svc = createMockService('listener', ['voice:transcript']);
    registry.register(svc);
    await registry.initAll();

    bus.emit('voice', 'voice:transcript', { text: 'hello' });

    expect(svc.onMessage).toHaveBeenCalledOnce();
    expect(svc.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'voice:transcript' }),
    );
  });

  it('destroys all services in reverse order', async () => {
    const order: string[] = [];
    const svc1 = createMockService('first');
    svc1.destroy = vi.fn(async () => { order.push('first'); });
    const svc2 = createMockService('second');
    svc2.destroy = vi.fn(async () => { order.push('second'); });

    registry.register(svc1);
    registry.register(svc2);
    await registry.initAll();
    await registry.destroyAll();

    expect(order).toEqual(['second', 'first']);
  });

  it('throws on duplicate service ID', () => {
    registry.register(createMockService('dup'));
    expect(() => registry.register(createMockService('dup'))).toThrow('already registered');
  });

  it('returns a service by ID', () => {
    const svc = createMockService('finder');
    registry.register(svc);

    expect(registry.get('finder')).toBe(svc);
    expect(registry.get('nonexistent')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './service-registry.js'`

- [ ] **Step 3: Implement ServiceRegistry**

Create `src/core/service-registry.ts`:

```typescript
import type { MessageBus } from './message-bus.js';
import type { SarahService } from './service.interface.js';

export class ServiceRegistry {
  private services: SarahService[] = [];
  private serviceMap = new Map<string, SarahService>();
  private unsubscribers: (() => void)[] = [];

  constructor(private bus: MessageBus) {}

  /** Register a service. Must be called before initAll(). */
  register(service: SarahService): void {
    if (this.serviceMap.has(service.id)) {
      throw new Error(`Service "${service.id}" already registered`);
    }
    this.services.push(service);
    this.serviceMap.set(service.id, service);
  }

  /** Get a registered service by ID. */
  get(id: string): SarahService | undefined {
    return this.serviceMap.get(id);
  }

  /** Initialize all registered services and wire up their subscriptions. */
  async initAll(): Promise<void> {
    for (const service of this.services) {
      for (const topic of service.subscriptions) {
        const unsub = this.bus.on(topic, (msg) => service.onMessage(msg));
        this.unsubscribers.push(unsub);
      }
      await service.init();
    }
  }

  /** Destroy all services in reverse registration order. */
  async destroyAll(): Promise<void> {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    for (const service of [...this.services].reverse()) {
      await service.destroy();
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All 5 tests pass.

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/service-registry.ts src/core/service-registry.test.ts
git commit -m "feat(core): add ServiceRegistry with auto-wiring and lifecycle management"
```

---

### Task 6: Storage Interface

**Files:**
- Create: `src/core/storage/storage.interface.ts`

- [ ] **Step 1: Create storage interface**

Create `src/core/storage/storage.interface.ts`:

```typescript
/** Filter condition for queries. */
export interface Filter {
  [column: string]: unknown;
}

/**
 * Abstract storage provider.
 * Currently backed by JSON files (config) and SQLite (rules/memory).
 * Later replaceable with PostgreSQL or cloud-sync provider.
 */
export interface StorageProvider {
  /** Get a value by key (config-style). */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /** Set a value by key (config-style). */
  set(key: string, value: unknown): Promise<void>;

  /** Query rows from a table with optional filter. */
  query<T = Record<string, unknown>>(table: string, filter?: Filter): Promise<T[]>;

  /** Insert a row into a table. Returns the inserted row's ID. */
  insert(table: string, data: Record<string, unknown>): Promise<number>;

  /** Update rows matching filter. Returns number of affected rows. */
  update(table: string, filter: Filter, data: Record<string, unknown>): Promise<number>;

  /** Delete rows matching filter. Returns number of deleted rows. */
  delete(table: string, filter: Filter): Promise<number>;

  /** Close connections and clean up. */
  close(): Promise<void>;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/storage/storage.interface.ts
git commit -m "feat(core): add StorageProvider interface"
```

---

### Task 7: JSON Storage Provider

**Files:**
- Create: `src/core/storage/json-storage.test.ts`
- Create: `src/core/storage/json-storage.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/storage/json-storage.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './json-storage.js'`

- [ ] **Step 3: Implement JsonStorage**

Create `src/core/storage/json-storage.ts`:

```typescript
import * as fs from 'fs';
import type { StorageProvider, Filter } from './storage.interface.js';

/**
 * JSON file-based storage for config/settings.
 * Supports key-value get/set with dot-notation for nested access.
 * Table operations (query/insert/update/delete) are not supported — use SqliteStorage for those.
 */
export class JsonStorage implements StorageProvider {
  private data: Record<string, unknown> = {};

  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.data = JSON.parse(raw);
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    const dir = this.filePath.replace(/[/\\][^/\\]+$/, '');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const parts = key.split('.');
    let current: unknown = this.data;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    const parts = key.split('.');

    if (parts.length === 1) {
      this.data[key] = value;
    } else {
      let current: Record<string, unknown> = this.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
          current[parts[i]] = {};
        }
        current = current[parts[i]] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
    }

    this.save();
  }

  async query<T>(_table: string, _filter?: Filter): Promise<T[]> {
    throw new Error('JsonStorage does not support table queries. Use SqliteStorage.');
  }

  async insert(_table: string, _data: Record<string, unknown>): Promise<number> {
    throw new Error('JsonStorage does not support table operations. Use SqliteStorage.');
  }

  async update(_table: string, _filter: Filter, _data: Record<string, unknown>): Promise<number> {
    throw new Error('JsonStorage does not support table operations. Use SqliteStorage.');
  }

  async delete(_table: string, _filter: Filter): Promise<number> {
    throw new Error('JsonStorage does not support table operations. Use SqliteStorage.');
  }

  async close(): Promise<void> {
    // No-op for JSON storage.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All 7 tests pass.

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/storage/json-storage.ts src/core/storage/json-storage.test.ts
git commit -m "feat(core): add JsonStorage provider for config persistence"
```

---

### Task 8: SQLite Storage Provider

**Files:**
- Modify: `package.json` (add better-sqlite3)
- Create: `src/core/storage/sqlite-storage.test.ts`
- Create: `src/core/storage/sqlite-storage.ts`

- [ ] **Step 1: Install better-sqlite3**

```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

- [ ] **Step 2: Write failing tests**

Create `src/core/storage/sqlite-storage.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStorage } from './sqlite-storage.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SqliteStorage', () => {
  let storage: SqliteStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-sqlite-'));
    const dbPath = path.join(tmpDir, 'sarah.db');
    storage = new SqliteStorage(dbPath);
  });

  afterEach(async () => {
    await storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('table operations', () => {
    it('inserts and queries a row', async () => {
      const id = await storage.insert('persistent_rules', {
        category: 'naming',
        rule: 'Bilder: img-situation-person-datum',
      });

      expect(id).toBe(1);

      const rows = await storage.query<{ id: number; category: string; rule: string }>(
        'persistent_rules',
        { category: 'naming' },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].rule).toBe('Bilder: img-situation-person-datum');
    });

    it('queries all rows without filter', async () => {
      await storage.insert('persistent_rules', { category: 'a', rule: 'rule 1' });
      await storage.insert('persistent_rules', { category: 'b', rule: 'rule 2' });

      const rows = await storage.query('persistent_rules');
      expect(rows).toHaveLength(2);
    });

    it('updates rows matching filter', async () => {
      await storage.insert('persistent_rules', { category: 'naming', rule: 'old' });
      const updated = await storage.update(
        'persistent_rules',
        { category: 'naming' },
        { rule: 'new' },
      );

      expect(updated).toBe(1);
      const rows = await storage.query<{ rule: string }>('persistent_rules', { category: 'naming' });
      expect(rows[0].rule).toBe('new');
    });

    it('deletes rows matching filter', async () => {
      await storage.insert('persistent_rules', { category: 'temp', rule: 'delete me' });
      const deleted = await storage.delete('persistent_rules', { category: 'temp' });

      expect(deleted).toBe(1);
      const rows = await storage.query('persistent_rules', { category: 'temp' });
      expect(rows).toHaveLength(0);
    });
  });

  describe('key-value operations', () => {
    it('sets and gets a value', async () => {
      await storage.set('test_key', { hello: 'world' });
      expect(await storage.get('test_key')).toEqual({ hello: 'world' });
    });

    it('returns undefined for missing key', async () => {
      expect(await storage.get('missing')).toBeUndefined();
    });

    it('overwrites existing key', async () => {
      await storage.set('key', 'a');
      await storage.set('key', 'b');
      expect(await storage.get('key')).toBe('b');
    });
  });

  describe('schema initialization', () => {
    it('creates expected tables', async () => {
      // Insert into each expected table to verify they exist
      await storage.insert('absolute_rules', { rule: 'test' });
      await storage.insert('persistent_rules', { category: 'test', rule: 'test' });
      await storage.insert('session_rules', { rule: 'test', session_id: 'abc' });
      await storage.insert('conversations', { mode: 'ambient', summary: 'test' });
      await storage.insert('messages', { conversation_id: 1, role: 'user', content: 'hi' });
      await storage.insert('learned_facts', { category: 'test', fact: 'test', confidence: 0.9, source: 'user' });

      // All should have 1 row each
      expect(await storage.query('absolute_rules')).toHaveLength(1);
      expect(await storage.query('persistent_rules')).toHaveLength(1);
      expect(await storage.query('session_rules')).toHaveLength(1);
      expect(await storage.query('conversations')).toHaveLength(1);
      expect(await storage.query('messages')).toHaveLength(1);
      expect(await storage.query('learned_facts')).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './sqlite-storage.js'`

- [ ] **Step 4: Implement SqliteStorage**

Create `src/core/storage/sqlite-storage.ts`:

```typescript
import Database from 'better-sqlite3';
import type { StorageProvider, Filter } from './storage.interface.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS absolute_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS persistent_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL DEFAULT '',
    rule       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS session_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule       TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at   TEXT,
    mode       TEXT NOT NULL DEFAULT 'ambient',
    summary    TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    timestamp       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS learned_facts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL DEFAULT '',
    fact       TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    source     TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

export class SqliteStorage implements StorageProvider {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value) as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.db
      .prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, JSON.stringify(value), JSON.stringify(value));
  }

  async query<T = Record<string, unknown>>(table: string, filter?: Filter): Promise<T[]> {
    this.assertTableName(table);

    if (!filter || Object.keys(filter).length === 0) {
      return this.db.prepare(`SELECT * FROM ${table}`).all() as T[];
    }

    const keys = Object.keys(filter);
    const where = keys.map((k) => `${this.assertColumnName(k)} = ?`).join(' AND ');
    const values = keys.map((k) => filter[k]);

    return this.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...values) as T[];
  }

  async insert(table: string, data: Record<string, unknown>): Promise<number> {
    this.assertTableName(table);
    const keys = Object.keys(data);
    const cols = keys.map((k) => this.assertColumnName(k)).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map((k) => data[k]);

    const result = this.db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`).run(...values);
    return result.lastInsertRowid as number;
  }

  async update(table: string, filter: Filter, data: Record<string, unknown>): Promise<number> {
    this.assertTableName(table);
    const setCols = Object.keys(data);
    const setClause = setCols.map((k) => `${this.assertColumnName(k)} = ?`).join(', ');
    const setValues = setCols.map((k) => data[k]);

    const filterKeys = Object.keys(filter);
    const whereClause = filterKeys.map((k) => `${this.assertColumnName(k)} = ?`).join(' AND ');
    const filterValues = filterKeys.map((k) => filter[k]);

    const result = this.db
      .prepare(`UPDATE ${table} SET ${setClause} WHERE ${whereClause}`)
      .run(...setValues, ...filterValues);
    return result.changes;
  }

  async delete(table: string, filter: Filter): Promise<number> {
    this.assertTableName(table);
    const keys = Object.keys(filter);
    const where = keys.map((k) => `${this.assertColumnName(k)} = ?`).join(' AND ');
    const values = keys.map((k) => filter[k]);

    const result = this.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...values);
    return result.changes;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /** Prevent SQL injection by validating table/column names are alphanumeric + underscore. */
  private assertTableName(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid table name: ${name}`);
    }
    return name;
  }

  private assertColumnName(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid column name: ${name}`);
    }
    return name;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All 9 tests pass.

- [ ] **Step 6: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/storage/sqlite-storage.ts src/core/storage/sqlite-storage.test.ts package.json package-lock.json
git commit -m "feat(core): add SqliteStorage provider with schema for rules, memory, conversations"
```

---

### Task 9: Barrel Export & Integration Verification

**Files:**
- Create: `src/core/index.ts`

- [ ] **Step 1: Create barrel export**

Create `src/core/index.ts`:

```typescript
// Types
export type { BusMessage, ServiceStatus } from './types.js';

// Message Bus
export { MessageBus } from './message-bus.js';
export type { MessageHandler } from './message-bus.js';

// Service
export type { SarahService } from './service.interface.js';
export { ServiceRegistry } from './service-registry.js';

// Storage
export type { StorageProvider, Filter } from './storage/storage.interface.js';
export { JsonStorage } from './storage/json-storage.js';
export { SqliteStorage } from './storage/sqlite-storage.js';
```

- [ ] **Step 2: Verify full compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass (message-bus: 5, service-registry: 5, json-storage: 7, sqlite-storage: 9 = 26 total).

- [ ] **Step 4: Commit**

```bash
git add src/core/index.ts
git commit -m "feat(core): add barrel export for core infrastructure"
```

---

## Summary

After completing all tasks, the `src/core/` directory provides:

| Module | What it does |
|--------|-------------|
| `MessageBus` | Typed pub/sub for inter-service communication, with wildcard support |
| `ServiceRegistry` | Lifecycle management, auto-wiring subscriptions, ordered shutdown |
| `SarahService` | Interface contract every service implements |
| `JsonStorage` | File-based config persistence with dot-notation access |
| `SqliteStorage` | Structured storage for rules, memory, conversations with SQL injection protection |
| `StorageProvider` | Abstract interface for swapping storage backends later |

**Next:** Plan 1B — Migrate existing wizard into new structure, expand design system, build settings view.
