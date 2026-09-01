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

describe('RouterService (context & persistence)', () => {
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

  it('passes the authoritative user name and fixed Du address to the worker system prompt', async () => {
    ctx.parsedConfig.profile.displayName = 'Martin';
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Was weißt du über mich?');

    const systemPrompt = workerProvider.lastMessages?.[0].content;
    expect(systemPrompt).toContain('"preferred_name":"Martin"');
    expect(systemPrompt).toContain('"german_address_style":"informal_du"');
    expect(systemPrompt).toContain('always use informal du/dir/dein');
    expect(systemPrompt).toContain('unless the user asks about their name');
  });

  it('uses the voice prompt for a typed request whose source remains chat', async () => {
    const r = makeRouter(ctx);
    await r.init();
    r.activeModel = '9b';
    const request: TurnRequest = {
      turnId: '12121212-1212-4212-8212-121212121212',
      source: 'chat',
      mode: 'voice',
      originalText: 'Antworte mir gesprochen',
      createdAt: new Date().toISOString(),
    };

    await r.handleTurnRequest(request);

    const systemPrompt = workerProvider.lastMessages?.[0].content;
    expect(systemPrompt).toContain('This is a voice conversation.');
    expect(systemPrompt).toContain('plain spoken words');
  });

  it('feeds the start context to the worker as a transient block, never persisting it (H5)', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' }); // old session, id 1
    await ctx.db.insert('curated_memories', {
      kind: 'episode', content: 'alte kuratierte Erinnerung', source_conversation_id: 1,
      source_turn_id: 'old-turn', confidence: 0.9,
    });
    await ctx.db.insert('curated_memories', {
      kind: 'preference', content: 'Lieblingssport ist Fußball', source_conversation_id: 1,
      source_turn_id: 'newer-unrelated-turn', confidence: 1,
    });
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Was weißt du über die alte Erinnerung?');

    const sent = workerProvider.lastMessages;
    expect(sent).not.toBeNull();
    expect(sent![0].role).toBe('system'); // main system prompt
    expect(sent![1].role).toBe('system');
    expect(sent![1].content).toBe(START_CONTEXT_HEADER);
    expect(sent![2].content).toMatch(
      /^SARAH_DATA recalled_memory_data \{"id":\d+,"kind":"episode","topic":"Unsortiert","revision":1,"createdAt":"[^"]+","content":"alte kuratierte Erinnerung"\}$/,
    );
    expect(sent![3]).toEqual({ role: 'user', content: 'Was weißt du über die alte Erinnerung?' });
    expect(sent!.some((message) => message.content === 'Kontext erfasst.')).toBe(false);
    expect(sent!.some((message) => message.content.includes('Fußball'))).toBe(false);

    // Curated start context was NOT re-persisted: only the new turn is raw staging input.
    const msgs = await ctx.db.query('messages');
    expect(msgs).toHaveLength(2);
  });

  it('skips an oversized recalled memory while retaining a smaller relevant hit', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' });
    await ctx.db.insert('curated_memories', {
      kind: 'episode',
      content: `Quasararchiv Projekt ${'x'.repeat(3_000)}`,
      source_conversation_id: 1,
      source_turn_id: 'oversized-recall',
      confidence: 1,
    });
    await ctx.db.insert('curated_memories', {
      kind: 'preference',
      content: 'Quasararchiv kurz',
      source_conversation_id: 1,
      source_turn_id: 'compact-recall',
      confidence: 1,
    });
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Was weißt du über das Quasararchiv Projekt?');

    const sent = workerProvider.lastMessages ?? [];
    expect(sent.some((message) => message.content.includes('Quasararchiv kurz'))).toBe(true);
    expect(sent.some((message) => message.content.includes('oversized-recall'))).toBe(false);
    expect(sent.some((message) => message.content.includes('x'.repeat(200)))).toBe(false);
  });

  it('answers in-memory with exactly one visible warning when the session insert fails (H4)', async () => {
    const degradedCtx: AppContext = { ...ctx, db: new FailingStorage(ctx.db, { failInsertTables: ['conversations'] }) };
    const r = makeRouter(degradedCtx);
    await r.init();

    expect(degradedCtx.lifecycle.snapshot.capabilities.storage).toMatchObject({ state: 'degraded' });

    const warnings: string[] = [];
    const done: string[] = [];
    ctx.bus.on('storage:degraded', () => {
      warnings.push('w');
    });
    ctx.bus.on('llm:done', () => {
      done.push('d');
    });

    await chatTurn(r, 'Erste Frage');
    await chatTurn(r, 'Zweite Frage');

    expect(done).toHaveLength(2); // both answers arrived
    expect(warnings).toHaveLength(1); // warning exactly once
    expect(await ctx.db.query('messages')).toHaveLength(0); // inserts skipped
  });

  it('keeps the answer flowing when a message insert fails (H4)', async () => {
    const degradedCtx: AppContext = { ...ctx, db: new FailingStorage(ctx.db, { failInsertTables: ['messages'] }) };
    const r = makeRouter(degradedCtx);
    await r.init();

    const warnings: string[] = [];
    const done: string[] = [];
    ctx.bus.on('storage:degraded', () => {
      warnings.push('w');
    });
    ctx.bus.on('llm:done', () => {
      done.push('d');
    });

    await chatTurn(r, 'Frage trotz kaputter DB');
    await chatTurn(r, 'Noch eine');

    expect(degradedCtx.lifecycle.snapshot.capabilities.storage).toMatchObject({ state: 'degraded' });
    expect(done).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    // in-memory history stayed complete: second turn carried the first turn's messages
    const sent = workerProvider.lastMessages!;
    expect(sent.some((m) => m.content === 'Frage trotz kaputter DB')).toBe(true);
    expect(sent.some((m) => m.content === 'Antwort von Sarah')).toBe(true);
  });

  it('boots with an empty start context when DB reads fail, and still answers', async () => {
    const degradedCtx: AppContext = { ...ctx, db: new FailingStorage(ctx.db, { failReads: true }) };
    const r = makeRouter(degradedCtx);
    await r.init();

    const done: string[] = [];
    ctx.bus.on('llm:done', () => {
      done.push('d');
    });
    await chatTurn(r, 'Hallo');

    expect(done).toHaveLength(1);
    const sent = workerProvider.lastMessages!;
    expect(sent.some((m) => m.content === START_CONTEXT_HEADER)).toBe(false);
  });

  it('recalls a relevant memory beyond the former newest-200 cache boundary', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' });
    await ctx.db.insert('curated_memories', {
      kind: 'preference', content: 'Mein seltenes Stichwort ist Quasararchiv.', source_conversation_id: 1,
      source_turn_id: 'old-relevant-turn', confidence: 1,
    });
    for (let index = 0; index < 200; index += 1) {
      await ctx.db.insert('curated_memories', {
        kind: 'episode', content: `Unabhängige Erinnerung Nummer ${index}.`, source_conversation_id: 1,
        source_turn_id: `newer-${index}`, confidence: 0.8,
      });
    }
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Was weißt du über mein Quasararchiv?');

    expect(workerProvider.lastMessages?.some((message) => message.content.includes('Quasararchiv'))).toBe(true);
  });

  it('rejects a failed policy cleanup instead of reporting a successful apply', async () => {
    const degradedCtx: AppContext = { ...ctx, db: new FailingStorage(ctx.db, { failReads: true }) };
    const r = makeRouter(degradedCtx);
    await r.init();

    expect(degradedCtx.lifecycle.snapshot.capabilities.storage).toMatchObject({ state: 'degraded' });

    await expect(r.applyMemoryPolicy({ allowed: true, exclusions: ['Finanzen'] })).rejects.toMatchObject({
      name: 'MemoryPolicyApplyError',
      code: 'MEMORY_POLICY_APPLY_FAILED',
    });
  });
});
