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

const astronomyCandidate = JSON.stringify({
  decision: 'candidate', kind: 'preference', topic: 'Astronomie',
  content: 'Martin interessiert sich für Astronomie.',
  evidence: 'Ich interessiere mich für Astronomie.',
  searchTerms: ['Astronomie'], durability: 'stable', confidence: 0.9,
});
const addDecision = JSON.stringify({ action: 'add', topic: null, targets: [] });

function queuedWorker(outputs: readonly string[]): CuratorWorker {
  let index = 0;
  return new CuratorWorker(async () => outputs[index++] ?? outputs.at(-1) ?? '{invalid-json');
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

  async function stageText(turnId: string, text: string): Promise<void> {
    await db.insertTurnMessages(1, turnId, [{ role: 'user', content: text }]);
    await store.stageTurn(1, turnId, [{ role: 'user', content: text }], {
      allowed: true, exclusions: [],
    });
  }

  it('uses separate system/data messages and atomically completes one small job', async () => {
    await stage();
    const received: ChatMessage[][] = [];
    const worker = new CuratorWorker(async (messages) => {
      received.push(messages);
      return received.length === 1 ? astronomyCandidate : addDecision;
    });
    let cacheRefreshes = 0;
    const curator = new MemoryCurator(store, worker, {
      idleDelayMs: 60_000,
      onMemoryChanged: () => { cacheRefreshes += 1; },
    });

    await curator.runOne();

    expect(received[0][0].role).toBe('system');
    expect(received[0][1].role).toBe('user');
    expect(received[0][1].content).toContain('USER: Ich interessiere mich');
    expect(received[0][1].content).toContain('ASSISTANT: Das ist ein spannendes Thema');
    expect(received).toHaveLength(2);
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
        decision: 'ignore', reason: 'no-user-fact',
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

  it('does not ask for a delta or persist a temporary mood', async () => {
    await stageText('turn-temporary', 'Heute nervt mich Schach.');
    let calls = 0;
    const curator = new MemoryCurator(store, new CuratorWorker(async () => {
      calls += 1;
      return JSON.stringify({
        decision: 'candidate', kind: 'preference', topic: 'Schach',
        content: 'Martin ist heute von Schach genervt.', evidence: 'Heute nervt mich Schach.',
        searchTerms: ['Schach'], durability: 'stable', confidence: 0.9,
      });
    }), { idleDelayMs: 60_000 });

    await curator.runOne();

    expect(calls).toBe(1);
    expect(await store.list()).toEqual([]);
    expect(await db.query('memory_staging', { state: 'completed' })).toHaveLength(1);
    await curator.destroy();
  });

  it('retries a candidate whose claimed evidence is not in the user text', async () => {
    await stage();
    const inventedEvidence = JSON.stringify({
      decision: 'candidate', kind: 'preference', topic: 'Astronomie',
      content: 'Martin besitzt ein Teleskop.', evidence: 'Ich besitze ein Teleskop.',
      searchTerms: ['Astronomie', 'Teleskop'], durability: 'stable', confidence: 0.9,
    });
    const curator = new MemoryCurator(store, queuedWorker([inventedEvidence, addDecision]), {
      idleDelayMs: 60_000,
    });

    await curator.runOne();

    expect(await store.list()).toEqual([]);
    expect(await store.hasPending()).toBe(true);
    expect(await db.query('memory_staging')).toEqual([
      expect.objectContaining({ state: 'pending', attempts: 1 }),
    ]);
    await curator.destroy();
  });

  it('keeps a duplicate in one existing topic without adding a second memory', async () => {
    const topicId = await db.insert('memory_topics', { title: 'Astronomie', version: 1 });
    const memoryId = await db.insert('curated_memories', {
      topic_id: topicId, kind: 'preference', content: 'Martin interessiert sich für Astronomie.',
      evidence: 'Ich interessiere mich für Astronomie.', source_turn_id: 'old-turn',
      confidence: 0.9, status: 'active', revision: 1, created_by_action: 'add',
    });
    await stage('turn-duplicate');
    const curator = new MemoryCurator(store, queuedWorker([
      astronomyCandidate,
      JSON.stringify({
        action: 'ignore', topic: { id: topicId, version: 1 },
        targets: [{ id: memoryId, revision: 1 }],
      }),
    ]), { idleDelayMs: 60_000 });

    await curator.runOne();

    expect(await store.list()).toHaveLength(1);
    expect(await db.query('memory_staging', { turn_id: 'turn-duplicate' })).toEqual([
      expect.objectContaining({ state: 'completed', decision: 'ignore' }),
    ]);
    await curator.destroy();
  });

  it('adds a distinct chess statement to the offered chess topic', async () => {
    const topicId = await db.insert('memory_topics', { title: 'Schach', version: 1 });
    await db.insert('curated_memories', {
      topic_id: topicId, kind: 'preference', content: 'Martin spielt gern Schach.',
      evidence: 'Ich spiele gern Schach.', source_turn_id: 'old-chess',
      confidence: 0.9, status: 'active', revision: 1, created_by_action: 'add',
    });
    await stageText('turn-chess', 'Ich lerne gerade die Sizilianische Verteidigung.');
    const chessCandidate = JSON.stringify({
      decision: 'candidate', kind: 'fact', topic: 'Schach',
      content: 'Martin lernt die Sizilianische Verteidigung.',
      evidence: 'Ich lerne gerade die Sizilianische Verteidigung.',
      searchTerms: ['Schach', 'Sizilianische Verteidigung'], durability: 'stable', confidence: 0.88,
    });
    const curator = new MemoryCurator(store, queuedWorker([
      chessCandidate,
      JSON.stringify({ action: 'add', topic: { id: topicId, version: 1 }, targets: [] }),
    ]), { idleDelayMs: 60_000 });

    await curator.runOne();

    expect(await store.list()).toHaveLength(2);
    expect(await db.query('memory_topics')).toHaveLength(1);
    expect(await db.query('memory_topics', { id: topicId })).toEqual([
      expect.objectContaining({ version: 2 }),
    ]);
    await curator.destroy();
  });

  it('supersedes a clearly revised active preference using the offered revisions', async () => {
    const topicId = await db.insert('memory_topics', { title: 'Schach', version: 1 });
    const oldId = await db.insert('curated_memories', {
      topic_id: topicId, kind: 'preference', content: 'Martin mag kein Schach.',
      evidence: 'Ich mag kein Schach.', source_turn_id: 'old-negative',
      confidence: 0.9, status: 'active', revision: 1, created_by_action: 'add',
    });
    await stageText('turn-revision', 'Mittlerweile mag ich Schach wirklich gern.');
    const revised = JSON.stringify({
      decision: 'candidate', kind: 'preference', topic: 'Schach',
      content: 'Martin mag Schach mittlerweile gern.',
      evidence: 'Mittlerweile mag ich Schach wirklich gern.',
      searchTerms: ['Schach'], durability: 'stable', confidence: 0.95,
    });
    const curator = new MemoryCurator(store, queuedWorker([
      revised,
      JSON.stringify({
        action: 'supersede', topic: { id: topicId, version: 1 },
        targets: [{ id: oldId, revision: 1 }],
      }),
    ]), { idleDelayMs: 60_000 });

    await curator.runOne();

    expect(await store.list()).toEqual([
      expect.objectContaining({ content: 'Martin mag Schach mittlerweile gern.', status: 'active' }),
    ]);
    expect(await db.query('curated_memories', { id: oldId })).toEqual([
      expect.objectContaining({ status: 'superseded', superseded_by_id: expect.any(Number) }),
    ]);
    await curator.destroy();
  });

  it('releases a stale topic decision without a partial write or consumed attempt', async () => {
    const topicId = await db.insert('memory_topics', { title: 'Astronomie', version: 1 });
    const memoryId = await db.insert('curated_memories', {
      topic_id: topicId, kind: 'preference', content: 'Martin interessiert sich für Astronomie.',
      evidence: 'Ich interessiere mich für Astronomie.', source_turn_id: 'old-turn',
      confidence: 0.9, status: 'active', revision: 1, created_by_action: 'add',
    });
    await stage('turn-stale');
    let calls = 0;
    const curator = new MemoryCurator(store, new CuratorWorker(async () => {
      calls += 1;
      if (calls === 1) return astronomyCandidate;
      await db.update('memory_topics', { id: topicId }, { version: 2 });
      return JSON.stringify({
        action: 'update', topic: { id: topicId, version: 1 },
        targets: [{ id: memoryId, revision: 1 }],
      });
    }), { idleDelayMs: 60_000 });

    await curator.runOne();

    expect(await store.list()).toHaveLength(1);
    expect(await db.query('memory_staging', { turn_id: 'turn-stale' })).toEqual([
      expect.objectContaining({ state: 'pending', attempts: 0, decision: null }),
    ]);
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
    let workerCalls = 0;
    const curator = new MemoryCurator(
      store,
      new CuratorWorker(async () => {
        workerCalls += 1;
        markWorkerStarted();
        await workerRelease;
        return workerCalls === 1 ? astronomyCandidate : addDecision;
      }),
      {
        idleDelayMs: 60_000,
        getCurrentPolicy: () => policy,
        onMemoryChanged: () => { cacheRefreshes += 1; },
      },
    );

    const running = curator.runOne();
    await workerStarted;
    policy.exclusions = ['Astronomie'];
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
      queuedWorker([astronomyCandidate, addDecision]),
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
        if (calls === 1) return '{invalid-json';
        return calls === 2 ? astronomyCandidate : addDecision;
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
