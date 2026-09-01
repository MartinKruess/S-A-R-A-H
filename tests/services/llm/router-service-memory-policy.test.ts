import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RouterService, type RouterServiceOptions } from '../../../src/services/llm/router-service.js';
import { bootstrap } from '../../../src/core/bootstrap.js';
import type { AppContext } from '../../../src/core/bootstrap.js';
import type { LlmProvider, ChatMessage } from '../../../src/services/llm/llm-provider.interface.js';
import type { ApplyMemoryAuthorDeltaInput, ApplyMemoryAuthorDeltaResult, CompleteMemoryStagingInput, StorageProvider, Filter, MessageRow, MessagesPageQuery, TurnMessageWrite, Layer2MemoryPurgeResult } from '../../../src/core/storage/storage.interface.js';
import type { BusEvents } from '../../../src/core/bus-events.js';
import { START_CONTEXT_HEADER } from '../../../src/services/llm/context-window.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MessageBus } from '../../../src/core/message-bus.js';
import { MediaContext } from '../../../src/services/llm/media-context.js';
import type { TurnRequest } from '../../../src/core/turn-contract.js';
import {
  ActionConfirmationGate,
} from '../../../src/core/action-confirmation.js';
import { WORKER_UNAVAILABLE_MESSAGE } from '../../../src/core/chat-availability.js';
import { ModelRuntime } from '../../../src/services/llm/model-runtime.js';
import type { SarahService } from '../../../src/core/service.interface.js';
import type { ServiceStatus } from '../../../src/core/types.js';
import {
  BlockingProvider,
  FakeProvider,
  FailingAfterWarmupProvider,
  FailingMidstreamProvider,
  FailingStorage,
  RecoveringProvider,
  ScriptedProvider,
  StubActionService,
  StubVoiceService,
  UnavailableProvider,
  startAction,
} from './router-service-test-harness.js';

