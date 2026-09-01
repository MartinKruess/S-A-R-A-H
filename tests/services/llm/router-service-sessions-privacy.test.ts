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

describe('RouterService (sessions & privacy)', () => {
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

  it('creates exactly one conversation per boot, even with a double init() call (H3)', async () => {
    const r = makeRouter(ctx);
    await Promise.all([r.init(), r.init()]);
    await r.init();

    const rows = await ctx.db.query('conversations');
    expect(rows).toHaveLength(1);
  });

  it('persists both turn messages under the boot session id, not the legacy id 1', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' }); // occupy id 1 (old session)
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Hallo Sarah');

    const msgs = await ctx.db.query<{ conversation_id: number; role: string; content: string }>('messages');
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.role).sort()).toEqual(['assistant', 'user']);
    for (const m of msgs) {
      expect(m.conversation_id).toBe(2);
    }
  });

  it('stays registered while ModelRuntime recovers from an initial router outage', async () => {
    router = new RouterService(ctx, new UnavailableProvider(), workerProvider);

    await router.init();

    expect(router.status).toBe('running');
  });

  it('keeps the initial router error truthful and publishes recovery through the lifecycle', async () => {
    vi.useFakeTimers();
    try {
      const modelRuntime = new ModelRuntime({
        config: ctx.parsedConfig.llm,
        routerProvider: new RecoveringProvider(),
        workerProvider,
        eagerLoadTransitions: false,
        runtimeRecheckDelayMs: 5_000,
        onCapability: (name, state, message) => {
          ctx.lifecycle.setCapability(name, state, message);
        },
      });
      router = new RouterService(ctx, modelRuntime);
      ctx.registry.register(router);

      const initial = await ctx.lifecycle.start();

      expect(initial.state).toBe('degraded');
      expect(initial.capabilities.router).toMatchObject({ state: 'unavailable' });

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => {
        expect(ctx.lifecycle.snapshot.capabilities.router).toEqual({ state: 'ready' });
      });
      expect(ctx.lifecycle.snapshot.state).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps history in memory but neither loads nor persists it when memory is disabled', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' });
    await ctx.db.insert('messages', { conversation_id: 1, turn_id: 'old-secret', role: 'user', content: 'Altes Geheimnis' });
    ctx.parsedConfig.trust.memoryAllowed = false;
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, 'Erste flüchtige Frage');
    await chatTurn(r, 'Zweite flüchtige Frage');

    const sent = workerProvider.lastMessages ?? [];
    expect(sent.some((message) => message.content === 'Altes Geheimnis')).toBe(false);
    expect(sent.some((message) => message.content === 'Erste flüchtige Frage')).toBe(true);
    expect(await ctx.db.query('messages')).toHaveLength(1);
  });

  it('processes /anonymous transiently without persisting either side of the turn', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, '/anonymous Mein Codename ist Eule');
    expect(await ctx.db.query('messages')).toHaveLength(0);

    await chatTurn(r, 'Was war meine vorige Nachricht?');
    const sent = workerProvider.lastMessages ?? [];
    expect(sent.some((message) => message.content === 'Mein Codename ist Eule')).toBe(true);
    expect(sent.some((message) => message.content.startsWith('/anonymous'))).toBe(false);
    // The follow-up consumed transient information, so its derived answer must
    // remain transient as well instead of laundering the anonymous content.
    expect(await ctx.db.query('messages')).toHaveLength(0);

    await chatTurn(r, 'Dritte unabhängige Frage');
    const thirdSent = workerProvider.lastMessages ?? [];
    expect(thirdSent.some((message) => message.content.includes('Codename ist Eule'))).toBe(false);
    expect(thirdSent.some((message) => message.content === 'Was war meine vorige Nachricht?')).toBe(false);
    expect(await ctx.db.query('messages')).toHaveLength(2);
  });

  it('does not poison later persistence when one-shot Anonymous is disabled', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = false;
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, '/anonymous Diese Nachricht wird abgelehnt');
    await chatTurn(r, 'Normale persistierbare Frage');

    const messages = await ctx.db.query<{ content: string }>('messages');
    expect(messages.map((message) => message.content)).toEqual([
      'Normale persistierbare Frage',
      'Antwort von Sarah',
    ]);
  });

  it('keeps an anonymous follow-up live and transient when the answer budget would trim its source', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    ctx.parsedConfig.trust.memoryExclusions = [];
    ctx.parsedConfig.personalization.responseStyle = 'ausführlich';
    workerProvider = new FakeProvider('Das Testwort ist Eule-482.');
    const r = makeRouter(ctx);
    await r.init();

    await chatTurn(r, '/anonymous Mein einmaliges Testwort lautet Eule-482. Merke es dir.');
    (workerProvider as unknown as { reply: string }).reply = 'Dein einmaliges Testwort ist Eule-482.';
    await chatTurn(r, 'Wie lautet mein einmaliges Testwort?');

    expect(workerProvider.lastMessages?.some((message) => (
      message.content === 'Mein einmaliges Testwort lautet Eule-482. Merke es dir.'
    ))).toBe(true);
    expect(await ctx.db.query('messages')).toEqual([]);
    expect(await ctx.db.query('memory_staging')).toEqual([]);
    expect(await ctx.db.query('curated_memories')).toEqual([]);
  });

  it('buffers and redacts an exact secret echo, then keeps the secret out of later live context', async () => {
    workerProvider = new FakeProvider('Du hast Sommer2024! als Passwort genannt.');
    const r = makeRouter(ctx);
    await r.init();
    const chunks: string[] = [];
    const done: string[] = [];
    const unsubscribeChunk = ctx.bus.on('llm:chunk', (message) => chunks.push(message.data.text));
    const unsubscribeDone = ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await chatTurn(r, 'Mein Passwort lautet Sommer2024!');

    expect(chunks).toEqual(['Du hast [VERTRAULICHE_DATEN] als Passwort genannt.']);
    expect(done).toEqual(['Du hast [VERTRAULICHE_DATEN] als Passwort genannt.']);
    expect(await ctx.db.query('messages')).toEqual([]);

    (workerProvider as unknown as { reply: string }).reply = 'Unabhängige Antwort.';
    await chatTurn(r, 'Neue unabhängige Frage');
    expect(workerProvider.lastMessages?.some((message) => message.content.includes('Sommer2024!'))).toBe(false);
    expect(workerProvider.lastMessages?.some((message) => (
      message.content.includes('[VERTRAULICHE_DATEN]')
    ))).toBe(true);

    unsubscribeChunk();
    unsubscribeDone();
  });

  it('preserves retained Layer-2 data when memory was disabled by config recovery', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' });
    await ctx.db.insert('messages', {
      conversation_id: 1,
      turn_id: 'retained-after-recovery',
      role: 'user',
      content: 'Bestehende Erinnerung',
    });
    ctx.parsedConfig.trust.memoryAllowed = false;
    ctx.memoryRecoveryGuardActive = true;
    const r = makeRouter(ctx);

    await r.init();
    await chatTurn(r, 'Diese Frage bleibt flüchtig');

    const messages = await ctx.db.query<{ turn_id: string }>('messages');
    expect(messages.map((message) => message.turn_id)).toEqual(['retained-after-recovery']);
    expect(workerProvider.lastMessages?.some((message) => message.content === 'Bestehende Erinnerung')).toBe(false);
  });

  it('keeps opt-out non-destructive after recovery memory is explicitly enabled', async () => {
    await ctx.db.insert('conversations', { mode: 'ambient' });
    await ctx.db.insert('messages', {
      conversation_id: 1,
      turn_id: 'retained-until-opt-out',
      role: 'user',
      content: 'Bestehende Erinnerung',
    });
    ctx.parsedConfig.trust.memoryAllowed = false;
    ctx.memoryRecoveryGuardActive = true;
    const r = makeRouter(ctx);
    await r.init();

    ctx.parsedConfig.trust.memoryAllowed = true;
    await r.applyMemoryPolicy({ allowed: true, exclusions: [] });
    expect(ctx.memoryRecoveryGuardActive).toBe(false);

    ctx.parsedConfig.trust.memoryAllowed = false;
    await r.applyMemoryPolicy({ allowed: false, exclusions: [] });
    expect(await ctx.db.query('messages')).toHaveLength(1);
  });

  it('clears a stale recovery guard after a successful enabled-memory boot', async () => {
    ctx.memoryRecoveryGuardActive = true;
    await ctx.config.set('layer2MemoryRecoveryGuard', true);
    const r = makeRouter(ctx);

    await r.init();

    expect(ctx.memoryRecoveryGuardActive).toBe(false);
    expect(await ctx.config.get('layer2MemoryRecoveryGuard')).toBe(false);
  });

  it('blocks explicit remember intent inside a one-shot /anonymous turn', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    const r = makeRouter(ctx);
    const outputs: string[] = [];
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));
    await r.init();

    await chatTurn(r, '/anonymous Merk dir: Mein Codename ist Eule.');

    expect(outputs.at(-1)).toContain('privaten Nachricht');
    expect(await ctx.db.query('curated_memories')).toEqual([]);
    expect(await ctx.db.query('memory_staging')).toEqual([]);
    expect(await ctx.db.query('messages')).toEqual([]);
  });

  it('keeps /anonymous active across turns and model switches until explicit exit', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    const r = makeRouter(ctx);
    const privacyStates: boolean[] = [];
    ctx.bus.on('privacy:incognito', (message) => privacyStates.push(message.data.active));
    await r.init();

    await chatTurn(r, '/anonymous');
    r.activeModel = '2b';
    r.activeModel = '9b';
    await chatTurn(r, 'Mein privater Codename ist Eule.');
    await chatTurn(r, 'Erkläre mir mehr dazu.');
    await chatTurn(r, 'Merk dir den Codenamen bitte.');

    expect(await ctx.db.query('messages')).toHaveLength(0);
    expect(await ctx.db.query('memory_staging')).toHaveLength(0);
    expect(await ctx.db.query('curated_memories')).toHaveLength(0);
    expect(workerProvider.lastMessages?.some((message) => message.content.includes('Codename ist Eule'))).toBe(true);

    await chatTurn(r, '/anonymous');
    await chatTurn(r, 'Normale Frage nach Anonymous');

    expect(privacyStates).toEqual([true, false]);
    expect(workerProvider.lastMessages?.some((message) => message.content.includes('Codename ist Eule'))).toBe(false);
    expect(await ctx.db.query('messages')).toHaveLength(2);
  });

  it('prewarms the local worker exactly once when Anonymous mode is activated', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    const r = makeRouter(ctx);
    await r.init();
    const ensureRole = vi.spyOn(ModelRuntime.prototype, 'ensureRole').mockResolvedValue();

    try {
      await chatTurn(r, '/anonymous');

      expect(ensureRole).toHaveBeenCalledTimes(1);
      expect(ensureRole).toHaveBeenCalledWith('local_worker');
    } finally {
      ensureRole.mockRestore();
    }
  });

  it('does not prewarm the local worker when Anonymous mode is deactivated', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    const r = makeRouter(ctx);
    await r.init();
    const ensureRole = vi.spyOn(ModelRuntime.prototype, 'ensureRole').mockResolvedValue();

    try {
      await chatTurn(r, '/anonymous');
      ensureRole.mockClear();
      await chatTurn(r, '/anonymous');

      expect(ensureRole).not.toHaveBeenCalled();
    } finally {
      ensureRole.mockRestore();
    }
  });

  it('keeps Anonymous mode active when its worker prewarm fails', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    const r = makeRouter(ctx);
    const outputs: string[] = [];
    const privacyStates: boolean[] = [];
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));
    ctx.bus.on('privacy:incognito', (message) => privacyStates.push(message.data.active));
    await r.init();
    const ensureRole = vi.spyOn(ModelRuntime.prototype, 'ensureRole')
      .mockRejectedValue(new Error('prewarm unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await chatTurn(r, '/anonymous');
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          '[Router] Anonymous worker prewarm failed; continuing without prewarm',
        );
      });

      expect(outputs.at(-1)).toBe(
        'Anonymous-Modus aktiviert. Dieser Abschnitt wird nicht gespeichert. Mit /anonymous beendest du ihn wieder.',
      );
      expect(r.privacyState).toEqual({ incognitoActive: true });
      expect(privacyStates).toEqual([true]);
    } finally {
      warn.mockRestore();
      ensureRole.mockRestore();
    }
  });

  it('allows an active incognito section to end after the setting was disabled', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    const r = makeRouter(ctx);
    const privacyStates: boolean[] = [];
    ctx.bus.on('privacy:incognito', (message) => privacyStates.push(message.data.active));
    await r.init();

    await chatTurn(r, '/anonymous');
    await chatTurn(r, 'Privater Inhalt');
    ctx.parsedConfig.trust.anonymousEnabled = false;
    await chatTurn(r, '/anonymous');
    await chatTurn(r, 'Wieder öffentlich');

    expect(privacyStates).toEqual([true, false]);
    const messages = await ctx.db.query<{ content: string }>('messages');
    expect(messages.some((message) => message.content.includes('Privater Inhalt'))).toBe(false);
    expect(messages.some((message) => message.content === 'Wieder öffentlich')).toBe(true);
  });

  it('discards private search sessions when the incognito section ends', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    const routerProvider = new ScriptedProvider('ok', '[ACTION:web_search:private hotels]');
    router = new RouterService(ctx, routerProvider, new ScriptedProvider('worker'));
    const discarded: string[] = [];
    ctx.bus.on('search:discard-session', (message) => discarded.push(message.data.requestId));
    ctx.bus.on('action:result', (message) => router?.onMessage(message));
    await router.init();

    await chatTurn(router, '/anonymous');
    router.activeModel = '2b';
    const requests: BusEvents['action:request'][] = [];
    ctx.bus.on('action:request', (message) => { requests.push(message.data); });
    const { request: searchRequest, actionTurn: privateTurn } = await startAction(
      ctx,
      router,
      'Suche private Hotels',
    );
    expect(requests).toHaveLength(1);
    if (!searchRequest) throw new Error('Expected private web search request');
    ctx.bus.emit('test', 'action:result', {
      turnId: searchRequest.turnId,
      requestId: searchRequest.requestId,
      action: 'web_search',
      ok: true,
      speak: 'Ein privater Treffer.',
    });
    await privateTurn;
    expect(discarded).toEqual([]);

    await chatTurn(router, '/anonymous');

    expect(discarded).toEqual([searchRequest.requestId]);
  });

});
