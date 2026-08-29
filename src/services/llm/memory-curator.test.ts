import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteStorage } from '../../core/storage/sqlite-storage.js';
import { Layer2MemoryStore } from '../../core/storage/layer2-memory-store.js';
import type { WorkerTextGenerator } from './model-runtime.js';
import type { ChatMessage, ChatOptions } from './llm-provider.interface.js';
import { MemoryCurator } from './memory-curator.js';

class CuratorWorker implements WorkerTextGenerator {
  constructor(private readonly generate: (messages: ChatMessage[], options?: ChatOptions) => Promise<string>) {}

  generateWorkerMessages(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    return this.generate(messages, options);
  }

  generateWorkerText(prompt: string, options?: ChatOptions): Promise<string> {
    return this.generate([{ role: 'user', content: prompt }], options);
  }
}

describe('MemoryCurator', () => {
  let tmpDir: string;
  let db: SqliteStorage;
  let store: Layer2MemoryStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-curator-'));
    db = new SqliteStorage(path.join(tmpDir, 'memory.db'));
    store = new Layer2MemoryStore(db);
    await db.insert('conversations', { mode: 'ambient' });
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function stage(turnId = 'turn-1'): Promise<void> {
    await db.insertTurnMessages(1, turnId, [
      { role: 'user', content: 'Ich interessiere mich für Astronomie.' },
      { role: 'assistant', content: 'Das ist ein spannendes Thema.' },
    ]);
    await store.stageTurn(1, turnId, [
      { role: 'user', content: 'Ich interessiere mich für Astronomie.' },
      { role: 'assistant', content: 'Das ist ein spannendes Thema.' },
    ], {
      allowed: true,
      exclusions: [],
    });
  }

  it('uses separate system/data messages and atomically completes one small job', async () => {
    await stage();
    let received: ChatMessage[] = [];
    const worker = new CuratorWorker(async (messages) => {
      received = messages;
      return JSON.stringify({ relevant: true, kind: 'preference', content: 'Interesse an Astronomie.', confidence: 0.9 });
    });
    let cacheRefreshes = 0;
    const curator = new MemoryCurator(store, worker, {
      idleDelayMs: 60_000,
      onMemoryChanged: () => { cacheRefreshes += 1; },
    });

    await curator.runOne();

    expect(received[0].role).toBe('system');
    expect(received[1].role).toBe('user');
    expect(received[1].content).toContain('USER: Ich interessiere mich');
    expect(received[1].content).toContain('ASSISTANT: Das ist ein spannendes Thema');
    expect(await store.list()).toHaveLength(1);
    expect(cacheRefreshes).toBe(1);
    expect(await db.query('messages')).toEqual([]);
    const staging = await db.query<{ state: string; source_content: string }>('memory_staging');
    expect(staging[0]).toMatchObject({ state: 'completed', source_content: '' });
    await curator.destroy();
  });

  it('returns invalid model output to pending without writing memory', async () => {
    await stage();
    const curator = new MemoryCurator(
      store,
      new CuratorWorker(async () => '{not-json'),
      { idleDelayMs: 60_000 },
    );

    await curator.runOne();

    expect(await store.list()).toEqual([]);
    expect(await store.hasPending()).toBe(true);
    const [staging] = await db.query<{ attempts: number }>('memory_staging');
    expect(staging.attempts).toBe(1);
    await curator.destroy();
  });

  it('atomically discards raw data when a valid result is not memory-worthy', async () => {
    await stage();
    const curator = new MemoryCurator(
      store,
      new CuratorWorker(async () => JSON.stringify({
        relevant: false, kind: 'episode', content: '', confidence: 0,
      })),
      { idleDelayMs: 60_000 },
    );

    await curator.runOne();

    expect(await store.list()).toEqual([]);
    expect(await db.query('messages')).toEqual([]);
    const staging = await db.query<{ state: string; source_content: string }>('memory_staging');
    expect(staging[0]).toMatchObject({ state: 'completed', source_content: '' });
    await curator.destroy();
  });

  it('rechecks curator output against the current policy immediately before final write', async () => {
    await stage();
    const policy = { allowed: true, exclusions: [] as string[] };
    let markWorkerStarted!: () => void;
    let releaseWorker!: () => void;
    const workerStarted = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
    const workerRelease = new Promise<void>((resolve) => { releaseWorker = resolve; });
    let cacheRefreshes = 0;
    const curator = new MemoryCurator(
      store,
      new CuratorWorker(async () => {
        markWorkerStarted();
        await workerRelease;
        return JSON.stringify({
          relevant: true,
          kind: 'fact',
          content: 'Peter interessiert sich für Astronomie.',
          confidence: 0.8,
        });
      }),
      {
        idleDelayMs: 60_000,
        getCurrentPolicy: () => policy,
        onMemoryChanged: () => { cacheRefreshes += 1; },
      },
    );

    const running = curator.runOne();
    await workerStarted;
    policy.exclusions = ['Namen Dritter'];
    releaseWorker();
    await running;

    expect(await store.list()).toEqual([]);
    expect(cacheRefreshes).toBe(0);
    expect(await db.query('messages')).toEqual([]);
    const [staging] = await db.query<{ state: string; source_content: string }>('memory_staging');
    expect(staging).toMatchObject({ state: 'completed', source_content: '' });
    await curator.destroy();
  });

  it('cancels for user input and keeps the job resumable', async () => {
    await stage();
    const worker = new CuratorWorker((_messages, options) => new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const curator = new MemoryCurator(store, worker, { idleDelayMs: 60_000 });

    const running = curator.runOne();
    await new Promise((resolve) => setTimeout(resolve, 10));
    curator.cancelForUserInput();
    await running;

    expect(await store.list()).toEqual([]);
    expect(await store.hasPending()).toBe(true);
    const [staging] = await db.query<{ attempts: number }>('memory_staging');
    expect(staging.attempts).toBe(0);
    await curator.destroy();
  });

  it('does not requeue an already completed job when cache refresh fails', async () => {
    await stage();
    const curator = new MemoryCurator(
      store,
      new CuratorWorker(async () => JSON.stringify({
        relevant: true, kind: 'preference', content: 'Interesse an Astronomie.', confidence: 0.9,
      })),
      { idleDelayMs: 60_000, onMemoryChanged: () => { throw new Error('cache unavailable'); } },
    );

    await curator.runOne();

    expect(await store.list()).toHaveLength(1);
    expect(await store.hasPending()).toBe(false);
    const staging = await db.query<{ state: string }>('memory_staging');
    expect(staging[0].state).toBe('completed');
    await curator.destroy();
  });

  it('backs off a poison job so a later job can complete', async () => {
    await stage('turn-poison');
    await stage('turn-good');
    let calls = 0;
    const curator = new MemoryCurator(
      store,
      new CuratorWorker(async () => {
        calls += 1;
        return calls === 1
          ? '{invalid-json'
          : JSON.stringify({ relevant: true, kind: 'fact', content: 'Interesse an Astronomie.', confidence: 0.8 });
      }),
      { idleDelayMs: 60_000 },
    );

    await curator.runOne();
    await curator.runOne();

    expect(await store.list()).toHaveLength(1);
    const rows = await db.query<{ turn_id: string; state: string }>('memory_staging');
    expect(rows.find((row) => row.turn_id === 'turn-poison')?.state).toBe('pending');
    expect(rows.find((row) => row.turn_id === 'turn-good')?.state).toBe('completed');
    await curator.destroy();
  });

  it('retains and reports a poison job after the bounded third attempt', async () => {
    await stage('turn-poison');
    let failures = 0;
    const curator = new MemoryCurator(
      store,
      new CuratorWorker(async () => '{invalid-json'),
      { idleDelayMs: 60_000, onMaintenanceFailure: () => { failures += 1; } },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await db.update('memory_staging', { turn_id: 'turn-poison' }, { updated_at: '1970-01-01T00:00:00.000Z' });
      }
      await curator.runOne();
    }

    const [row] = await db.query<{
      state: string;
      source_content: string;
      policy_terms: string;
      attempts: number;
    }>('memory_staging');
    expect(row).toMatchObject({
      state: 'failed', attempts: 3,
    });
    expect(row.source_content).toContain('Astronomie');
    expect(row.policy_terms).toMatch(/^sarah-policy-fp:v1:/);
    expect(await db.query('messages')).toHaveLength(2);
    expect(await store.hasPending()).toBe(false);
    expect(failures).toBe(1);
    await curator.destroy();
  });
});