describe('RouterService (memory policy & cancellation)', () => {
  let tmpDir: string;
  let ctx: AppContext;
  let router: RouterService | null = null;
  let workerProvider: FakeProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-router-'));
    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 94) });
    ctx.registry.register(new StubActionService());
    workerProvider = new FakeProvider();
    router = null;
  });

  afterEach(async () => {
    await router?.destroy();
    await ctx.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRouter(context: AppContext, options: RouterServiceOptions = {}): RouterService {
    router = new RouterService(
      context,
      new FakeProvider('warm'),
      workerProvider,
      new MediaContext(),
      options,
    );
    return router;
  }

  /** Drives a full chat turn through the worker path (bypasses 2B routing). */
  async function chatTurn(
    r: RouterService,
    text: string,
    mode: 'chat' | 'voice' = 'chat',
  ): Promise<void> {
    r.activeModel = '9b';
    await r.handleChatMessage(text, mode);
  }

  it('restarts pending curation after a transient user turn cancels its timer', async () => {
    vi.useFakeTimers();
    try {
      ctx.parsedConfig.trust.anonymousEnabled = true;
      const r = makeRouter(ctx);
      await r.init();

      await chatTurn(r, 'Ich interessiere mich für Astronomie.');
      let [staging] = await ctx.db.query<{ attempts: number; state: string }>('memory_staging');
      expect(staging).toMatchObject({ attempts: 0, state: 'pending' });

      await chatTurn(r, '/anonymous');
      await vi.advanceTimersByTimeAsync(30_000);

      [staging] = await ctx.db.query<{ attempts: number; state: string }>('memory_staging');
      expect(staging).toMatchObject({ attempts: 1, state: 'pending' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents an in-flight turn from committing after memory is disabled', async () => {
    let releaseWorker!: () => void;
    let markStarted!: () => void;
    const workerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseWorker = resolve; });
    workerProvider = new FakeProvider('Späte Antwort', async () => {
      markStarted();
      await release;
    });
    const r = makeRouter(ctx);
    await r.init();
    r.activeModel = '9b';

    const pendingTurn = r.handleChatMessage('Diese Frage läuft gerade.');
    await workerStarted;
    ctx.parsedConfig.trust.memoryAllowed = false;
    await r.applyMemoryPolicy({ allowed: false, exclusions: [] });
    releaseWorker();
    await pendingTurn;

    expect(await ctx.db.query('messages')).toEqual([]);
    expect(await ctx.db.query('memory_staging')).toEqual([]);
  });

  it('cancels only an active turn that already recalled content forbidden by the new policy', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' });
    await ctx.db.insert('curated_memories', {
      kind: 'fact',
      content: 'Das Bankkonto ist bei der Sparkasse.',
      source_conversation_id: 1,
      source_turn_id: 'old-finance-turn',
      confidence: 1,
    });
    let releaseWorker!: () => void;
    let markStarted!: () => void;
    const workerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseWorker = resolve; });
    workerProvider = new FakeProvider('Verbotene späte Antwort', async () => {
      markStarted();
      await release;
    });
    const r = makeRouter(ctx);
    const terminal: Array<{ turnId: string; status: string }> = [];
    const completed: string[] = [];
    ctx.bus.on('turn:terminal', (message) => terminal.push(message.data));
    ctx.bus.on('llm:done', (message) => completed.push(message.data.turnId));
    await r.init();
    r.activeModel = '9b';
    const turnId = '31313131-3131-4313-8313-313131313131';
    const pendingTurn = r.handleTurnRequest({
      turnId,
      source: 'chat',
      mode: 'chat',
      originalText: 'Was weißt du über mein Bankkonto?',
      createdAt: new Date().toISOString(),
    });
    await workerStarted;
    expect(workerProvider.lastMessages?.some((message) => message.content.includes('Sparkasse'))).toBe(true);

    ctx.parsedConfig.trust.memoryExclusions = ['Finanzen'];
    await r.applyMemoryPolicy({ allowed: true, exclusions: ['Finanzen'] });

    expect(terminal).toContainEqual({ turnId, status: 'canceled' });
    expect(completed).not.toContain(turnId);
    releaseWorker();
    await pendingTurn;
    await Promise.resolve();
    expect(completed).not.toContain(turnId);
    expect(await ctx.db.query('curated_memories')).toEqual([]);
  });

  it('does not cancel an active recall turn whose recalled content remains allowed', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' });
    await ctx.db.insert('curated_memories', {
      kind: 'preference',
      content: 'Mein Lieblingshobby ist Astronomie.',
      source_conversation_id: 1,
      source_turn_id: 'old-hobby-turn',
      confidence: 1,
    });
    let releaseWorker!: () => void;
    let markStarted!: () => void;
    const workerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseWorker = resolve; });
    workerProvider = new FakeProvider('Astronomie ist spannend.', async () => {
      markStarted();
      await release;
    });
    const r = makeRouter(ctx);
    const terminal: Array<{ turnId: string; status: string }> = [];
    ctx.bus.on('turn:terminal', (message) => terminal.push(message.data));
    await r.init();
    r.activeModel = '9b';
    const turnId = '32323232-3232-4323-8323-323232323232';
    const pendingTurn = r.handleTurnRequest({
      turnId,
      source: 'chat',
      mode: 'chat',
      originalText: 'Was weißt du über mein Lieblingshobby?',
      createdAt: new Date().toISOString(),
    });
    await workerStarted;

    ctx.parsedConfig.trust.memoryExclusions = ['Finanzen'];
    await r.applyMemoryPolicy({ allowed: true, exclusions: ['Finanzen'] });
    expect(terminal.some((entry) => entry.turnId === turnId)).toBe(false);

    releaseWorker();
    await pendingTurn;
    expect(terminal).toContainEqual({ turnId, status: 'done' });
  });

  it('holds a turn started during policy cleanup until sanitized recall is authoritative', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' });
    await ctx.db.insert('curated_memories', {
      kind: 'fact',
      content: 'Das Bankkonto ist bei der Sparkasse.',
      source_conversation_id: 1,
      source_turn_id: 'old-finance-turn',
      confidence: 1,
    });
    let blockMessages = false;
    let markCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const storageOptions: {
      beforeQuery?: (table: string) => Promise<void>;
    } = {
      beforeQuery: async (table) => {
        if (!blockMessages || table !== 'messages') return;
        blockMessages = false;
        markCleanupStarted();
        await cleanupRelease;
      },
    };
    const guardedCtx: AppContext = { ...ctx, db: new FailingStorage(ctx.db, storageOptions) };
    const r = makeRouter(guardedCtx);
    await r.init();
    r.activeModel = '9b';
    blockMessages = true;
    guardedCtx.parsedConfig.trust.memoryExclusions = ['Finanzen'];
    const policyApply = r.applyMemoryPolicy({ allowed: true, exclusions: ['Finanzen'] });
    await cleanupStarted;

    const pendingTurn = r.handleChatMessage('Was weißt du über mein Bankkonto?');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(workerProvider.lastMessages).toBeNull();

    releaseCleanup();
    await policyApply;
    await pendingTurn;

    expect(workerProvider.lastMessages?.some((message) => message.content.includes('Sparkasse'))).toBe(false);
    expect(await ctx.db.query('curated_memories')).toEqual([]);
  });

  it('cancels immediately while a turn is waiting at the memory-policy barrier', async () => {
    let blockMessages = false;
    let markCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const guardedCtx: AppContext = {
      ...ctx,
      db: new FailingStorage(ctx.db, {
        beforeQuery: async (table) => {
          if (!blockMessages || table !== 'messages') return;
          blockMessages = false;
          markCleanupStarted();
          await cleanupRelease;
        },
      }),
    };
    const r = makeRouter(guardedCtx, { memoryPolicyWaitTimeoutMs: 5_000 });
    await r.init();
    r.activeModel = '9b';
    blockMessages = true;
    const policyApply = r.applyMemoryPolicy({ allowed: true, exclusions: ['Finanzen'] });
    await cleanupStarted;
    const turnId = '41414141-4141-4414-8414-414141414141';
    const terminal: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('turn:terminal', (message) => terminal.push(message.data));
    const active = r.handleTurnRequest({
      turnId,
      source: 'chat',
      mode: 'chat',
      originalText: 'Diese Anfrage soll sofort abbrechen.',
      createdAt: new Date().toISOString(),
    });
    const unsubscribeCancel = ctx.bus.on('turn:cancel', (message) => r.onMessage(message));
    await new Promise((resolve) => setTimeout(resolve, 10));

    ctx.bus.emit('test', 'turn:cancel', { turnId, reason: 'barge-in' });
    await expect(Promise.race([
      active.then(() => 'canceled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-waiting'), 200)),
    ])).resolves.toBe('canceled');

    expect(terminal).toContainEqual({ turnId, status: 'canceled' });
    expect(workerProvider.lastMessages).toBeNull();
    unsubscribeCancel();
    releaseCleanup();
    await policyApply;
  });

  it('fails a policy-barrier wait at its injected deadline instead of hanging the turn', async () => {
    let blockMessages = false;
    let markCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const guardedCtx: AppContext = {
      ...ctx,
      db: new FailingStorage(ctx.db, {
        beforeQuery: async (table) => {
          if (!blockMessages || table !== 'messages') return;
          blockMessages = false;
          markCleanupStarted();
          await cleanupRelease;
        },
      }),
    };
    const r = makeRouter(guardedCtx, { memoryPolicyWaitTimeoutMs: 20 });
    await r.init();
    r.activeModel = '9b';
    blockMessages = true;
    const policyApply = r.applyMemoryPolicy({ allowed: true, exclusions: ['Finanzen'] });
    await cleanupStarted;
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));

    await r.handleChatMessage('Diese Anfrage darf nicht hängen.');

    expect(terminals.at(-1)).toMatchObject({ status: 'error' });
    expect(workerProvider.lastMessages).toBeNull();
    releaseCleanup();
    await policyApply;
  });

  it('does not commit storage or live history when cancellation wins in the memory-mutation queue', async () => {
    const r = makeRouter(ctx);
    await r.init();
    r.activeModel = '9b';
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const blocker = (r as unknown as {
      runMemoryMutation: (operation: () => Promise<void>) => Promise<void>;
    }).runMemoryMutation(() => mutationGate);
    const turnId = '42424242-4242-4424-8424-424242424242';
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));
    const outputDone = new Promise<void>((resolve) => {
      const unsubscribe = ctx.bus.on('llm:done', (message) => {
        if (message.data.turnId !== turnId) return;
        unsubscribe();
        resolve();
      });
    });
    const active = r.handleTurnRequest({
      turnId,
      source: 'chat',
      mode: 'chat',
      originalText: 'Dieser Turn wartet vor dem Commit.',
      createdAt: new Date().toISOString(),
    });
    const unsubscribeCancel = ctx.bus.on('turn:cancel', (message) => r.onMessage(message));
    await outputDone;
    await vi.waitFor(() => {
      const drafts = (r as unknown as {
        turnDrafts: Map<string, { commitStarted: boolean }>;
      }).turnDrafts;
      expect(drafts.get(turnId)?.commitStarted).toBe(true);
    });

    ctx.bus.emit('test', 'turn:cancel', { turnId, reason: 'cancel-during-commit' });
    await active;

    expect(terminals.filter((entry) => entry.turnId === turnId)).toEqual([
      { turnId, status: 'canceled' },
    ]);
    expect(r.liveHistoryTurnCount).toBe(0);
    expect(await ctx.db.query('messages')).toEqual([]);
    expect(await ctx.db.query('memory_staging')).toEqual([]);
    unsubscribeCancel();
    releaseMutation();
    await blocker;
    await (r as unknown as { memoryMutationQueue: Promise<void> }).memoryMutationQueue;
    expect(await ctx.db.query('messages')).toEqual([]);
    expect(await ctx.db.query('memory_staging')).toEqual([]);
  });

  it('removes the exact incognito turns even when policy cleanup deletes earlier history', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Meine Bank hat mein Konto gesperrt.');
    await chatTurn(r, '/anonymous');
    ctx.parsedConfig.trust.memoryExclusions = ['Finanzen'];
    await r.applyMemoryPolicy({ allowed: true, exclusions: ['Finanzen'] });
    await chatTurn(r, 'Mein privater Codename ist Eule.');
    await chatTurn(r, '/anonymous');
    await chatTurn(r, 'Welche Nachricht kam vor dieser Frage?');

    expect(workerProvider.lastMessages?.some((message) => message.content.includes('Codename ist Eule'))).toBe(false);
  });

});
