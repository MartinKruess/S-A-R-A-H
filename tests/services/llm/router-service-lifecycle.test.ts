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

describe('RouterService (resume & lifecycle)', () => {
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

  it('resumes a paused voice buffer locally without model output or persistence', async () => {
    const voice = new StubVoiceService(true);
    ctx.registry.register(voice);
    const routerProvider = new ScriptedProvider('should not run');
    const workerProvider = new ScriptedProvider('should not run');
    router = new RouterService(ctx, routerProvider, workerProvider);
    await router.init();
    const routerCallsBeforeResume = routerProvider.calls;
    const workerCallsBeforeResume = workerProvider.calls;
    const resumed: BusEvents['voice:resume-speech'][] = [];
    const outputs: BusEvents['llm:done'][] = [];
    const policies: BusEvents['turn:output-policy'][] = [];
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('voice:resume-speech', (message) => resumed.push(message.data));
    ctx.bus.on('llm:done', (message) => outputs.push(message.data));
    ctx.bus.on('turn:output-policy', (message) => policies.push(message.data));
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));
    const request: TurnRequest = {
      turnId: 'resume-turn',
      source: 'voice',
      mode: 'voice',
      originalText: '  Bin \n WIEDER   DA!  ',
      createdAt: new Date().toISOString(),
    };

    await router.handleTurnRequest(request);

    expect(resumed).toEqual([{}]);
    expect(policies).toEqual([{ turnId: request.turnId, speech: 'suppress' }]);
    expect(terminals).toContainEqual({ turnId: request.turnId, status: 'done' });
    expect(outputs).toHaveLength(0);
    expect(routerProvider.calls).toBe(routerCallsBeforeResume);
    expect(workerProvider.calls).toBe(workerCallsBeforeResume);
    expect(await ctx.db.query('messages')).toHaveLength(0);
  });

  it('routes non-resume sources and semantic questions normally while paused', async () => {
    const voice = new StubVoiceService(false);
    ctx.registry.register(voice);
    const workerProvider = new ScriptedProvider(
      'Erste Antwort.',
      'Zweite Antwort.',
      'Dritte Antwort.',
      'Vierte Antwort.',
    );
    router = new RouterService(ctx, new ScriptedProvider('ok'), workerProvider);
    await router.init();
    router.activeModel = '9b';
    const resumed: BusEvents['voice:resume-speech'][] = [];
    const discarded: BusEvents['voice:discard-paused-speech'][] = [];
    ctx.bus.on('voice:resume-speech', (message) => resumed.push(message.data));
    ctx.bus.on('voice:discard-paused-speech', (message) => discarded.push(message.data));

    await router.handleChatMessage('Bin wieder da.', 'voice');
    voice.isSpeechPaused = true;
    await router.handleChatMessage('Erkläre mir den nächsten Punkt.', 'voice');
    await router.handleChatMessage('Wann ist Peter wieder da?', 'voice');
    await router.handleChatMessage('Bin wieder da.', 'chat');

    expect(resumed).toHaveLength(0);
    expect(discarded).toHaveLength(3);
    expect(discarded).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'New user input superseded paused speech' }),
    ]));
    expect(workerProvider.calls).toBe(4);
    expect(workerProvider.lastMessages?.at(-1)?.content).toContain('Bin wieder da.');
  });

  it('drops a local resume request after shutdown has started', async () => {
    const voice = new StubVoiceService(true);
    ctx.registry.register(voice);
    router = new RouterService(ctx, new ScriptedProvider('unused'), new ScriptedProvider('unused'));
    await router.init();
    const resumed: BusEvents['voice:resume-speech'][] = [];
    const discarded: BusEvents['voice:discard-paused-speech'][] = [];
    ctx.bus.on('voice:resume-speech', (message) => resumed.push(message.data));
    ctx.bus.on('voice:discard-paused-speech', (message) => discarded.push(message.data));
    const shutdown = ctx.lifecycle.shutdown();

    await router.handleTurnRequest({
      turnId: 'late-resume',
      source: 'voice',
      mode: 'voice',
      originalText: 'Bin wieder da.',
      createdAt: new Date().toISOString(),
    });
    await shutdown;

    expect(resumed).toHaveLength(0);
    expect(discarded).toHaveLength(0);
    expect(ctx.bus.isTurnTerminal('late-resume')).toBe(true);
  });

  it('heuristic gate: action command in 9B window swaps back and routes (R4-M1 state reset)', async () => {
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b]', '[ACTION:open_program:spotify]');
    const workerP = new ScriptedProvider('Photosynthese ist …', 'sollte nie kommen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    const requests: string[] = [];
    ctx.bus.on('action:request', (msg) => {
      requests.push(msg.data.action);
    });

    await router.handleChatMessage('Erkläre mir Photosynthese'); // → 9B window
    expect(router.activeModel).toBe('9b');
    await runActionTurn('Öffne Spotify'); // hint word → gate

    expect(requests).toEqual(['open_program']);
    expect(router.activeModel).toBe('2b'); // R4-M1: reset before routeAndRespond, self/action keeps it
  });

  it('heuristic gate: plain chat in 9B window goes straight to the worker', async () => {
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b]');
    const workerP = new ScriptedProvider('Erste Antwort.', 'Zweite Antwort.', 'Dritte Antwort.');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();

    await router.handleChatMessage('Erkläre mir Photosynthese');
    const routerCallsBeforeFollowups = routerP.calls;
    await router.handleChatMessage('Und was war nochmal Chlorophyll?'); // kein Hint-Wort
    await router.handleChatMessage('Erkläre Vor- und Nachteile von Fahrrädern.');

    expect(router.activeModel).toBe('9b');
    expect(routerP.calls).toBe(routerCallsBeforeFollowups);
    expect(workerP.lastMessages!.some((m) => m.content.includes('Chlorophyll'))).toBe(true);
    expect(workerP.lastMessages!.some((m) => m.content.includes('Vor- und Nachteile'))).toBe(true);
  });

  it('routes a bounded multi-intent candidate through the planner in the 9B window', async () => {
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"answer","evidence":"Erkläre Fahrräder"},{"kind":"answer","evidence":"erkläre Rom"}]}';
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b]', proposal);
    const workerP = new ScriptedProvider('Erste Antwort.', 'Fahrräder erklärt.', 'Rom erklärt.');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    await ctx.lifecycle.start();
    ctx.lifecycle.setCapability('router', 'ready');
    ctx.lifecycle.setCapability('local_worker', 'ready');
    const done: string[] = [];
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Erkläre mir Photosynthese');
    const routerCallsBeforePlan = routerP.calls;
    await router.handleChatMessage('Erkläre Fahrräder und erkläre Rom');

    expect(routerP.calls).toBe(routerCallsBeforePlan + 1);
    expect(done.slice(-2)).toEqual(['Fahrräder erklärt.', 'Rom erklärt.']);
    expect(workerP.lastMessages!.some((message) => message.content.includes('Erkläre Fahrräder und erkläre Rom'))).toBe(false);
  });

  it('routes validator-compatible hard sentence boundaries through the planner cold and warm', async () => {
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"answer","evidence":"Erkläre Fahrräder"},{"kind":"answer","evidence":"Erkläre Rom"}]}';
    const routerP = new ScriptedProvider('ok', proposal, proposal);
    const workerP = new ScriptedProvider(
      'Fahrräder kalt.',
      'Rom kalt.',
      'Fahrräder warm.',
      'Rom warm.',
    );
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    await ctx.lifecycle.start();
    ctx.lifecycle.setCapability('router', 'ready');
    ctx.lifecycle.setCapability('local_worker', 'ready');
    const done: string[] = [];
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Erkläre Fahrräder. Erkläre Rom');
    expect(router.activeModel).toBe('9b');
    const callsAfterColdPlan = routerP.calls;

    await router.handleChatMessage('Erkläre Fahrräder. Erkläre Rom');

    expect(routerP.calls).toBe(callsAfterColdPlan + 1);
    expect(done).toEqual([
      'Fahrräder kalt.',
      'Rom kalt.',
      'Fahrräder warm.',
      'Rom warm.',
    ]);
    expect(workerP.lastMessages?.at(-1)).toEqual({ role: 'user', content: 'Erkläre Rom' });
  });

  it('rejects a cold multi-intent candidate when the router returns one legacy action', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:set_timer:10m]');
    const workerP = new ScriptedProvider('darf nicht laufen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Stelle einen Timer auf 10 Minuten und öffne Spotify');

    expect(requests).toEqual([]);
    expect(workerP.calls).toBe(0);
    expect(done).toEqual([
      'Ich konnte den kombinierten Auftrag nicht zuverlässig aufteilen. Bitte formuliere die Schritte noch einmal einzeln.',
    ]);
  });

  it('rejects a warm multi-answer candidate when the router returns one legacy route', async () => {
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b]', '[ROUTE:9b]');
    const workerP = new ScriptedProvider('Photosynthese erklärt.', 'darf nicht mit Gesamttext laufen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    const done: string[] = [];
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Erkläre Photosynthese');
    expect(router.activeModel).toBe('9b');
    const workerCallsBeforeMultiIntent = workerP.calls;
    await router.handleChatMessage('Erkläre Fahrräder. Erkläre Rom');

    expect(workerP.calls).toBe(workerCallsBeforeMultiIntent);
    expect(workerP.lastMessages?.some((message) => (
      message.content.includes('Erkläre Fahrräder. Erkläre Rom')
    ))).toBe(false);
    expect(done).toEqual([
      'Photosynthese erklärt.',
      'Ich konnte den kombinierten Auftrag nicht zuverlässig aufteilen. Bitte formuliere die Schritte noch einmal einzeln.',
    ]);
  });

  it('rejects an addressed shared-modal action pair in the warm worker window', async () => {
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b]', '[ACTION:open_program:spotify]');
    const workerP = new ScriptedProvider('Photosynthese erklärt.', 'darf nicht laufen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Erkläre Photosynthese');
    expect(router.activeModel).toBe('9b');
    const workerCallsBeforeMultiIntent = workerP.calls;

    await router.handleChatMessage('Hey Sarah, kannst du Spotify öffnen und einen Timer stellen?');

    expect(requests).toEqual([]);
    expect(workerP.calls).toBe(workerCallsBeforeMultiIntent);
    expect(done).toEqual([
      'Photosynthese erklärt.',
      'Ich konnte den kombinierten Auftrag nicht zuverlässig aufteilen. Bitte formuliere die Schritte noch einmal einzeln.',
    ]);
  });

  it('queues two fast turns and keeps worker output and history in order', async () => {
    const worker = new BlockingProvider();
    router = new RouterService(ctx, new ScriptedProvider('ok'), worker);
    await router.init();
    router.activeModel = '9b';
    const done: string[] = [];
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    const first = router.handleChatMessage('Erste Frage');
    const second = router.handleChatMessage('Zweite Frage');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(worker.calls).toBe(1);

    worker.releaseFirst();
    await Promise.all([first, second]);
    expect(worker.calls).toBe(2);
    expect(done).toEqual(['Antwort 1', 'Antwort 2']);
  });

  it('cancels a worker turn exactly once and drops a provider chunk emitted after abort', async () => {
    const worker = new BlockingProvider();
    router = new RouterService(ctx, new ScriptedProvider('ok'), worker);
    await router.init();
    router.activeModel = '9b';
    const chunks: string[] = [];
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('llm:chunk', (message) => chunks.push(message.data.text));
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));
    const request: TurnRequest = {
      turnId: '11111111-1111-4111-8111-111111111111',
      source: 'chat',
      mode: 'chat',
      originalText: 'Lange Antwort',
      createdAt: new Date().toISOString(),
    };

    const active = router.handleTurnRequest(request);
    await new Promise((resolve) => setTimeout(resolve, 10));
    ctx.bus.emit('test', 'turn:cancel', { turnId: request.turnId, reason: 'test' });
    await active;

    expect(chunks).not.toContain('late-after-abort');
    expect(terminals.filter((terminal) => terminal.turnId === request.turnId)).toEqual([
      { turnId: request.turnId, status: 'canceled' },
    ]);
    expect(await ctx.db.query('messages')).toHaveLength(0);
  });

  it('stops an active worker without duplicate terminal or failure log when another owner terminalizes it', async () => {
    const worker = new BlockingProvider();
    router = new RouterService(ctx, new ScriptedProvider('ok'), worker);
    await router.init();
    router.activeModel = '9b';
    const chunks: string[] = [];
    const terminals: BusEvents['turn:terminal'][] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctx.bus.on('llm:chunk', (message) => chunks.push(message.data.text));
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));
    const request: TurnRequest = {
      turnId: '88888888-8888-4888-8888-888888888888',
      source: 'chat',
      mode: 'chat',
      originalText: 'Extern beenden',
      createdAt: new Date().toISOString(),
    };

    const active = router.handleTurnRequest(request);
    await vi.waitFor(() => expect(worker.calls).toBe(1));
    ctx.bus.emit('runtime', 'turn:terminal', {
      turnId: request.turnId,
      status: 'error',
      message: 'Runtime stopped the turn',
    });
    await active;

    expect(chunks).not.toContain('late-after-abort');
    expect(terminals.filter((terminal) => terminal.turnId === request.turnId)).toEqual([{
      turnId: request.turnId,
      status: 'error',
      message: 'Runtime stopped the turn',
    }]);
    expect(warn).not.toHaveBeenCalledWith(
      '[Router] Output job failed:',
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(warn).not.toHaveBeenCalledWith(
      '[MessageBus] terminal event for unknown turn refused:',
      request.turnId,
    );
    expect(await ctx.db.query('messages')).toHaveLength(0);
    warn.mockRestore();
  });

  it('cancels active and queued turns as soon as lifecycle shutdown starts', async () => {
    const worker = new BlockingProvider();
    router = new RouterService(ctx, new ScriptedProvider('ok'), worker);
    await router.init();
    router.activeModel = '9b';
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));
    const first = router.handleChatMessage('Aktiver Turn');
    const second = router.handleChatMessage('Wartender Turn');
    await vi.waitFor(() => expect(worker.calls).toBe(1));

    const shutdown = ctx.lifecycle.shutdown();
    await Promise.all([first, second]);
    await shutdown;

    expect(terminals.filter((entry) => entry.status === 'canceled')).toHaveLength(2);
    expect(worker.calls).toBe(1);
  });

  it('drains an already-started memory mutation before router shutdown completes', async () => {
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    let notifyInsertStarted!: () => void;
    const insertStarted = new Promise<void>((resolve) => { notifyInsertStarted = resolve; });
    const guardedCtx: AppContext = {
      ...ctx,
      db: new FailingStorage(ctx.db, {
        beforeInsert: async (table) => {
          if (table !== 'memory_staging') return;
          notifyInsertStarted();
          await insertGate;
        },
      }),
    };
    const r = new RouterService(
      guardedCtx,
      new ScriptedProvider('ok'),
      new ScriptedProvider(),
      new MediaContext(),
      { shutdownDrainTimeoutMs: 1_000 },
    );
    router = r;
    await r.init();

    const turn = r.handleChatMessage('/remember Meine Lieblingsfarbe ist Blau.');
    await insertStarted;
    let destroySettled = false;
    const destroying = r.destroy().then(() => { destroySettled = true; });
    await Promise.resolve();

    expect(destroySettled).toBe(false);
    releaseInsert();
    await Promise.all([destroying, turn]);
    expect(destroySettled).toBe(true);
    router = null;
  });

  it('bounds router shutdown when a storage mutation ignores cancellation', async () => {
    let notifyInsertStarted!: () => void;
    const insertStarted = new Promise<void>((resolve) => { notifyInsertStarted = resolve; });
    const never = new Promise<void>(() => {});
    const guardedCtx: AppContext = {
      ...ctx,
      db: new FailingStorage(ctx.db, {
        beforeInsert: async (table) => {
          if (table !== 'memory_staging') return;
          notifyInsertStarted();
          await never;
        },
      }),
    };
    const r = new RouterService(
      guardedCtx,
      new ScriptedProvider('ok'),
      new ScriptedProvider(),
      new MediaContext(),
      { shutdownDrainTimeoutMs: 5 },
    );
    router = r;
    await r.init();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const turn = r.handleChatMessage('/remember Meine Lieblingsfarbe ist Blau.');
    await insertStarted;
    await r.destroy();
    await turn;

    expect(warn).toHaveBeenCalledWith(
      '[Router] Pending work did not drain before shutdown:',
      expect.objectContaining({ name: 'TimeoutError' }),
    );
    warn.mockRestore();
    router = null;
  });

  it('refuses a duplicate active turnId before it can execute twice', async () => {
    const worker = new BlockingProvider();
    router = new RouterService(ctx, new ScriptedProvider('ok'), worker);
    await router.init();
    router.activeModel = '9b';
    const request: TurnRequest = {
      turnId: '22222222-2222-4222-8222-222222222222',
      source: 'chat',
      mode: 'chat',
      originalText: 'Nur einmal',
      createdAt: new Date().toISOString(),
    };

    const first = router.handleTurnRequest(request);
    await vi.waitFor(() => expect(worker.calls).toBe(1));
    await router.handleTurnRequest(request);
    expect(worker.calls).toBe(1);

    worker.releaseFirst();
    await first;
    expect(await ctx.db.query('messages')).toHaveLength(2);
  });

  it('refuses a centrally terminal turn before routing or persistence', async () => {
    const worker = new ScriptedProvider('should-not-run');
    router = new RouterService(ctx, new ScriptedProvider('ok'), worker);
    await router.init();
    const request: TurnRequest = {
      turnId: '77777777-7777-4777-8777-777777777777',
      source: 'chat',
      mode: 'chat',
      originalText: 'Nicht mehr ausführen',
      createdAt: new Date().toISOString(),
    };
    ctx.bus.emit('test', 'turn:accepted', {
      turnId: request.turnId,
      source: request.source,
      mode: request.mode,
    });
    ctx.bus.emit('test', 'turn:terminal', { turnId: request.turnId, status: 'canceled' });

    await router.handleTurnRequest(request);

    expect(worker.calls).toBe(0);
    expect(await ctx.db.query('messages')).toHaveLength(0);
  });

  it('destroy() clears pendingActions and the shutdown guard blocks late output', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:web_search:x y]');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    let requestId = '';
    let turnId = '';
    ctx.bus.on('action:request', (msg) => {
      requestId = msg.data.requestId;
      turnId = msg.data.turnId;
    });
    const activeTurn = router.handleChatMessage('Such x y');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await router.destroy();
    await activeTurn;
    const done: string[] = [];
    const chunks: string[] = [];
    const prioritySpeech: BusEvents['voice:priority-speech'][] = [];
    ctx.bus.on('llm:done', (msg) => {
      done.push(msg.data.fullText);
    });
    ctx.bus.on('llm:chunk', (msg) => {
      chunks.push(msg.data.text);
    });
    ctx.bus.on('voice:priority-speech', (msg) => {
      prioritySpeech.push(msg.data);
    });
    ctx.bus.emit('test', 'action:result', { turnId, requestId, action: 'web_search', ok: true, speak: 'Spät.' });
    // action:result is blocked by the cleared pendingActions map above; action:notify has no such
    // correlation check, so this is what actually proves the status guard inside
    // emitAssistantResponse's queued job (`if (this.status !== 'running') return;`) blocks late output.
    ctx.bus.emit('test', 'action:notify', {
      notificationId: 'notify-late',
      kind: 'timer',
      speak: 'Später Timer.',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(done).toHaveLength(0);
    expect(chunks).toHaveLength(0);
    expect(prioritySpeech).toHaveLength(0);
  });
});
