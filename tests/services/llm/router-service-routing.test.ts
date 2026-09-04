import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RouterService, type RouterServiceOptions } from '../../../src/services/llm/router-service.js';
import { bootstrap } from '../../../src/core/bootstrap.js';
import type { AppContext } from '../../../src/core/bootstrap.js';
import type { ChatMessage, ChatOptions, LlmProvider } from '../../../src/services/llm/llm-provider.interface.js';
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

class MutatingScriptedProvider implements LlmProvider {
  readonly id = 'mutating-scripted';
  private calls = 0;

  constructor(
    private readonly replies: readonly string[],
    private readonly beforeReply: (call: number) => void,
  ) {}

  async isAvailable(): Promise<boolean> { return true; }

  async chat(
    _messages: ChatMessage[],
    onChunk: (text: string) => void,
    _options?: ChatOptions,
  ): Promise<string> {
    this.calls += 1;
    this.beforeReply(this.calls);
    const reply = this.replies[this.calls - 1] ?? 'leer';
    onChunk(reply);
    return reply;
  }
}

describe('RouterService (routing & commands)', () => {
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

  it('emits one visible router error and one terminal when routing fails', async () => {
    router = new RouterService(ctx, new FailingAfterWarmupProvider(), new ScriptedProvider('worker'));
    await router.init();
    const errors: BusEvents['llm:error'][] = [];
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('llm:error', (message) => errors.push(message.data));
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));

    await router.handleChatMessage('Das Routing schlägt fehl', 'voice');

    expect(errors).toHaveLength(1);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      turnId: errors[0].turnId,
      status: 'error',
      message: errors[0].message,
    });
  });

  async function runActionTurn(
    text: string,
    result: { ok?: boolean; speak?: string } = {},
  ): Promise<BusEvents['action:request']> {
    if (!router) throw new Error('router not initialized');
    let unsubscribe = (): void => {};
    const requestPromise = new Promise<BusEvents['action:request']>((resolve) => {
      unsubscribe = ctx.bus.on('action:request', (msg) => resolve(msg.data));
    });
    const turn = router.handleChatMessage(text);
    const request = await requestPromise;
    unsubscribe();
    ctx.bus.emit('test', 'action:result', {
      turnId: request.turnId,
      requestId: request.requestId,
      action: request.action,
      ok: result.ok ?? true,
      ...(result.speak ? { speak: result.speak } : {}),
    });
    await turn;
    return request;
  }

  async function enableProductivePlanCapabilities(): Promise<void> {
    const readyService = (id: string, acceptingWork?: boolean): SarahService & { acceptingWork?: boolean } => ({
      id,
      subscriptions: [],
      status: 'running',
      ...(acceptingWork === undefined ? {} : { acceptingWork }),
      async init(): Promise<void> { this.status = 'running'; },
      async destroy(): Promise<void> { this.status = 'stopped'; },
      onMessage(): void {},
    });
    ctx.registry.register(readyService('search', true));
    ctx.registry.register(readyService('reminders'));
    await ctx.lifecycle.start();
    ctx.lifecycle.setCapability('router', 'ready');
    ctx.lifecycle.setCapability('local_worker', 'ready');
  }

  it('never exposes trailing router prose and safely falls back to the worker', async () => {
    const routerP = new ScriptedProvider(
      'ok',
      '[ACTION:open_program:spotify] Ich öffne Spotify vielleicht.',
    );
    const workerP = new ScriptedProvider('Antwort vom Worker.');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();

    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (msg) => requests.push(msg.data));
    ctx.bus.on('llm:done', (msg) => done.push(msg.data.fullText));

    await router.handleChatMessage('Öffne Spotify');

    expect(requests).toHaveLength(0);
    expect(done).toEqual(['Antwort vom Worker.']);
    expect(done.join(' ')).not.toContain('vielleicht');
  });

  it('compiles and executes a bounded action plus clause-only answer in one turn', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'minimal';
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"action","action":"set_timer","param":"10m","evidence":"Stelle einen Timer auf 10 Minuten"},{"kind":"answer","evidence":"erkläre Fahrräder"}]}';
    const routerP = new ScriptedProvider('ok', proposal);
    const workerP = new ScriptedProvider('Antwort nur über Fahrräder.');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    await enableProductivePlanCapabilities();
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));

    const { request, actionTurn } = await startAction(
      ctx,
      router,
      'Stelle einen Timer auf 10 Minuten und erkläre Fahrräder',
    );
    ctx.bus.emit('test', 'action:result', {
      turnId: request.turnId,
      requestId: request.requestId,
      action: request.action,
      ok: true,
    });
    await actionTurn;

    expect(request).toMatchObject({
      action: 'set_timer',
      param: '10m',
      provenance: {
        validation: 'semantic_grounding',
        evidenceScope: { kind: 'clause', ordinal: 0 },
      },
    });
    expect(workerP.lastMessages?.at(-1)).toEqual({
      role: 'user',
      content: 'erkläre Fahrräder',
    });
    expect(terminals).toEqual([
      expect.objectContaining({ turnId: request.turnId, status: 'done' }),
    ]);
  });

  it('rejects a compiler failure without executing any proposal fragment', async () => {
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"action","action":"set_timer","param":"10m","evidence":"10 Minuten"},{"kind":"answer","evidence":"erkläre Fahrräder"}]}';
    const routerP = new ScriptedProvider('ok', proposal);
    const workerP = new ScriptedProvider('darf nicht laufen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    await enableProductivePlanCapabilities();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Stelle einen Timer auf 10 Minuten und erkläre Fahrräder');

    expect(requests).toEqual([]);
    expect(workerP.calls).toBe(0);
    expect(done).toEqual([
      'Ich konnte den kombinierten Auftrag nicht zuverlässig aufteilen. Bitte formuliere die Schritte noch einmal einzeln.',
    ]);
  });

  it.each([
    [
      'Setze einen Timer auf 10 Minuten, anschließend öffne Spotify',
      '[ACTION:set_timer:10m]',
    ],
    [
      'Erinnere mich morgen an Tee, daraufhin sperre den Bildschirm',
      '[ACTION:set_reminder:at=tomorrow@10:00|text=Tee]',
    ],
    [
      'Pausiere die Musik sowie öffne Spotify',
      '[ACTION:media_pause:]',
    ],
    [
      'Stelle einen Timer auf 10 Minuten oder öffne Spotify',
      '[ACTION:set_timer:10m]',
    ],
    [
      'Set a timer and open Spotify',
      '[ACTION:set_timer:10m]',
    ],
    [
      'Sarah, öffne Spotify und stelle einen Timer',
      '[ACTION:open_program:spotify]',
    ],
    [
      'Kannst du Spotify öffnen und einen Timer stellen?',
      '[ACTION:open_program:spotify]',
    ],
  ])('blocks every legacy partial action for a recognized plan candidate: %s', async (text, legacyOutput) => {
    const routerP = new ScriptedProvider('ok', legacyOutput);
    const workerP = new ScriptedProvider('darf nicht laufen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage(text);

    expect(requests).toEqual([]);
    expect(workerP.calls).toBe(0);
    expect(done).toEqual([
      'Ich konnte den kombinierten Auftrag nicht zuverlässig aufteilen. Bitte formuliere die Schritte noch einmal einzeln.',
    ]);
  });

  it.each([
    'Kannst du mir sagen, was Rom ist?',
    'Hey Sarah, kannst du erklären, warum der Himmel blau ist?',
  ])('keeps one embedded question on the legacy single-intent path: %s', async (text) => {
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b]');
    const workerP = new ScriptedProvider('Eine normale Antwort.');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage(text);

    expect(requests).toEqual([]);
    expect(workerP.calls).toBe(1);
    expect(done).toEqual(['Eine normale Antwort.']);
  });

  it('preflights all plan actions before starting any side effect', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'maximal';
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"action","action":"set_timer","param":"10m","evidence":"Stelle einen Timer auf 10 Minuten"},{"kind":"answer","evidence":"erkläre Fahrräder"}]}';
    const routerP = new ScriptedProvider('ok', proposal);
    const workerP = new ScriptedProvider('darf nicht laufen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    await enableProductivePlanCapabilities();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Stelle einen Timer auf 10 Minuten und erkläre Fahrräder');

    expect(requests).toEqual([]);
    expect(workerP.calls).toBe(0);
    expect(done).toEqual([
      'Ich kann diesen kombinierten Auftrag so noch nicht sicher ausführen. Bitte teile ihn in einzelne Aufträge auf.',
    ]);
  });

  it('rejects the complete plan when worker capability changes during routing', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'minimal';
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"action","action":"set_timer","param":"10m","evidence":"Stelle einen Timer auf 10 Minuten"},{"kind":"answer","evidence":"erkläre Fahrräder"}]}';
    const routerP = new MutatingScriptedProvider(['ok', proposal], (call) => {
      if (call === 2) ctx.lifecycle.setCapability('local_worker', 'error');
    });
    const workerP = new ScriptedProvider('darf nicht laufen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    await enableProductivePlanCapabilities();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Stelle einen Timer auf 10 Minuten und erkläre Fahrräder');

    expect(requests).toEqual([]);
    expect(workerP.calls).toBe(0);
    expect(done).toEqual([
      'Ich kann diesen kombinierten Auftrag so noch nicht sicher ausführen. Bitte teile ihn in einzelne Aufträge auf.',
    ]);
  });

  it('rejects the complete plan when a required service stops during routing', async () => {
    ctx.parsedConfig.trust.confirmationLevel = 'minimal';
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"action","action":"web_search","param":"Fahrräder","evidence":"Suche Fahrräder"},{"kind":"answer","evidence":"erkläre Rom"}]}';
    const routerP = new MutatingScriptedProvider(['ok', proposal], (call) => {
      if (call !== 2) return;
      const search = ctx.registry.get('search');
      if (search) search.status = 'stopped';
    });
    const workerP = new ScriptedProvider('darf nicht laufen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    await enableProductivePlanCapabilities();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Suche Fahrräder und erkläre Rom');

    expect(requests).toEqual([]);
    expect(workerP.calls).toBe(0);
    expect(done).toEqual([
      'Ich kann diesen kombinierten Auftrag so noch nicht sicher ausführen. Bitte teile ihn in einzelne Aufträge auf.',
    ]);
  });

  it('preserves inherited private context on planned action requests', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    ctx.parsedConfig.trust.confirmationLevel = 'minimal';
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"action","action":"set_timer","param":"10m","evidence":"Stelle einen Timer auf 10 Minuten"},{"kind":"answer","evidence":"erkläre Fahrräder"}]}';
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b]', proposal);
    const workerP = new ScriptedProvider('Private Antwort.', 'Antwort nur über Fahrräder.');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    await enableProductivePlanCapabilities();

    await router.handleChatMessage('/anonymous Mein Codename ist Eule');
    const { request, actionTurn } = await startAction(
      ctx,
      router,
      'Stelle einen Timer auf 10 Minuten und erkläre Fahrräder',
    );
    ctx.bus.emit('test', 'action:result', {
      turnId: request.turnId,
      requestId: request.requestId,
      action: request.action,
      ok: true,
    });
    await actionTurn;

    expect(request).toMatchObject({
      privateContext: true,
      originMode: 'chat',
    });
  });

  it('discards inherited-private planned searches without exposing a browser follow-up', async () => {
    ctx.parsedConfig.trust.anonymousEnabled = true;
    ctx.parsedConfig.trust.confirmationLevel = 'minimal';
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"action","action":"web_search","param":"Fahrräder","evidence":"Suche Fahrräder"},{"kind":"answer","evidence":"erkläre Rom"}]}';
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b]', proposal, '[ROUTE:9b]');
    const workerP = new ScriptedProvider(
      'Private Antwort.',
      'Antwort nur über Rom.',
      'Kein sichtbares Suchergebnis.',
    );
    router = new RouterService(ctx, routerP, workerP);
    await router.init();
    await enableProductivePlanCapabilities();
    const requests: BusEvents['action:request'][] = [];
    const discarded: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('search:discard-session', (message) => discarded.push(message.data.requestId));

    await router.handleChatMessage('/anonymous Mein Codename ist Eule');
    const { request, actionTurn } = await startAction(
      ctx,
      router,
      'Suche Fahrräder und erkläre Rom',
    );
    ctx.bus.emit('test', 'action:result', {
      turnId: request.turnId,
      requestId: request.requestId,
      action: request.action,
      ok: true,
    });
    await actionTurn;
    await router.handleChatMessage('Öffne das erste Ergebnis');

    expect(request).toMatchObject({ action: 'web_search', privateContext: true });
    expect(discarded).toContain(request.requestId);
    expect(requests).toHaveLength(1);
    expect(workerP.lastMessages?.at(-1)).toEqual({
      role: 'user',
      content: 'Öffne das erste Ergebnis',
    });
  });

  it('reports a missing worker immediately and keeps deterministic router turns usable', async () => {
    ctx.parsedConfig.profile.displayName = 'Martin';
    const routerP = new ScriptedProvider('ok', '[ROUTE:9b]');
    router = new RouterService(ctx, routerP, new UnavailableProvider());
    await router.init();

    const done: string[] = [];
    const errors: string[] = [];
    ctx.bus.on('llm:done', (msg) => done.push(msg.data.fullText));
    ctx.bus.on('llm:error', (msg) => errors.push(msg.data.message));

    await router.handleChatMessage('Erkläre mir Quantenphysik');
    await router.handleChatMessage('Wie ist mein Name?');

    expect(done).toEqual([
      'Auf meine tieferen Gedanken kann ich gerade nicht zugreifen. Einfache Befehle funktionieren weiterhin.',
      'Du heißt Martin.',
    ]);
    expect(errors).toHaveLength(0);
    expect(router.activeModel).toBe('2b');
  });

  it('does not mask a router failure as a successful worker-unavailable fallback', async () => {
    router = new RouterService(ctx, new FailingAfterWarmupProvider(), new UnavailableProvider());
    await router.init();
    const done: string[] = [];
    const errors: string[] = [];
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));
    ctx.bus.on('llm:error', (message) => errors.push(message.data.message));
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));

    await router.handleChatMessage('Wie spät ist es?');

    expect(done).not.toContain(WORKER_UNAVAILABLE_MESSAGE);
    expect(errors).toEqual(['Sarah ist kurz weggedriftet. Einen Moment...']);
    expect(terminals).toEqual([
      expect.objectContaining({ status: 'error' }),
    ]);
  });

  it('attributes a protected context-window overflow instead of reporting a connection failure', async () => {
    ctx.parsedConfig.llm.workerOptions.num_ctx = 4_096;
    router = new RouterService(
      ctx,
      new ScriptedProvider('ok', '[ROUTE:9b]'),
      new ScriptedProvider('unused'),
    );
    await router.init();
    const errors: string[] = [];
    ctx.bus.on('llm:error', (message) => errors.push(message.data.message));

    await router.handleChatMessage('x'.repeat(4_000));

    expect(errors).toEqual([
      'Die aktuelle Anfrage und Sarahs Einstellungen sind zu umfangreich für das konfigurierte Kontextfenster.',
    ]);
  });

  it('fails a worker turn after visible output without adding an unavailable fallback or done event', async () => {
    router = new RouterService(
      ctx,
      new ScriptedProvider('ok', '[ROUTE:9b]'),
      new FailingMidstreamProvider(),
    );
    await router.init();
    const chunks: string[] = [];
    const done: string[] = [];
    const errors: string[] = [];
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('llm:chunk', (message) => chunks.push(message.data.text));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));
    ctx.bus.on('llm:error', (message) => errors.push(message.data.message));
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));

    await router.handleChatMessage('Erkläre mir Quantenphysik');

    expect(chunks).toEqual(['Unvollständige Antwort']);
    expect(chunks).not.toContain(WORKER_UNAVAILABLE_MESSAGE);
    expect(done).toHaveLength(0);
    expect(errors).toEqual(['Sarah ist kurz weggedriftet. Einen Moment...']);
    expect(terminals).toEqual([
      expect.objectContaining({ status: 'error' }),
    ]);
  });

  it('does not publish orphaned partial output when a planned answer fails midstream', async () => {
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"answer","evidence":"Erkläre Fahrräder"},{"kind":"answer","evidence":"erkläre Rom"}]}';
    router = new RouterService(
      ctx,
      new ScriptedProvider('ok', proposal),
      new FailingMidstreamProvider(),
    );
    await router.init();
    await enableProductivePlanCapabilities();
    const chunks: BusEvents['llm:chunk'][] = [];
    const done: BusEvents['llm:done'][] = [];
    const terminals: BusEvents['turn:terminal'][] = [];
    ctx.bus.on('llm:chunk', (message) => chunks.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data));
    ctx.bus.on('turn:terminal', (message) => terminals.push(message.data));

    await router.handleChatMessage('Erkläre Fahrräder und erkläre Rom');

    expect(chunks.map((chunk) => chunk.text)).not.toContain('Unvollständige Antwort');
    expect(chunks.every((chunk) => done.some((output) => output.outputId === chunk.outputId)))
      .toBe(true);
    expect(terminals).toEqual([
      expect.objectContaining({ status: 'done' }),
    ]);
  });

  it('expands a configured slash command before normal safe routing', async () => {
    ctx.parsedConfig.controls.customCommands = [
      { command: '/spotify', prompt: 'Öffne Spotify' },
    ];
    const routerP = new ScriptedProvider('ok', '[ACTION:open_program:spotify]');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();

    const requests: BusEvents['action:request'][] = [];
    ctx.bus.on('action:request', (msg) => requests.push(msg.data));

    await runActionTurn('/spotify');

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      action: 'open_program',
      param: 'spotify',
      provenance: {
        decisionSource: 'router_model',
        evidenceSource: 'custom_command_expansion',
        customCommand: '/spotify',
        validation: 'semantic_grounding',
      },
    });
    expect(routerP.lastMessages?.at(-1)).toEqual({ role: 'user', content: 'Öffne Spotify' });
  });

  it('refuses a disabled web action before announcing or dispatching it', async () => {
    ctx.parsedConfig.trust.webAccessAllowed = false;
    router = new RouterService(
      ctx,
      new ScriptedProvider('ok', '[ACTION:web_search:private query]'),
      new ScriptedProvider(),
    );
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Suche private query');

    expect(requests).toEqual([]);
    expect(done).toEqual(['Der Browserzugriff ist in den Einstellungen deaktiviert.']);
    expect(done).not.toContain('Ich suche nach „private query“.');
  });

  it('grounds timer and reminder actions against the trusted custom-command expansion', async () => {
    ctx.parsedConfig.controls.customCommands = [
      { command: '/brot', prompt: 'Stelle einen Brötchen-Timer auf 5 Minuten' },
      { command: '/essen', prompt: 'Erinnere mich in 10 Minuten an Essen' },
    ];
    const routerP = new ScriptedProvider(
      'ok',
      '[ACTION:set_timer:5m|Brötchen]',
      '[ACTION:set_reminder:after=10m|text=Essen]',
    );
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();

    const timer = await runActionTurn('/brot');
    const reminder = await runActionTurn('/essen');

    expect(timer).toMatchObject({ action: 'set_timer', param: '5m|Brötchen' });
    expect(timer.provenance).toMatchObject({
      evidenceSource: 'custom_command_expansion',
      customCommand: '/brot',
      validation: 'semantic_grounding',
    });
    expect(reminder).toMatchObject({
      action: 'set_reminder',
      param: expect.stringMatching(/^at=date:\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\|text=Essen$/u),
    });
    expect(reminder.provenance).toMatchObject({
      evidenceSource: 'custom_command_expansion',
      customCommand: '/essen',
      validation: 'semantic_grounding',
    });
  });

  it('rejects unknown slash commands without calling an LLM', async () => {
    const routerP = new ScriptedProvider('ok');
    const workerP = new ScriptedProvider('sollte nie kommen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();

    const done: string[] = [];
    ctx.bus.on('llm:done', (msg) => done.push(msg.data.fullText));

    await router.handleChatMessage('/unbekannt');

    expect(done).toEqual(['Diesen Slash-Command kenne ich nicht: /unbekannt.']);
    expect(routerP.calls).toBe(1);
    expect(workerP.calls).toBe(0);
  });

  it('answers a known name question deterministically without calling either model', async () => {
    ctx.parsedConfig.profile.displayName = 'Martin';
    const routerP = new ScriptedProvider('ok');
    const workerP = new ScriptedProvider('sollte nie kommen');
    router = new RouterService(ctx, routerP, workerP);
    await router.init();

    const done: string[] = [];
    ctx.bus.on('llm:done', (msg) => done.push(msg.data.fullText));
    await router.handleChatMessage('Weißt du, wie ich heiße?');

    expect(router.activeModel).toBe('2b');
    expect(done).toEqual(['Du heißt Martin.']);
    expect(routerP.calls).toBe(1);
    expect(workerP.calls).toBe(0);
  });

  it('rejects unknown action names honestly and never emits action:request', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:send_all_data:evil]');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const requests: string[] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', () => {
      requests.push('x');
    });
    ctx.bus.on('llm:done', (msg) => {
      done.push(msg.data.fullText);
    });

    await router.handleChatMessage('mach was böses');

    expect(requests).toHaveLength(0);
    expect(done).toEqual(['Das kann ich noch nicht.']);
  });

  it('speaks an action:result with matching requestId, drops unknown/duplicate ids', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:open_program:spotify]');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const done: string[] = [];
    ctx.bus.on('llm:done', (msg) => {
      done.push(msg.data.fullText);
    });
    let requestId = '';
    let turnId = '';
    ctx.bus.on('action:request', (msg) => {
      requestId = msg.data.requestId;
      turnId = msg.data.turnId;
    });

    const turn = router.handleChatMessage('Öffne Spotify');
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.bus.emit('test', 'action:result', { turnId, requestId, action: 'open_program', ok: true, speak: 'Spotify wurde geöffnet.' });
    ctx.bus.emit('test', 'action:result', { turnId, requestId, action: 'open_program', ok: true, speak: 'Doppelt.' }); // duplicate → dropped
    ctx.bus.emit('test', 'action:result', {
      turnId,
      requestId: 'ffffffff-0000-0000-0000-000000000000',
      action: 'open_program',
      ok: true,
      speak: 'Fremd.',
    });
    await turn;
    await new Promise((r) => setTimeout(r, 20)); // let the output queue drain

    expect(done).toEqual(['Ich öffne Spotify.', 'Spotify wurde geöffnet.']);
  });

});
