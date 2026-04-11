# TypeScript Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all `Record<string, unknown>` and `as`-casts by introducing typed Bus Events, Zod Config Schema, and a shared IPC Contract.

**Architecture:** Three new type-definition files (`bus-events.ts`, `config-schema.ts`, `ipc-contract.ts` + `sarah-api.ts`) provide the single source of truth. Existing files import from these instead of declaring types inline. The MessageBus becomes generic, config is validated at startup with Zod, and all 4 renderer `declare const sarah` blocks are replaced by a shared `SarahApi` interface.

**Tech Stack:** TypeScript 6, Zod (new dependency), Vitest

---

### Task 1: Install Zod

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install zod**

```bash
cd G:/projects/S-A-R-A-H && npm install zod
```

- [ ] **Step 2: Verify installation**

```bash
cd G:/projects/S-A-R-A-H && node -e "require('zod')"
```

Expected: No error

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add zod dependency for config validation"
```

---

### Task 2: Create Typed Bus Events

**Files:**
- Create: `src/core/bus-events.ts`
- Test: `src/core/bus-events.test.ts`

- [ ] **Step 1: Write the type-checking test**

Create `src/core/bus-events.test.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { BusEvents } from './bus-events.js';

describe('BusEvents type map', () => {
  it('maps chat:message to { text: string }', () => {
    expectTypeOf<BusEvents['chat:message']>().toEqualTypeOf<{ text: string }>();
  });

  it('maps llm:done to { fullText: string }', () => {
    expectTypeOf<BusEvents['llm:done']>().toEqualTypeOf<{ fullText: string }>();
  });

  it('maps voice:play-audio to { audio: number[]; sampleRate: number }', () => {
    expectTypeOf<BusEvents['voice:play-audio']>().toEqualTypeOf<{ audio: number[]; sampleRate: number }>();
  });

  it('maps voice:done to empty payload', () => {
    expectTypeOf<BusEvents['voice:done']>().toEqualTypeOf<Record<string, never>>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd G:/projects/S-A-R-A-H && npx vitest run src/core/bus-events.test.ts
```

Expected: FAIL — `bus-events.js` does not exist

- [ ] **Step 3: Create bus-events.ts**

Create `src/core/bus-events.ts`:

```typescript
import type { VoiceState } from '../services/voice/voice-types.js';

/**
 * Central event map — every bus topic has exactly one payload type.
 * Adding a new event? Add it here and TypeScript enforces the payload everywhere.
 */
export type BusEvents = {
  'chat:message':        { text: string };
  'llm:chunk':           { text: string };
  'llm:done':            { fullText: string };
  'llm:error':           { message: string };
  'voice:state':         { state: VoiceState };
  'voice:listening':     Record<string, never>;
  'voice:transcript':    { text: string };
  'voice:speaking':      { text: string };
  'voice:play-audio':    { audio: number[]; sampleRate: number };
  'voice:done':          Record<string, never>;
  'voice:error':         { message: string };
  'voice:interrupted':   Record<string, never>;
  'voice:wake':          Record<string, never>;
  'voice:playback-done': Record<string, never>;
};

/** All valid bus topic strings */
export type BusTopic = keyof BusEvents;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd G:/projects/S-A-R-A-H && npx vitest run src/core/bus-events.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/bus-events.ts src/core/bus-events.test.ts
git commit -m "feat: add typed bus event map"
```

---

### Task 3: Make MessageBus Generic

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/message-bus.ts`
- Modify: `src/core/message-bus.test.ts`

- [ ] **Step 1: Update types.ts**

Replace the entire content of `src/core/types.ts` with:

```typescript
import type { BusEvents, BusTopic } from './bus-events.js';

/** A typed message sent through the message bus between services. */
export interface TypedBusMessage<T extends BusTopic = BusTopic> {
  /** Source service ID, e.g. 'voice', 'actions'. Set by the bus. */
  source: string;
  /** Event topic — constrained to known BusEvents keys. */
  topic: T;
  /** Typed payload matching the topic. */
  data: BusEvents[T];
  /** ISO timestamp, set by the bus. */
  timestamp: string;
}

/** Lifecycle status of a service. */
export type ServiceStatus = 'pending' | 'running' | 'stopped' | 'error';
```

- [ ] **Step 2: Update message-bus.ts**

Replace the entire content of `src/core/message-bus.ts` with:

```typescript
import type { BusEvents, BusTopic } from './bus-events.js';
import type { TypedBusMessage } from './types.js';

export type MessageHandler<T extends BusTopic = BusTopic> = (msg: TypedBusMessage<T>) => void;

export class MessageBus {
  private listeners = new Map<string, Set<MessageHandler<BusTopic>>>();

  /**
   * Subscribe to a topic. Use '*' to receive all messages.
   * Returns an unsubscribe function.
   */
  on<T extends BusTopic>(topic: T | '*', handler: MessageHandler<T>): () => void {
    const key = topic as string;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(handler as MessageHandler<BusTopic>);

    return () => {
      this.listeners.get(key)?.delete(handler as MessageHandler<BusTopic>);
    };
  }

  /** Emit a message to all subscribers of the topic and wildcard listeners. */
  emit<T extends BusTopic>(source: string, topic: T, data: BusEvents[T]): void {
    const msg: TypedBusMessage<T> = {
      source,
      topic,
      data,
      timestamp: new Date().toISOString(),
    };

    const topicListeners = this.listeners.get(topic as string);
    topicListeners?.forEach((h) => (h as MessageHandler<T>)(msg));

    if (topic !== '*') {
      const wildcardListeners = this.listeners.get('*');
      wildcardListeners?.forEach((h) => (h as MessageHandler<T>)(msg));
    }
  }
}
```

- [ ] **Step 3: Update message-bus.test.ts**

Replace the entire content of `src/core/message-bus.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from './message-bus.js';
import type { TypedBusMessage } from './types.js';

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  it('delivers a typed message to a subscriber', () => {
    const handler = vi.fn();
    bus.on('chat:message', handler);

    bus.emit('test-service', 'chat:message', { text: 'hi' });

    expect(handler).toHaveBeenCalledOnce();
    const msg: TypedBusMessage<'chat:message'> = handler.mock.calls[0][0];
    expect(msg.source).toBe('test-service');
    expect(msg.topic).toBe('chat:message');
    expect(msg.data).toEqual({ text: 'hi' });
    expect(msg.timestamp).toBeTruthy();
  });

  it('delivers to multiple subscribers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('llm:chunk', h1);
    bus.on('llm:chunk', h2);

    bus.emit('llm', 'llm:chunk', { text: 'hello' });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('does not deliver after unsubscribe', () => {
    const handler = vi.fn();
    const unsub = bus.on('llm:done', handler);

    unsub();
    bus.emit('llm', 'llm:done', { fullText: 'done' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports wildcard * to receive all messages', () => {
    const handler = vi.fn();
    bus.on('*', handler);

    bus.emit('a', 'chat:message', { text: 'one' });
    bus.emit('b', 'llm:done', { fullText: 'two' });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].topic).toBe('chat:message');
    expect(handler.mock.calls[1][0].topic).toBe('llm:done');
  });

  it('does not crash when emitting with no subscribers', () => {
    expect(() => bus.emit('svc', 'voice:wake', {})).not.toThrow();
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd G:/projects/S-A-R-A-H && npx vitest run src/core/message-bus.test.ts
```

Expected: PASS — all 5 tests green

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/message-bus.ts src/core/message-bus.test.ts
git commit -m "refactor: make MessageBus generic with typed events"
```

---

### Task 4: Update SarahService Interface and ServiceRegistry

**Files:**
- Modify: `src/core/service.interface.ts`
- Modify: `src/core/service-registry.ts`
- Modify: `src/core/service-registry.test.ts`

- [ ] **Step 1: Update service.interface.ts**

Replace the entire content of `src/core/service.interface.ts` with:

```typescript
import type { BusTopic } from './bus-events.js';
import type { TypedBusMessage, ServiceStatus } from './types.js';

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
  onMessage(msg: TypedBusMessage): void;

  /** Topics this service subscribes to. The registry wires these up automatically. */
  readonly subscriptions: readonly BusTopic[];
}
```

- [ ] **Step 2: Update service-registry.ts**

Replace the entire content of `src/core/service-registry.ts` with:

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

- [ ] **Step 3: Update service-registry.test.ts**

Replace the entire content of `src/core/service-registry.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceRegistry } from './service-registry.js';
import { MessageBus } from './message-bus.js';
import type { SarahService } from './service.interface.js';
import type { BusTopic } from './bus-events.js';
import type { TypedBusMessage, ServiceStatus } from './types.js';

function createMockService(id: string, subs: BusTopic[] = []): SarahService {
  return {
    id,
    status: 'pending' as ServiceStatus,
    subscriptions: subs,
    init: vi.fn(async function (this: { status: ServiceStatus }) { this.status = 'running'; }),
    destroy: vi.fn(async function (this: { status: ServiceStatus }) { this.status = 'stopped'; }),
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

- [ ] **Step 4: Run all core tests**

```bash
cd G:/projects/S-A-R-A-H && npx vitest run src/core/
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/service.interface.ts src/core/service-registry.ts src/core/service-registry.test.ts
git commit -m "refactor: type SarahService subscriptions with BusTopic"
```

---

### Task 5: Create Zod Config Schema

**Files:**
- Create: `src/core/config-schema.ts`
- Test: `src/core/config-schema.test.ts`

- [ ] **Step 1: Write config validation tests**

Create `src/core/config-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SarahConfigSchema } from './config-schema.js';

describe('SarahConfigSchema', () => {
  it('parses an empty object with all defaults', () => {
    const result = SarahConfigSchema.parse({});

    expect(result.onboarding.setupComplete).toBe(false);
    expect(result.profile.displayName).toBe('');
    expect(result.profile.responseStyle).toBe('mittel');
    expect(result.controls.voiceMode).toBe('off');
    expect(result.controls.pushToTalkKey).toBe('F9');
    expect(result.personalization.accentColor).toBe('#00d4ff');
    expect(result.llm.baseUrl).toBe('http://localhost:11434');
    expect(result.trust.fileAccess).toBe('specific-folders');
  });

  it('preserves provided values', () => {
    const result = SarahConfigSchema.parse({
      profile: { displayName: 'Martin', city: 'Berlin' },
      controls: { voiceMode: 'push-to-talk' },
    });

    expect(result.profile.displayName).toBe('Martin');
    expect(result.profile.city).toBe('Berlin');
    expect(result.controls.voiceMode).toBe('push-to-talk');
    // Defaults for unset fields
    expect(result.profile.responseStyle).toBe('mittel');
  });

  it('migrates legacy fileAccess "full" to "all"', () => {
    const result = SarahConfigSchema.parse({
      trust: { fileAccess: 'full' },
    });

    expect(result.trust.fileAccess).toBe('all');
  });

  it('returns error for invalid enum values via safeParse', () => {
    const result = SarahConfigSchema.safeParse({
      controls: { voiceMode: 'invalid-mode' },
    });

    expect(result.success).toBe(false);
  });

  it('handles a full realistic config', () => {
    const full = {
      onboarding: { setupComplete: true },
      profile: {
        displayName: 'Martin',
        city: 'Berlin',
        usagePurposes: ['Programmieren', 'Design'],
        hobbies: ['Gaming'],
        responseStyle: 'mittel',
        tone: 'locker',
      },
      skills: {
        programming: 'Fortgeschritten',
        programmingStack: ['TypeScript', 'React'],
      },
      resources: {
        programs: [{
          name: 'VS Code',
          path: 'C:\\Program Files\\VS Code\\code.exe',
          type: 'exe',
          source: 'detected',
          verified: true,
          aliases: ['Code', 'VSCode'],
        }],
      },
      trust: { confirmationLevel: 'standard', memoryAllowed: true },
      personalization: { quirk: 'nerd', characterTraits: ['Humorvoll'] },
      controls: { voiceMode: 'push-to-talk', pushToTalkKey: 'F10' },
      llm: { model: 'qwen3.5:4b' },
    };

    const result = SarahConfigSchema.parse(full);
    expect(result.profile.displayName).toBe('Martin');
    expect(result.resources.programs[0].name).toBe('VS Code');
    expect(result.controls.pushToTalkKey).toBe('F10');
    expect(result.llm.model).toBe('qwen3.5:4b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd G:/projects/S-A-R-A-H && npx vitest run src/core/config-schema.test.ts
```

Expected: FAIL — `config-schema.js` does not exist

- [ ] **Step 3: Create config-schema.ts**

Create `src/core/config-schema.ts`:

```typescript
import { z } from 'zod';

// ── Sub-Schemas (individually exported for wizard/settings reuse) ──

export const ProfileSchema = z.object({
  displayName: z.string().default(''),
  lastName: z.string().default(''),
  city: z.string().default(''),
  address: z.string().default(''),
  profession: z.string().default(''),
  activities: z.string().default(''),
  usagePurposes: z.array(z.string()).default([]),
  hobbies: z.array(z.string()).default([]),
  responseStyle: z.enum(['kurz', 'mittel', 'ausführlich']).default('mittel'),
  tone: z.enum(['freundlich', 'professionell', 'locker', 'direkt']).default('freundlich'),
});

export const SkillsSchema = z.object({
  programming: z.string().nullable().default(null),
  programmingStack: z.array(z.string()).default([]),
  programmingResources: z.array(z.string()).default([]),
  programmingProjectsFolder: z.string().default(''),
  design: z.string().nullable().default(null),
  office: z.string().nullable().default(null),
});

export const ProgramEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['exe', 'launcher', 'appx', 'updater']),
  source: z.enum(['detected', 'manual', 'learned']),
  verified: z.boolean(),
  aliases: z.array(z.string()),
  duplicateGroup: z.string().optional(),
});

export const PdfCategorySchema = z.object({
  tag: z.string(),
  folder: z.string(),
  pattern: z.string(),
  inferFromExisting: z.boolean(),
});

export const CustomCommandSchema = z.object({
  command: z.string(),
  prompt: z.string(),
});

export const ResourcesSchema = z.object({
  emails: z.array(z.string()).default([]),
  programs: z.array(ProgramEntrySchema).default([]),
  favoriteLinks: z.array(z.string()).default([]),
  pdfCategories: z.array(PdfCategorySchema).default([]),
  picturesFolder: z.string().default(''),
  installFolder: z.string().default(''),
  gamesFolder: z.string().default(''),
  extraProgramsFolder: z.string().default(''),
  importantFolders: z.array(z.string()).default([]),
});

export const TrustSchema = z.object({
  memoryAllowed: z.boolean().default(true),
  fileAccess: z.preprocess(
    (val) => val === 'full' ? 'all' : val,
    z.enum(['specific-folders', 'all', 'none']).default('specific-folders'),
  ),
  confirmationLevel: z.enum(['minimal', 'standard', 'maximal']).default('standard'),
  memoryExclusions: z.array(z.string()).default([]),
  anonymousEnabled: z.boolean().default(false),
  showContextEnabled: z.boolean().default(false),
});

export const PersonalizationSchema = z.object({
  accentColor: z.string().default('#00d4ff'),
  voice: z.string().default('default-female-de'),
  speechRate: z.number().default(1),
  chatFontSize: z.enum(['small', 'default', 'large']).default('default'),
  chatAlignment: z.enum(['stacked', 'bubbles']).default('stacked'),
  emojisEnabled: z.boolean().default(true),
  responseMode: z.enum(['normal', 'spontaneous', 'thoughtful']).default('normal'),
  characterTraits: z.array(z.string()).default([]),
  quirk: z.string().nullable().default(null),
});

export const ControlsSchema = z.object({
  voiceMode: z.enum(['keyword', 'push-to-talk', 'off']).default('off'),
  pushToTalkKey: z.string().default('F9'),
  quietModeDuration: z.number().default(30),
  customCommands: z.array(CustomCommandSchema).default([]),
});

export const LlmSchema = z.object({
  baseUrl: z.string().default('http://localhost:11434'),
  model: z.string().default('qwen3.5:4b'),
  options: z.object({
    temperature: z.number().optional(),
    num_predict: z.number().optional(),
    num_ctx: z.number().optional(),
  }).default({}),
});

export const SystemSchema = z.object({
  os: z.string().default(''),
  platform: z.string().default(''),
  arch: z.string().default(''),
  cpu: z.string().default(''),
  cpuCores: z.string().default(''),
  totalMemory: z.string().default(''),
  freeMemory: z.string().default(''),
  hostname: z.string().default(''),
  shell: z.string().default(''),
  language: z.string().default(''),
  timezone: z.string().default(''),
  folders: z.object({
    documents: z.string().default(''),
    downloads: z.string().default(''),
    pictures: z.string().default(''),
    desktop: z.string().default(''),
  }).default({}),
});

// ── Root Schema ──

export const SarahConfigSchema = z.object({
  onboarding: z.object({ setupComplete: z.boolean() }).default({ setupComplete: false }),
  system: SystemSchema.default({}),
  profile: ProfileSchema.default({}),
  skills: SkillsSchema.default({}),
  resources: ResourcesSchema.default({}),
  trust: TrustSchema.default({}),
  personalization: PersonalizationSchema.default({}),
  controls: ControlsSchema.default({}),
  llm: LlmSchema.default({}),
  integrations: z.object({
    context7: z.boolean().default(false),
  }).default({}),
});

// ── Inferred Types ──

export type SarahConfig = z.infer<typeof SarahConfigSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Skills = z.infer<typeof SkillsSchema>;
export type ProgramEntry = z.infer<typeof ProgramEntrySchema>;
export type PdfCategory = z.infer<typeof PdfCategorySchema>;
export type CustomCommand = z.infer<typeof CustomCommandSchema>;
export type Resources = z.infer<typeof ResourcesSchema>;
export type Trust = z.infer<typeof TrustSchema>;
export type Personalization = z.infer<typeof PersonalizationSchema>;
export type Controls = z.infer<typeof ControlsSchema>;
export type LlmConfig = z.infer<typeof LlmSchema>;
export type SystemInfo = z.infer<typeof SystemSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd G:/projects/S-A-R-A-H && npx vitest run src/core/config-schema.test.ts
```

Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/config-schema.ts src/core/config-schema.test.ts
git commit -m "feat: add Zod config schema with validation and defaults"
```

---

### Task 6: Create IPC Contract and SarahApi

**Files:**
- Create: `src/core/ipc-contract.ts`
- Create: `src/core/sarah-api.ts`

- [ ] **Step 1: Create ipc-contract.ts**

Create `src/core/ipc-contract.ts`:

```typescript
import type { SarahConfig, ProgramEntry } from './config-schema.js';
import type { VoiceState } from '../services/voice/voice-types.js';
import type { BusEvents } from './bus-events.js';

/** IPC channels using ipcMain.handle / ipcRenderer.invoke (request-response) */
export interface IpcCommands {
  'get-system-info':            { input: void; output: SystemIpcInfo };
  'get-config':                 { input: void; output: SarahConfig };
  'save-config':                { input: Partial<SarahConfig>; output: SarahConfig };
  'is-first-run':               { input: void; output: boolean };
  'select-folder':              { input: string | undefined; output: string | null };
  'detect-programs':            { input: void; output: ProgramEntry[] };
  'scan-folder-exes':           { input: string; output: ProgramEntry[] };
  'open-dialog':                { input: string; output: void };
  'chat-message':               { input: string; output: void };
  'voice-get-state':            { input: void; output: VoiceState };
  'voice-playback-done':        { input: void; output: void };
  'voice-audio-chunk':          { input: number[]; output: void };
  'voice-set-interaction-mode': { input: 'chat' | 'voice'; output: void };
  'voice-config-changed':       { input: void; output: void };
}

/** IPC events sent from main to renderer (one-way, forwarded bus events) */
export interface IpcEvents {
  'llm:chunk':         BusEvents['llm:chunk'];
  'llm:done':          BusEvents['llm:done'];
  'llm:error':         BusEvents['llm:error'];
  'voice:state':       BusEvents['voice:state'];
  'voice:listening':   BusEvents['voice:listening'];
  'voice:transcript':  BusEvents['voice:transcript'];
  'voice:speaking':    BusEvents['voice:speaking'];
  'voice:play-audio':  BusEvents['voice:play-audio'];
  'voice:done':        BusEvents['voice:done'];
  'voice:error':       BusEvents['voice:error'];
  'voice:interrupted': BusEvents['voice:interrupted'];
  'voice:wake':        BusEvents['voice:wake'];
}

/** IPC events sent from renderer to main (one-way) */
export interface IpcSendEvents {
  'splash-done': void;
}

/** System info returned by get-system-info IPC channel */
export interface SystemIpcInfo {
  os: string;
  platform: string;
  arch: string;
  cpu: string;
  cpuCores: string;
  totalMemory: string;
  freeMemory: string;
  hostname: string;
  shell: string;
  language: string;
  timezone: string;
  folders: {
    documents: string;
    downloads: string;
    pictures: string;
    desktop: string;
  };
}
```

- [ ] **Step 2: Create sarah-api.ts**

Create `src/core/sarah-api.ts`:

```typescript
import type { SarahConfig, ProgramEntry } from './config-schema.js';
import type { BusEvents } from './bus-events.js';
import type { SystemIpcInfo } from './ipc-contract.js';
import type { VoiceState } from '../services/voice/voice-types.js';

/** Voice sub-API exposed to renderers */
export interface SarahVoiceApi {
  getState(): Promise<VoiceState>;
  onStateChange(cb: (data: BusEvents['voice:state']) => void): () => void;
  onTranscript(cb: (data: BusEvents['voice:transcript']) => void): () => void;
  onPlayAudio(cb: (data: BusEvents['voice:play-audio']) => void): () => void;
  playbackDone(): Promise<void>;
  onError(cb: (data: BusEvents['voice:error']) => void): () => void;
  setInteractionMode(mode: 'chat' | 'voice'): Promise<void>;
  sendAudioChunk(chunk: number[]): Promise<void>;
  configChanged(): Promise<void>;
}

/** Full API exposed to renderers via contextBridge as `sarah` global */
export interface SarahApi {
  version: string;
  splashDone(): void;
  getSystemInfo(): Promise<SystemIpcInfo>;
  getConfig(): Promise<SarahConfig>;
  saveConfig(config: Partial<SarahConfig>): Promise<SarahConfig>;
  isFirstRun(): Promise<boolean>;
  selectFolder(title?: string): Promise<string | null>;
  detectPrograms(): Promise<ProgramEntry[]>;
  scanFolderExes(folderPath: string): Promise<ProgramEntry[]>;
  openDialog(view: string): Promise<void>;
  chat(message: string): Promise<void>;
  onChatChunk(cb: (data: BusEvents['llm:chunk']) => void): () => void;
  onChatDone(cb: (data: BusEvents['llm:done']) => void): () => void;
  onChatError(cb: (data: BusEvents['llm:error']) => void): () => void;
  voice: SarahVoiceApi;
}
```

- [ ] **Step 3: Verify types compile**

```bash
cd G:/projects/S-A-R-A-H && npx tsc --noEmit src/core/ipc-contract.ts src/core/sarah-api.ts
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/core/ipc-contract.ts src/core/sarah-api.ts
git commit -m "feat: add shared IPC contract and SarahApi interface"
```

---

### Task 7: Wire Config Validation into Bootstrap

**Files:**
- Modify: `src/core/bootstrap.ts`

- [ ] **Step 1: Update bootstrap.ts**

Replace the entire content of `src/core/bootstrap.ts` with:

```typescript
import * as path from 'path';
import { MessageBus } from './message-bus.js';
import { ServiceRegistry } from './service-registry.js';
import { JsonStorage } from './storage/json-storage.js';
import { SqliteStorage } from './storage/sqlite-storage.js';
import { EncryptedStorage } from './storage/encrypted-storage.js';
import { KeyManager } from './crypto/key-manager.js';
import type { StorageProvider } from './storage/storage.interface.js';
import { SarahConfigSchema } from './config-schema.js';
import type { SarahConfig } from './config-schema.js';

export interface AppContext {
  bus: MessageBus;
  registry: ServiceRegistry;
  config: StorageProvider;
  db: StorageProvider;
  /** Validated and defaulted config snapshot. Re-read after save-config. */
  parsedConfig: SarahConfig;
  /** Non-null if config validation failed — caller should show dialog */
  configErrors: string[] | null;
  shutdown: () => Promise<void>;
}

/**
 * Bootstrap the S.A.R.A.H. application.
 * Creates and wires up all core infrastructure.
 * Validates the config with Zod — returns defaults on invalid config.
 *
 * @param userDataPath — Electron's app.getPath('userData') or a test directory
 * @returns AppContext with parsedConfig, or throws ConfigError for UI handling
 */
export async function bootstrap(userDataPath: string): Promise<AppContext> {
  const keyManager = new KeyManager(userDataPath);
  const encryptionKey = keyManager.getOrCreateKey();

  const bus = new MessageBus();
  const registry = new ServiceRegistry(bus);

  const rawConfig = new JsonStorage(path.join(userDataPath, 'config.json'));
  const rawDb = new SqliteStorage(path.join(userDataPath, 'sarah.db'));
  const config = new EncryptedStorage(rawConfig, encryptionKey);
  const db = new EncryptedStorage(rawDb, encryptionKey);

  // Validate config — safeParse so caller can handle errors gracefully
  const raw = (await config.get<Record<string, unknown>>('root')) ?? {};
  const parseResult = SarahConfigSchema.safeParse(raw);

  let parsedConfig: SarahConfig;
  let configErrors: string[] | null = null;
  if (parseResult.success) {
    parsedConfig = parseResult.data;
  } else {
    configErrors = parseResult.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    console.error('[Bootstrap] Config validation failed, using defaults:', configErrors);
    parsedConfig = SarahConfigSchema.parse({});
  }

  return {
    bus,
    registry,
    config,
    db,
    parsedConfig,
    /** Non-null if config validation failed — caller should show dialog */
    configErrors,
    shutdown: async () => {
      await registry.destroyAll();
      await config.close();
      await db.close();
    },
  };
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd G:/projects/S-A-R-A-H && npx tsc --noEmit
```

Expected: Errors in files that import from bootstrap (main.ts, llm-service.ts, voice-service.ts) — these will be fixed in later tasks. The bootstrap itself should have no errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/bootstrap.ts
git commit -m "feat: validate config with Zod in bootstrap, expose parsedConfig"
```

---

### Task 8: Update LLM Service to Use Typed Events and Config

**Files:**
- Modify: `src/services/llm/llm-service.ts`

- [ ] **Step 1: Update llm-service.ts imports and types**

In `src/services/llm/llm-service.ts`, replace the imports at the top:

Old:
```typescript
import type { SarahService } from '../../core/service.interface.js';
import type { BusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
```

New:
```typescript
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import type { SarahConfig } from '../../core/config-schema.js';
```

- [ ] **Step 2: Update subscriptions type**

Change line 19:

Old:
```typescript
  readonly subscriptions = ['chat:message'];
```

New:
```typescript
  readonly subscriptions = ['chat:message'] as const;
```

- [ ] **Step 3: Update onMessage to use typed message**

Replace the `onMessage` method (lines 45-54):

Old:
```typescript
  onMessage(msg: BusMessage): void {
    if (msg.topic === 'chat:message') {
      const text = msg.data.text as string;
      this.handleChatMessage(text).catch(() => {
        this.context.bus.emit(this.id, 'llm:error', {
          message: ERROR_MESSAGES.connection,
        });
      });
    }
  }
```

New:
```typescript
  onMessage(msg: TypedBusMessage): void {
    if (msg.topic === 'chat:message') {
      this.handleChatMessage(msg.data.text).catch(() => {
        this.context.bus.emit(this.id, 'llm:error', {
          message: ERROR_MESSAGES.connection,
        });
      });
    }
  }
```

- [ ] **Step 4: Update buildSystemPrompt to use parsedConfig**

Replace the `buildSystemPrompt` method. Change the config reading at the top (lines 146-153):

Old:
```typescript
  private async buildSystemPrompt(): Promise<string> {
    const config =
      (await this.context.config.get<Record<string, any>>('root')) ?? {};
    const profile = config.profile ?? {};
    const skills = config.skills ?? {};
    const resources = config.resources ?? {};
    const personalization = config.personalization ?? {};
    const trust = config.trust ?? {};
    const controls = config.controls ?? {};
```

New:
```typescript
  private buildSystemPrompt(): string {
    const config = this.context.parsedConfig;
    const { profile, skills, resources, personalization, trust, controls } = config;
```

Since `buildSystemPrompt` no longer needs to be async, also update the call in `init()` (line 36):

Old:
```typescript
    this.systemPrompt = await this.buildSystemPrompt();
```

New:
```typescript
    this.systemPrompt = this.buildSystemPrompt();
```

Also remove the type assertions throughout the method. The casts like `(profile.displayName || 'User')` become just `(profile.displayName || 'User')` which already works. The `as string[]` and `as Record<string, unknown>` casts in the method body are no longer needed because `config` is now typed. Specifically remove:

- Line 184: `const purposes: string[] = profile.usagePurposes ?? [];` — the type is already `string[]`
- Line 188: `const hobbies: string[] = profile.hobbies ?? [];` — already typed
- Line 197: `const stack: string[] = skills.programmingStack ?? [];` — already typed
- Line 201: `const searchResources: string[] = skills.programmingResources ?? [];` — already typed
- Lines 220-225: The `pdfCats` type annotation is no longer needed, Zod provides the type
- Line 256: `const traits: string[] = personalization.characterTraits ?? [];` — already typed
- Line 298: `const exclusions: string[] = trust.memoryExclusions ?? [];` — already typed
- Lines 313-314: `const customCmds: { command: string; prompt: string }[]` — already typed

Note: There is a duplicate `customCmds` block at lines 327-335 that is identical to lines 313-324. Remove the duplicate block (lines 327-335).

- [ ] **Step 5: Verify compilation**

```bash
cd G:/projects/S-A-R-A-H && npx tsc --noEmit src/services/llm/llm-service.ts 2>&1 | head -20
```

Expected: Clean or only errors from other unmodified files

- [ ] **Step 6: Commit**

```bash
git add src/services/llm/llm-service.ts
git commit -m "refactor: type LlmService with typed bus events and parsed config"
```

---

### Task 9: Update Voice Service to Use Typed Events and Config

**Files:**
- Modify: `src/services/voice/voice-service.ts`

- [ ] **Step 1: Update imports**

In `src/services/voice/voice-service.ts`, replace the imports:

Old:
```typescript
import type { SarahService } from '../../core/service.interface.js';
import type { BusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
```

New:
```typescript
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
```

- [ ] **Step 2: Update subscriptions type**

Change line 30:

Old:
```typescript
  readonly subscriptions = ['llm:chunk', 'llm:done', 'llm:error'];
```

New:
```typescript
  readonly subscriptions = ['llm:chunk', 'llm:done', 'llm:error'] as const;
```

- [ ] **Step 3: Update init() config reading**

Replace lines 81-87:

Old:
```typescript
      const config = await this.context.config.get<Record<string, Record<string, unknown>>>('root');
      const controls = config?.controls as Record<string, unknown> | undefined;
      const rawMode = (controls?.voiceMode as VoiceMode) ?? 'off';
      // keyword mode is non-functional — treat as off
      this.voiceMode = rawMode === 'keyword' ? 'off' : rawMode;
      this.pushToTalkKey = (controls?.pushToTalkKey as string) ?? DEFAULT_PTT_KEY;
```

New:
```typescript
      const { controls } = this.context.parsedConfig;
      const rawMode = controls.voiceMode;
      // keyword mode is non-functional — treat as off
      this.voiceMode = rawMode === 'keyword' ? 'off' : rawMode;
      this.pushToTalkKey = controls.pushToTalkKey;
```

- [ ] **Step 4: Update onMessage() to use typed message**

Replace the `onMessage` method signature and remove `as` casts (lines 155-201):

Old:
```typescript
  onMessage(msg: BusMessage): void {
```

New:
```typescript
  onMessage(msg: TypedBusMessage): void {
```

In the method body, remove the `as string` casts:

Line 160 — Old: `const text = msg.data.text as string;`
New: Remove this line. Use `msg.data.text` directly in the conditional below. But since `msg` is a union type at this point, we need to narrow it. The cleanest approach:

Replace the full `onMessage` body (lines 155-201):

```typescript
  onMessage(msg: TypedBusMessage): void {
    const shouldSpeak = this.voiceMode !== 'off' && this.interactionMode !== 'chat';

    if (msg.topic === 'llm:chunk') {
      if (!shouldSpeak) return;
      const { text } = msg.data as { text: string };
      if (!text) return;

      const sentences = this.sentenceBuffer.push(text);
      for (const sentence of sentences) {
        if (this._voiceState === 'processing') {
          this.setState('speaking');
          this.context.bus.emit(this.id, 'voice:speaking', { text: sentence });
          this.llmStreaming = true;
        }
        this.ttsQueue?.enqueue(sentence);
      }
    } else if (msg.topic === 'llm:done') {
      if (!shouldSpeak) return;
      const remainder = this.sentenceBuffer.flush();
      if (remainder) {
        if (this._voiceState === 'processing') {
          this.setState('speaking');
          this.context.bus.emit(this.id, 'voice:speaking', { text: remainder });
        }
        this.ttsQueue?.enqueue(remainder);
      }
      this.llmStreaming = false;
      if (!this.ttsQueue?.isActive && this._voiceState === 'speaking') {
        this.onTtsQueueEmpty();
      }
    } else if (msg.topic === 'llm:error') {
      if (this.llmStreaming) {
        const remainder = this.sentenceBuffer.flush();
        if (remainder) {
          this.ttsQueue?.enqueue(remainder);
        }
        this.llmStreaming = false;
      } else if (this._voiceState === 'processing') {
        this.setState('idle');
        this.context.bus.emit(this.id, 'voice:error', {
          message: (msg.data as { message: string }).message ?? 'LLM request failed',
        });
      }
    }
  }
```

- [ ] **Step 5: Update applyConfig() config reading**

Replace lines 237-241:

Old:
```typescript
    const config = await this.context.config.get<Record<string, Record<string, unknown>>>('root');
    const controls = config?.controls as Record<string, unknown> | undefined;
    const rawMode = (controls?.voiceMode as VoiceMode) ?? 'off';
    this.voiceMode = rawMode === 'keyword' ? 'off' : rawMode;
    this.pushToTalkKey = (controls?.pushToTalkKey as string) ?? DEFAULT_PTT_KEY;
```

New:
```typescript
    // Re-read config from storage and re-parse
    const raw = (await this.context.config.get<Record<string, unknown>>('root')) ?? {};
    const { SarahConfigSchema } = await import('../../core/config-schema.js');
    const parsed = SarahConfigSchema.parse(raw);
    this.context.parsedConfig = parsed;
    const { controls } = parsed;
    const rawMode = controls.voiceMode;
    this.voiceMode = rawMode === 'keyword' ? 'off' : rawMode;
    this.pushToTalkKey = controls.pushToTalkKey;
```

- [ ] **Step 6: Verify compilation**

```bash
cd G:/projects/S-A-R-A-H && npx tsc --noEmit src/services/voice/voice-service.ts 2>&1 | head -20
```

- [ ] **Step 7: Commit**

```bash
git add src/services/voice/voice-service.ts
git commit -m "refactor: type VoiceService with typed bus events and parsed config"
```

---

### Task 10: Update Preload with IPC Types

**Files:**
- Modify: `src/preload.ts`

- [ ] **Step 1: Update preload.ts**

Replace the entire content of `src/preload.ts` with:

```typescript
import { contextBridge, ipcRenderer } from 'electron';
import type { SarahApi } from './core/sarah-api.js';

const api: SarahApi = {
  version: process.versions.electron,
  splashDone: () => ipcRenderer.send('splash-done'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  isFirstRun: () => ipcRenderer.invoke('is-first-run'),
  selectFolder: (title?) => ipcRenderer.invoke('select-folder', title),
  detectPrograms: () => ipcRenderer.invoke('detect-programs'),
  scanFolderExes: (folderPath) => ipcRenderer.invoke('scan-folder-exes', folderPath),
  openDialog: (view) => ipcRenderer.invoke('open-dialog', view),

  // Chat API
  chat: (message) => ipcRenderer.invoke('chat-message', message),
  onChatChunk: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { text: string }) => callback(data);
    ipcRenderer.on('llm:chunk', handler);
    return () => ipcRenderer.removeListener('llm:chunk', handler);
  },
  onChatDone: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { fullText: string }) => callback(data);
    ipcRenderer.on('llm:done', handler);
    return () => ipcRenderer.removeListener('llm:done', handler);
  },
  onChatError: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
    ipcRenderer.on('llm:error', handler);
    return () => ipcRenderer.removeListener('llm:error', handler);
  },

  // Voice API
  voice: {
    getState: () => ipcRenderer.invoke('voice-get-state'),
    onStateChange: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { state: string }) => callback(data as any);
      ipcRenderer.on('voice:state', handler);
      return () => ipcRenderer.removeListener('voice:state', handler);
    },
    onTranscript: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { text: string }) => callback(data);
      ipcRenderer.on('voice:transcript', handler);
      return () => ipcRenderer.removeListener('voice:transcript', handler);
    },
    onPlayAudio: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { audio: number[]; sampleRate: number }) => callback(data);
      ipcRenderer.on('voice:play-audio', handler);
      return () => ipcRenderer.removeListener('voice:play-audio', handler);
    },
    playbackDone: () => ipcRenderer.invoke('voice-playback-done'),
    onError: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
      ipcRenderer.on('voice:error', handler);
      return () => ipcRenderer.removeListener('voice:error', handler);
    },
    setInteractionMode: (mode) => ipcRenderer.invoke('voice-set-interaction-mode', mode),
    sendAudioChunk: (chunk) => ipcRenderer.invoke('voice-audio-chunk', chunk),
    configChanged: () => ipcRenderer.invoke('voice-config-changed'),
  },
};

contextBridge.exposeInMainWorld('sarah', api);
```

- [ ] **Step 2: Commit**

```bash
git add src/preload.ts
git commit -m "refactor: type preload with SarahApi interface"
```

---

### Task 11: Update Renderer Files to Use SarahApi

**Files:**
- Modify: `src/renderer/dashboard/dashboard.ts`
- Modify: `src/renderer/dashboard/dialog.ts`
- Modify: `src/renderer/services/audio-bridge.ts`
- Modify: `src/renderer/wizard/wizard.ts`
- Modify: `src/renderer/dashboard/views/home.ts`

- [ ] **Step 1: Update dashboard.ts**

In `src/renderer/dashboard/dashboard.ts`, replace lines 5-27 (the `declare const sarah` block and `__sarah` assignment):

Old:
```typescript
declare const sarah: {
  version: string;
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  selectFolder: (title?: string) => Promise<string | null>;
  openDialog: (view: string) => Promise<void>;
  chat: (message: string) => Promise<void>;
  onChatChunk: (cb: (data: { text: string }) => void) => () => void;
  onChatDone: (cb: (data: { fullText: string }) => void) => () => void;
  onChatError: (cb: (data: { message: string }) => void) => () => void;
  voice: {
    getState: () => Promise<string>;
    onStateChange: (cb: (data: { state: string }) => void) => () => void;
    onPlayAudio: (cb: (data: { audio: number[]; sampleRate: number }) => void) => () => void;
    playbackDone: () => Promise<void>;
    onError: (cb: (data: { message: string }) => void) => () => void;
    setInteractionMode: (mode: string) => Promise<void>;
    sendAudioChunk: (chunk: number[]) => Promise<void>;
    onTranscript: (cb: (data: { text: string }) => void) => () => void;
  };
};

(window as any).__sarah = sarah;
```

New:
```typescript
import type { SarahApi } from '../../core/sarah-api.js';

declare const sarah: SarahApi;

(window as any).__sarah = sarah;
```

Also update line 32 (accent color loading):

Old:
```typescript
sarah.getConfig().then((config: any) => {
  const color = config.personalization?.accentColor;
```

New:
```typescript
sarah.getConfig().then((config) => {
  const color = config.personalization?.accentColor;
```

- [ ] **Step 2: Update dialog.ts**

In `src/renderer/dashboard/dialog.ts`, replace lines 6-11:

Old:
```typescript
declare const sarah: {
  version: string;
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  selectFolder: (title?: string) => Promise<string | null>;
};

(window as any).__sarah = sarah;
```

New:
```typescript
import type { SarahApi } from '../../core/sarah-api.js';

declare const sarah: SarahApi;

(window as any).__sarah = sarah;
```

Also update line 18:

Old:
```typescript
sarah.getConfig().then((config: any) => {
```

New:
```typescript
sarah.getConfig().then((config) => {
```

- [ ] **Step 3: Update audio-bridge.ts**

In `src/renderer/services/audio-bridge.ts`, replace lines 3-12:

Old:
```typescript
declare const sarah: {
  voice: {
    getState: () => Promise<string>;
    onStateChange: (cb: (data: { state: string }) => void) => () => void;
    onPlayAudio: (cb: (data: { audio: number[]; sampleRate: number }) => void) => () => void;
    playbackDone: () => Promise<void>;
    onError: (cb: (data: { message: string }) => void) => () => void;
    sendAudioChunk: (chunk: number[]) => Promise<void>;
  };
};
```

New:
```typescript
import type { SarahApi } from '../../core/sarah-api.js';

declare const sarah: SarahApi;
```

Also update `handleStateChange` (line 63) — the parameter type changes from `string` to `VoiceState`, but since `VoiceState` is a string union, the string comparisons still work:

Old:
```typescript
  private handleStateChange(state: string): void {
```

New:
```typescript
  private handleStateChange(state: string): void {
```

(No change needed — the callback receives the data object and destructures `state` which is typed as `VoiceState` from the API, but the method receives it as a string from the destructured callback. Keep as-is for now.)

- [ ] **Step 4: Update wizard.ts**

In `src/renderer/wizard/wizard.ts`, replace lines 14-48 (ProgramEntry, PdfCategory, CustomCommand types and declare block):

Old:
```typescript
export type ProgramType = 'exe' | 'launcher' | 'appx' | 'updater';

export interface ProgramEntry {
  name: string;
  path: string;
  type: ProgramType;
  source: 'detected' | 'manual' | 'learned';
  verified: boolean;
  aliases: string[];
  duplicateGroup?: string;
}

export interface PdfCategory {
  tag: string;
  folder: string;
  pattern: string;
  inferFromExisting: boolean;
}

export interface CustomCommand {
  command: string;
  prompt: string;
}

declare const sarah: {
  version: string;
  splashDone: () => void;
  getSystemInfo: () => Promise<Record<string, string>>;
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  isFirstRun: () => Promise<boolean>;
  selectFolder: (title?: string) => Promise<string | null>;
  detectPrograms: () => Promise<{ name: string; path: string; verified: boolean; aliases: string[] }[]>;
  scanFolderExes: (folderPath: string) => Promise<{ name: string; path: string; verified: boolean; aliases: string[] }[]>;
};

(window as any).__sarah = sarah;
```

New:
```typescript
import type { SarahApi } from '../../core/sarah-api.js';
export type { ProgramEntry, PdfCategory, CustomCommand } from '../../core/config-schema.js';
import type { ProgramEntry, PdfCategory, CustomCommand } from '../../core/config-schema.js';

declare const sarah: SarahApi;

(window as any).__sarah = sarah;
```

Note: The wizard re-exports these types because wizard step files import them from `../wizard.js`. The re-export preserves backwards compatibility.

- [ ] **Step 5: Update home.ts**

In `src/renderer/dashboard/views/home.ts`, replace the `getSarah` function and update config usage:

Old:
```typescript
function getSarah(): any {
  return (window as any).__sarah;
}

export async function createHomeView(): Promise<HTMLElement> {
  const container = document.createElement('div');

  const config = await getSarah().getConfig();
  const profile = config.profile || {};
  const resources = config.resources || {};
```

New:
```typescript
import type { SarahApi } from '../../../core/sarah-api.js';

function getSarah(): SarahApi {
  return (window as any).__sarah as SarahApi;
}

export async function createHomeView(): Promise<HTMLElement> {
  const container = document.createElement('div');

  const config = await getSarah().getConfig();
  const { profile, resources } = config;
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/dashboard/dashboard.ts src/renderer/dashboard/dialog.ts src/renderer/services/audio-bridge.ts src/renderer/wizard/wizard.ts src/renderer/dashboard/views/home.ts
git commit -m "refactor: replace inline sarah declarations with shared SarahApi"
```

---

### Task 12: Update Settings View to Use Typed Config

**Files:**
- Modify: `src/renderer/dashboard/views/settings.ts`

- [ ] **Step 1: Update settings.ts imports and getSarah**

Replace lines 1-13 of `src/renderer/dashboard/views/settings.ts`:

Old:
```typescript
import { sarahInput } from '../../components/sarah-input.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahButton } from '../../components/sarah-button.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { applyAccentColor } from '../accent.js';

type Config = Record<string, Record<string, unknown>>;

function getSarah(): Record<string, (...args: unknown[]) => unknown> {
  return ((window as unknown) as Record<string, unknown>).__sarah as Record<string, (...args: unknown[]) => unknown>;
}
```

New:
```typescript
import { sarahInput } from '../../components/sarah-input.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahButton } from '../../components/sarah-button.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { applyAccentColor } from '../accent.js';
import type { SarahApi } from '../../../core/sarah-api.js';
import type { SarahConfig, PdfCategory } from '../../../core/config-schema.js';

function getSarah(): SarahApi {
  return (window as any).__sarah as SarahApi;
}
```

- [ ] **Step 2: Update save helper**

Replace lines 34-36:

Old:
```typescript
function save(key: string, value: Record<string, unknown>): void {
  (getSarah().saveConfig as (c: Record<string, unknown>) => Promise<unknown>)({ [key]: value });
}
```

New:
```typescript
function save(key: string, value: Partial<SarahConfig>[keyof SarahConfig]): void {
  getSarah().saveConfig({ [key]: value } as Partial<SarahConfig>);
}
```

- [ ] **Step 3: Update section functions to use typed config**

Update `createProfileSection` (line 40-41):

Old:
```typescript
function createProfileSection(config: Config): HTMLElement {
  const profile = (config.profile || {}) as Record<string, string>;
```

New:
```typescript
function createProfileSection(config: SarahConfig): HTMLElement {
  const profile = { ...config.profile };
```

Update `createFilesSection` (lines 157-159):

Old:
```typescript
function createFilesSection(config: Config): HTMLElement {
  const resources = (config.resources || {}) as Record<string, unknown>;
  const skills = (config.skills || {}) as Record<string, unknown>;
```

New:
```typescript
function createFilesSection(config: SarahConfig): HTMLElement {
  const resources = { ...config.resources };
  const skills = { ...config.skills };
```

Remove the local `PdfCategory` interface (lines 117-122) — it's now imported from config-schema.

Update `createTrustSection` (line 258-259):

Old:
```typescript
function createTrustSection(config: Config): HTMLElement {
  const trust = (config.trust || {}) as Record<string, unknown>;
```

New:
```typescript
function createTrustSection(config: SarahConfig): HTMLElement {
  const trust = { ...config.trust };
```

Remove the `as string` casts in trust section — the typed config makes them unnecessary.

Update `createPersonalizationSection` (line 362-363):

Old:
```typescript
function createPersonalizationSection(config: Config): HTMLElement {
  const pers = (config.personalization || {}) as Record<string, unknown>;
```

New:
```typescript
function createPersonalizationSection(config: SarahConfig): HTMLElement {
  const pers = { ...config.personalization };
```

Remove all `as string`, `as string[]`, `as Record<string, unknown>` casts in this section.

Remove the local `CustomCommand` interface (lines 551-554) — imported from config-schema.

Update `createControlsSection` (line 581-582):

Old:
```typescript
function createControlsSection(config: Config): HTMLElement {
  const controls = (config.controls || {}) as Record<string, unknown>;
```

New:
```typescript
function createControlsSection(config: SarahConfig): HTMLElement {
  const controls = { ...config.controls };
```

Remove all `as string` casts in controls section.

Update `createSettingsView` (line 747):

Old:
```typescript
  const config = await (getSarah().getConfig as () => Promise<Config>)() as Config;
```

New:
```typescript
  const config = await getSarah().getConfig();
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/dashboard/views/settings.ts
git commit -m "refactor: type settings view with SarahConfig, remove all as-casts"
```

---

### Task 13: Update main.ts to Use Typed Config and Events

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add config error dialog after bootstrap**

Right after `appContext = await bootstrap(...)` (line 171), add the config error dialog:

```typescript
  appContext = await bootstrap(app.getPath('userData'));

  // Show dialog if config validation failed
  if (appContext.configErrors) {
    const issues = appContext.configErrors.map((e) => `• ${e}`).join('\n');
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Konfigurationsfehler',
      message: 'Die Konfigurationsdatei enthält ungültige Werte:',
      detail: `${issues}\n\nMit Standard-Werten fortfahren?`,
      buttons: ['Mit Defaults fortfahren', 'Beenden'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) {
      app.quit();
      return;
    }
  }
```

- [ ] **Step 2: Update LLM config reading**

Replace line 174-180 (config reading after bootstrap):

Old:
```typescript
  const rootConfig = (await appContext.config.get<Record<string, unknown>>('root')) ?? {};
  const llmRaw = rootConfig.llm as Partial<LlmConfig> | undefined;
  const llmConfig: LlmConfig = {
    baseUrl: llmRaw?.baseUrl ?? DEFAULT_LLM_CONFIG.baseUrl,
    model: llmRaw?.model ?? DEFAULT_LLM_CONFIG.model,
    options: llmRaw?.options ?? DEFAULT_LLM_CONFIG.options,
  };
```

New:
```typescript
  const { llm: llmConfig } = appContext.parsedConfig;
```

Remove the `DEFAULT_LLM_CONFIG` import from line 9 since defaults now come from Zod.

- [ ] **Step 2: Update splash-done handler**

Replace lines 217-219:

Old:
```typescript
      const config =
        (await appContext!.config.get<Record<string, unknown>>('root')) ?? {};
      if ((config as any).onboarding?.setupComplete) {
```

New:
```typescript
      if (appContext!.parsedConfig.onboarding.setupComplete) {
```

- [ ] **Step 3: Update get-config handler**

Replace lines 261-265:

Old:
```typescript
  ipcMain.handle('get-config', async () => {
    return (
      (await appContext!.config.get<Record<string, unknown>>('root')) ?? {}
    );
  });
```

New:
```typescript
  ipcMain.handle('get-config', async () => {
    return appContext!.parsedConfig;
  });
```

- [ ] **Step 4: Update save-config handler**

Replace lines 267-285:

Old:
```typescript
  ipcMain.handle(
    'save-config',
    async (_event, config: Record<string, unknown>) => {
      const existing =
        (await appContext!.config.get<Record<string, unknown>>('root')) ?? {};
      const merged = { ...existing, ...config };
      await appContext!.config.set('root', merged);

      // Apply voice config changes live when controls section is saved
      if ('controls' in config) {
        const voiceService = appContext!.registry.get('voice');
        if (voiceService && voiceService instanceof VoiceService) {
          await voiceService.applyConfig();
        }
      }

      return merged;
    },
  );
```

New:
```typescript
  ipcMain.handle(
    'save-config',
    async (_event, config: Partial<SarahConfig>) => {
      const existing = (await appContext!.config.get<Record<string, unknown>>('root')) ?? {};
      const merged = { ...existing, ...config };
      await appContext!.config.set('root', merged);

      // Re-parse merged config
      const { SarahConfigSchema } = await import('./core/config-schema.js');
      appContext!.parsedConfig = SarahConfigSchema.parse(merged);

      // Apply voice config changes live when controls section is saved
      if ('controls' in config) {
        const voiceService = appContext!.registry.get('voice');
        if (voiceService && voiceService instanceof VoiceService) {
          await voiceService.applyConfig();
        }
      }

      return appContext!.parsedConfig;
    },
  );
```

Add import at the top of main.ts:

```typescript
import type { SarahConfig } from './core/config-schema.js';
```

- [ ] **Step 5: Update is-first-run handler**

Replace lines 287-291:

Old:
```typescript
  ipcMain.handle('is-first-run', async () => {
    const config =
      (await appContext!.config.get<Record<string, unknown>>('root')) ?? {};
    return !(config as any).onboarding?.setupComplete;
  });
```

New:
```typescript
  ipcMain.handle('is-first-run', () => {
    return !appContext!.parsedConfig.onboarding.setupComplete;
  });
```

- [ ] **Step 6: Type the forwardToRenderers helper**

Replace lines 347-355:

Old:
```typescript
  const forwardToRenderers = (topic: string) => {
    appContext!.bus.on(topic, (msg) => {
```

New:
```typescript
  const forwardToRenderers = <T extends import('./core/bus-events.js').BusTopic>(topic: T) => {
    appContext!.bus.on(topic, (msg) => {
```

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "refactor: type main.ts with parsedConfig and typed bus events"
```

---

### Task 14: Full Build and Test Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all unit tests**

```bash
cd G:/projects/S-A-R-A-H && npx vitest run
```

Expected: All tests PASS

- [ ] **Step 2: Run TypeScript compilation**

```bash
cd G:/projects/S-A-R-A-H && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Build the project**

```bash
cd G:/projects/S-A-R-A-H && npm run build
```

Expected: Build succeeds

- [ ] **Step 4: Run the app**

```bash
cd G:/projects/S-A-R-A-H && npm start
```

Expected: App launches, dashboard loads, settings page works, voice mode toggleable

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve build issues from TS contracts migration"
```
