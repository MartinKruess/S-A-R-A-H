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
  completeActionTurn,
  startAction,
} from './router-service-test-harness.js';

describe('RouterService (actions & confirmation)', () => {
  let tmpDir: string;
  let ctx: AppContext;
  let router: RouterService | null = null;
  let actionService: StubActionService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-router-action-'));
    ctx = await bootstrap(tmpDir, { testWrappingKey: Buffer.alloc(32, 94) });
    router = null;
    actionService = new StubActionService();
    ctx.registry.register(actionService);
    // The test harness never registers RouterService with ctx.registry (that
    // wiring is ServiceRegistry's job in production, see main.ts). Forward the
    // two new correlation topics to whichever router the current test created.
    ctx.bus.on('action:result', (msg) => router?.onMessage(msg));
    ctx.bus.on('action:notify', (msg) => router?.onMessage(msg));
    ctx.bus.on('turn:cancel', (msg) => router?.onMessage(msg));
    ctx.bus.on('turn:terminal', (msg) => router?.onMessage(msg));
  });

  afterEach(async () => {
    await router?.destroy();
    await ctx.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runActionTurn(
    text: string,
    result: { ok?: boolean; speak?: string } = {},
  ): Promise<BusEvents['action:request']> {
    if (!router) throw new Error('router not initialized');
    return completeActionTurn(ctx, router, text, result);
  }

  it('emits action:request with a fresh requestId and speaks fixed code feedback', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:open_program:spotify]'); // 1. Reply = warmup
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();

    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (msg) => {
      requests.push(msg.data);
    });
    ctx.bus.on('llm:done', (msg) => {
      done.push(msg.data.fullText);
    });

    await runActionTurn('Öffne Spotify');

    expect(requests).toHaveLength(1);
    expect(requests[0].action).toBe('open_program');
    expect(requests[0].param).toBe('spotify');
    expect(requests[0].provenance).toMatchObject({
      sourceTurnId: requests[0].turnId,
      decisionSource: 'router_model',
      evidenceSource: 'user_text',
      validation: 'schema_only',
    });
    expect(requests[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(done).toEqual(['Ich öffne Spotify.']);
    const msgs = await ctx.db.query<{ role: string; content: string }>('messages');
    expect(msgs.map((m) => m.content)).toContain('Ich öffne Spotify.'); // feedback persisted as assistant turn
  });

  it('requires and correlates an exact one-time confirmation for mutating actions at maximal level', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'maximal';
    const routerP = new ScriptedProvider('ok', '[ACTION:open_program:spotify]');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const outputs: BusEvents['llm:done'][] = [];
    const confirmationOrder: string[] = [];
    ctx.bus.on('action:request', (message) => {
      requests.push(message.data);
      confirmationOrder.push('request');
    });
    ctx.bus.on('llm:done', (message) => {
      outputs.push(message.data);
      if (message.data.fullText.startsWith('Ich öffne')) confirmationOrder.push('acknowledgement');
    });
    const requestedTurnId = '83838383-8383-4383-8383-838383838383';

    await router.handleTurnRequest({
      turnId: requestedTurnId,
      source: 'chat',
      mode: 'chat',
      originalText: 'Öffne Spotify',
      createdAt: new Date().toISOString(),
    });

    expect(requests).toEqual([]);
    expect(outputs[0].fullText).toContain('Programm „Spotify“ öffnen');
    expect(outputs[0].fullText).toContain('„Bestätigen“ oder „Abbrechen“');
    const confirmationId = outputs[0].fullText.match(/\/confirm ([0-9a-f-]{36})/)?.[1];
    expect(confirmationId).toBeDefined();

    const confirmationTurnId = '84848484-8484-4484-8484-848484848484';
    const confirmationTurn = router.handleTurnRequest({
      turnId: confirmationTurnId,
      source: 'chat',
      mode: 'chat',
      originalText: `/confirm ${confirmationId}`,
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(confirmationOrder).toEqual(['acknowledgement', 'request']);
    expect(requests[0]).toMatchObject({
      turnId: confirmationTurnId,
      action: 'open_program',
      param: 'spotify',
      confirmation: {
        confirmationId,
        requestedTurnId,
      },
    });
    ctx.bus.emit('test', 'action:result', {
      turnId: confirmationTurnId,
      requestId: requests[0].requestId,
      action: requests[0].action,
      ok: true,
    });
    await confirmationTurn;

    const persistedTurns = await ctx.db.query<{ turn_id: string }>('messages');
    expect(new Set(persistedTurns.map((message) => message.turn_id))).toEqual(new Set([
      requestedTurnId,
      confirmationTurnId,
    ]));
    expect(await ctx.db.query('memory_staging')).toHaveLength(2);

    await router.handleChatMessage(`/confirm ${confirmationId}`);
    expect(requests).toHaveLength(1);
  });

  it('fails quickly and honestly before emit when the registered ActionService is unavailable', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:open_program:spotify]');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    actionService.status = 'stopped';
    const requests: BusEvents['action:request'][] = [];
    const outputs: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));

    await router.handleChatMessage('Öffne Spotify');

    expect(requests).toEqual([]);
    expect(outputs).toEqual([
      'Aktionen sind gerade nicht verfügbar. Bitte versuche es gleich noch einmal.',
    ]);
  });

  it('cancels an unanswered action at the injected result deadline', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:open_program:spotify]');
    router = new RouterService(
      ctx,
      routerP,
      new ScriptedProvider(),
      new MediaContext(),
      { actionResultTimeoutMs: 20 },
    );
    await router.init();
    const cancellations: BusEvents['action:cancel'][] = [];
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('action:cancel', (message) => cancellations.push(message.data));
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));

    await router.handleChatMessage('Öffne Spotify');

    expect(cancellations).toHaveLength(1);
    expect(cancellations[0].reason).toBe('Action timed out');
    expect(terminals.at(-1)).toMatchObject({ status: 'error' });
  });

  it('accepts an immediate natural spoken confirmation', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'maximal';
    const routerP = new ScriptedProvider(
      'ok',
      '[ACTION:open_program:spotify]',
    );
    router = new RouterService(ctx, routerP, new ScriptedProvider('Keine Aktion.'));
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const outputs: string[] = [];
    const spokenOnly: string[] = [];
    const speechPolicies: BusEvents['turn:output-policy'][] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));
    ctx.bus.on('llm:filler', (message) => spokenOnly.push(message.data.text));
    ctx.bus.on('turn:output-policy', (message) => speechPolicies.push(message.data));

    await router.handleChatMessage('Öffne Spotify', 'voice');
    expect(outputs[0]).toContain('„Bestätigen“ oder „Abbrechen“');
    expect(outputs[0]).toMatch(/\/confirm [0-9a-f-]{36}/);
    expect(spokenOnly).toEqual([
      'Soll ich das Programm „Spotify“ öffnen? Sage oder schreibe „Bestätigen“ oder „Abbrechen“.',
    ]);
    expect(spokenOnly[0]).not.toContain('/confirm');
    expect(speechPolicies).toHaveLength(1);

    const confirmationTurn = router.handleChatMessage(
      'Ja, ich bestätige das.',
      'voice',
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    ctx.bus.emit('test', 'action:result', {
      turnId: requests[0].turnId,
      requestId: requests[0].requestId,
      action: requests[0].action,
      ok: true,
    });
    await confirmationTurn;
  });

  it('expires natural confirmation authority on the first unrelated turn', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'maximal';
    const routerP = new ScriptedProvider(
      'ok',
      '[ACTION:open_program:spotify]',
      '[ROUTE:9b]',
    );
    router = new RouterService(ctx, routerP, new ScriptedProvider('Keine Aktion.'));
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));

    await router.handleChatMessage('Öffne Spotify', 'voice');
    await router.handleChatMessage('Wie heiße ich?', 'voice');
    await router.handleChatMessage('Ja', 'voice');

    expect(requests).toEqual([]);
  });

  it('cancels the single pending action through a natural voice phrase', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'maximal';
    router = new RouterService(
      ctx,
      new ScriptedProvider('ok', '[ACTION:set_timer:10]'),
      new ScriptedProvider(),
    );
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const outputs: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));

    await router.handleChatMessage('Stell einen Timer auf 10 Minuten', 'voice');
    await router.handleChatMessage('Bitte abbrechen', 'voice');

    expect(requests).toEqual([]);
    expect(outputs.at(-1)).toBe('Die Aktion wurde abgebrochen.');
  });

  it('invalidates a completed proposal if its requested turn is canceled later', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'maximal';
    router = new RouterService(
      ctx,
      new ScriptedProvider('ok', '[ACTION:open_program:spotify]'),
      new ScriptedProvider(),
    );
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const outputs: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));
    const proposalTurnId = '87878787-8787-4787-8787-878787878787';

    await router.handleTurnRequest({
      turnId: proposalTurnId,
      source: 'chat',
      mode: 'chat',
      originalText: 'Öffne Spotify',
      createdAt: new Date().toISOString(),
    });
    const confirmationId = outputs[0].match(/\/confirm ([0-9a-f-]{36})/)?.[1];
    if (!confirmationId) throw new Error('expected confirmation id');

    ctx.bus.emit('test', 'turn:cancel', {
      turnId: proposalTurnId,
      reason: 'late cancellation',
    });

    await router.handleChatMessage(`/confirm ${confirmationId}`);
    expect(requests).toEqual([]);
  });

  it('restores an approval when confirmation is canceled before action dispatch', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'maximal';
    router = new RouterService(
      ctx,
      new ScriptedProvider('ok', '[ACTION:open_program:spotify]'),
      new ScriptedProvider(),
    );
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const outputs: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));

    await router.handleChatMessage('Öffne Spotify');
    const confirmationId = outputs[0].match(/\/confirm ([0-9a-f-]{36})/)?.[1];
    if (!confirmationId) throw new Error('expected confirmation id');

    let canceledAcknowledgement = false;
    const stop = ctx.bus.on('llm:done', (message) => {
      if (canceledAcknowledgement || !message.data.fullText.startsWith('Ich öffne Spotify')) return;
      canceledAcknowledgement = true;
      ctx.bus.emit('test', 'turn:cancel', {
        turnId: message.data.turnId,
        reason: 'cancel before action request',
      });
    });
    await router.handleChatMessage(`/confirm ${confirmationId}`);
    stop();
    expect(canceledAcknowledgement).toBe(true);
    expect(requests).toEqual([]);

    const retry = router.handleChatMessage(`/confirm ${confirmationId}`);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    ctx.bus.emit('test', 'action:result', {
      turnId: requests[0].turnId,
      requestId: requests[0].requestId,
      action: requests[0].action,
      ok: true,
    });
    await retry;
  });

  it('runs a persistently allowed search without confirmation and keeps excluded browser data transient', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'maximal';
    ctx.parsedConfig.trust.memoryExclusions = ['Browser-Daten'];
    const routerP = new ScriptedProvider('ok', '[ACTION:web_search:hotels kiel]');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const outputs: BusEvents['llm:done'][] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => outputs.push(message.data));
    const requestedTurnId = '85858585-8585-4585-8585-858585858585';

    const searchTurn = router.handleTurnRequest({
      turnId: requestedTurnId,
      source: 'chat',
      mode: 'chat',
      originalText: 'Such Hotels in Kiel',
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(outputs.some((output) => output.fullText.includes('/confirm'))).toBe(false);
    ctx.bus.emit('test', 'action:result', {
      turnId: requestedTurnId,
      requestId: requests[0].requestId,
      action: 'web_search',
      ok: true,
    });
    await searchTurn;

    expect(await ctx.db.query('messages')).toEqual([]);
    expect(await ctx.db.query('memory_staging')).toEqual([]);
  });

  it('keeps an action turn open after acknowledgement until its correlated result completes', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:open_program:spotify]');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const done: string[] = [];
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));
    let resolveRequest = (_request: BusEvents['action:request']): void => {};
    const requestSeen = new Promise<BusEvents['action:request']>((resolve) => { resolveRequest = resolve; });
    ctx.bus.on('action:request', (message) => resolveRequest(message.data));

    const active = router.handleChatMessage('Öffne Spotify', 'voice');
    const request = await requestSeen;
    await vi.waitFor(() => expect(done).toEqual(['Ich öffne Spotify.']));

    expect(terminals.filter((terminal) => terminal.turnId === request.turnId)).toHaveLength(0);
    expect(ctx.bus.isTurnOpen(request.turnId)).toBe(true);
    ctx.bus.emit('test', 'action:result', {
      turnId: request.turnId,
      requestId: request.requestId,
      action: request.action,
      ok: true,
      speak: 'Spotify wurde geöffnet.',
    });
    await active;

    expect(done).toEqual(['Ich öffne Spotify.', 'Spotify wurde geöffnet.']);
    expect(terminals.filter((terminal) => terminal.turnId === request.turnId)).toEqual([
      { turnId: request.turnId, status: 'done' },
    ]);
  });

});
