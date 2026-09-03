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
        validation: 'schema_only',
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
