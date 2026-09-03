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

describe('RouterService (timer & reminder actions)', () => {
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

  it('propagates a canceled pending action and does not commit its partial acknowledgement', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:open_program:spotify]');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const canceled: BusEvents['action:cancel'][] = [];
    ctx.bus.on('action:cancel', (message) => canceled.push(message.data));
    const request: TurnRequest = {
      turnId: '33333333-3333-4333-8333-333333333333',
      source: 'chat',
      mode: 'chat',
      originalText: 'Öffne Spotify',
      createdAt: new Date().toISOString(),
    };
    const actionRequested = new Promise<void>((resolve) => {
      const unsubscribe = ctx.bus.on('action:request', () => {
        unsubscribe();
        resolve();
      });
    });
    const active = router.handleTurnRequest(request);
    await actionRequested;

    ctx.bus.emit('test', 'turn:cancel', { turnId: request.turnId, reason: 'barge-in' });
    await active;

    expect(canceled).toHaveLength(1);
    expect(canceled[0]).toMatchObject({ turnId: request.turnId, reason: 'barge-in' });
    expect(await ctx.db.query('messages')).toHaveLength(0);
  });

  it('publishes timer speech and its correlated visible output immediately over a blocked worker', async () => {
    const workerP = new BlockingProvider();
    router = new RouterService(ctx, new ScriptedProvider('ok'), workerP);
    await router.init();
    router.activeModel = '9b';
    const events: string[] = [];
    const prioritySpeech: BusEvents['voice:priority-speech'][] = [];
    const outputPolicies: BusEvents['turn:output-policy'][] = [];
    ctx.bus.on('llm:chunk', (msg) => {
      events.push(`chunk:${msg.data.outputId}:${msg.data.text}`);
    });
    ctx.bus.on('llm:done', (msg) => {
      events.push(`done:${msg.data.outputId}:${msg.data.fullText}`);
    });
    ctx.bus.on('voice:priority-speech', (msg) => prioritySpeech.push(msg.data));
    ctx.bus.on('turn:output-policy', (msg) => outputPolicies.push(msg.data));

    const turn = router.handleChatMessage('Erkläre etwas Langes');
    await vi.waitFor(() => expect(workerP.calls).toBe(1));
    ctx.bus.emit('test', 'action:notify', {
      notificationId: 'notify-1',
      kind: 'timer',
      speak: 'Dein Timer ist abgelaufen.',
      originMode: 'chat',
    });

    expect(prioritySpeech).toEqual([{
      turnId: 'notify-1',
      outputId: expect.any(String),
      text: 'Dein Timer ist abgelaufen.',
      priority: 'timer',
      pauseAfter: true,
    }]);
    expect(outputPolicies).toEqual([{ turnId: 'notify-1', speech: 'suppress' }]);
    expect(events.some((event) => event.endsWith(':Dein Timer ist abgelaufen.'))).toBe(true);
    await vi.waitFor(() => expect(ctx.bus.isTurnTerminal('notify-1')).toBe(true));

    workerP.releaseFirst();
    await turn;

    const doneIdx = events.findIndex((event) => event.endsWith(':Antwort 1'));
    const notifyIdx = events.findIndex((event) => event.endsWith(':Dein Timer ist abgelaufen.'));
    expect(doneIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeLessThan(doneIdx);
    expect(events.filter((event) => (
      event.startsWith('done:') && event.endsWith(':Dein Timer ist abgelaufen.')
    ))).toHaveLength(1);
    expect(events[notifyIdx]).toContain(prioritySpeech[0].outputId);
  });

  it('keeps a private timer visible without speaking its label', async () => {
    router = new RouterService(ctx, new ScriptedProvider('ok'), new ScriptedProvider());
    await router.init();
    const prioritySpeech: BusEvents['voice:priority-speech'][] = [];
    const visible: string[] = [];
    ctx.bus.on('voice:priority-speech', (message) => prioritySpeech.push(message.data));
    ctx.bus.on('llm:done', (message) => visible.push(message.data.fullText));

    ctx.bus.emit('test', 'action:notify', {
      notificationId: 'private-timer-1',
      kind: 'timer',
      speak: 'Dein Arznei-Timer ist abgelaufen.',
      originMode: 'chat',
      privateContext: true,
    });

    await vi.waitFor(() => expect(visible).toContain('Dein Arznei-Timer ist abgelaufen.'));
    expect(prioritySpeech).toEqual([]);
  });

  it('publishes reminders through the same sentence-boundary priority path', async () => {
    router = new RouterService(ctx, new ScriptedProvider('ok'), new ScriptedProvider());
    await router.init();
    const prioritySpeech: BusEvents['voice:priority-speech'][] = [];
    const accepted: BusEvents['action:notify-accepted'][] = [];
    ctx.bus.on('voice:priority-speech', (message) => prioritySpeech.push(message.data));
    ctx.bus.on('action:notify-accepted', (message) => accepted.push(message.data));

    ctx.bus.emit('test', 'action:notify', {
      notificationId: 'reminder-notify-1',
      kind: 'reminder',
      speak: 'Erinnerung: Steuerberater anrufen.',
    });

    expect(prioritySpeech).toEqual([{
      turnId: 'reminder-notify-1',
      outputId: expect.any(String),
      text: 'Erinnerung: Steuerberater anrufen.',
      priority: 'timer',
      pauseAfter: true,
    }]);
    await vi.waitFor(() => expect(accepted).toEqual([{
      notificationId: 'reminder-notify-1',
    }]));
  });

  it('keeps Timer V2 parameters as canonical strings through RouterService dispatch', async () => {
    const routerP = new ScriptedProvider(
      'ok',
      '[ACTION:set_timer:05m030s|  Brötchen  ]',
      '[ACTION:cancel_timer:duration=030s]',
    );
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const done: string[] = [];
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    const setRequest = await runActionTurn('Stelle einen Brötchen-Timer auf fünfeinhalb Minuten');
    const cancelRequest = await runActionTurn('Brich den 30-Sekunden-Timer ab');

    expect(setRequest).toMatchObject({ action: 'set_timer', param: '5m30s|Brötchen' });
    expect(cancelRequest).toMatchObject({ action: 'cancel_timer', param: 'duration=30s' });
    expect(setRequest.param).not.toBe('[object Object]');
    expect(cancelRequest.param).not.toBe('[object Object]');
    expect(done).toContain('Ich stelle den Brötchen-Timer auf 5 Minuten 30 Sekunden.');
    expect(done).toContain('Ich prüfe die Timer mit 30 Sekunden Laufzeit.');
  });

  it('grounds reminder content and time before dispatching a canonical action', async () => {
    const nowMs = Date.parse('2026-08-30T10:15:00.000Z');
    const routerP = new ScriptedProvider(
      'ok',
      '[ACTION:set_reminder:after=30m|text=Steuerberater anrufen]',
      '[ACTION:cancel_reminder:text=Steuerberater anrufen]',
    );
    router = new RouterService(
      ctx,
      routerP,
      new ScriptedProvider(),
      new MediaContext(),
      {
        reminderClock: {
          nowMs: () => nowMs,
          toLocal: (epochMs) => new Date(epochMs).toISOString().slice(0, 16),
        },
      },
    );
    await router.init();

    const setRequest = await runActionTurn(
      'Erinnere mich in 30 Minuten: Steuerberater anrufen',
    );
    const cancelRequest = await runActionTurn(
      'Brich die Erinnerung Steuerberater anrufen ab',
    );

    expect(setRequest).toMatchObject({
      action: 'set_reminder',
      param: 'at=date:2026-08-30@10:45|text=Steuerberater anrufen',
    });
    expect(cancelRequest).toMatchObject({
      action: 'cancel_reminder',
      param: 'text=Steuerberater anrufen',
    });
  });

  it.each([
    ['Erstelle eine Erinnerung in 10 Minuten für Haare schneiden.', '10m|Haare schneiden', 'after=10m|text=Haare schneiden'],
    ['Erstelle eine neue Erinnerung in 10 Minuten Essen.', '10m|Essen', 'after=10m|text=Essen'],
    ['Setze eine Erinnerung in 10 Minuten Essen.', '10m|Essen', 'after=10m|text=Essen'],
    ['Stelle eine Erinnerung in 10 Minuten Essen.', '10m|Essen', 'after=10m|text=Essen'],
    ['Erinnerung, zehn Minuten, Haare schneiden.', '10m|Haare schneiden', 'after=10m|text=Haare schneiden'],
  ])('corrects an explicit reminder creation misrouted as a timer: %s', async (userText, timerParam, reminderParam) => {
    router = new RouterService(
      ctx,
      new ScriptedProvider('ok', `[ACTION:set_timer:${timerParam}]`),
      new ScriptedProvider(),
    );
    await router.init();

    const request = await runActionTurn(userText);

    expect(request).toMatchObject({
      action: 'set_reminder',
      param: expect.stringMatching(new RegExp(
        `^at=date:\\d{4}-\\d{2}-\\d{2}@\\d{2}:\\d{2}\\|text=${reminderParam.split('|text=')[1]}$`,
        'u',
      )),
    });
  });

  it('corrects explicit timer shorthand misrouted as a reminder', async () => {
    router = new RouterService(
      ctx,
      new ScriptedProvider('ok', '[ACTION:set_reminder:after=3m|text=Eier kochen]'),
      new ScriptedProvider(),
    );
    await router.init();

    const request = await runActionTurn('Timer, drei Minuten, Eier kochen.');

    expect(request).toMatchObject({
      action: 'set_timer',
      param: '3m|Eier kochen',
    });
  });

  it('corrects an explicit reminder deletion misrouted as reminder creation', async () => {
    router = new RouterService(
      ctx,
      new ScriptedProvider('ok', '[ACTION:set_reminder:after=10m|text=Essen]'),
      new ScriptedProvider(),
    );
    await router.init();

    const request = await runActionTurn('Lösche die Erinnerung Essen.');

    expect(request).toMatchObject({
      action: 'cancel_reminder',
      param: 'text=Essen',
    });
  });

  it.each(['Aktive Erinnerungen.', 'Aktive Erinnerung', 'Zeige mir die aktiven Erinnerungen.', 'Alle Erinnerungen'])(
    'lists all upcoming reminders locally for shorthand %s',
    async (userText) => {
      const routerProvider = new ScriptedProvider('ok', '[ACTION:set_timer:5m]');
      router = new RouterService(ctx, routerProvider, new ScriptedProvider());
      await router.init();
      const routerCallsAfterWarmup = routerProvider.calls;

      const request = await runActionTurn(userText);

      expect(request).toMatchObject({
        action: 'list_reminders',
        param: 'upcoming',
      });
      expect(routerProvider.calls).toBe(routerCallsAfterWarmup);
    },
  );

  it.each([
    'Die um 17.05 Uhr.',
    '17 Uhr 05',
    '17.05 Uhr Steuerberater',
  ])('resolves cancel-reminder time follow-up %s from structured ambiguity data', async (followupText) => {
    const routerProvider = new ScriptedProvider(
      'ok',
      '[ACTION:cancel_reminder:text=Steuerberater anrufen]',
    );
    router = new RouterService(ctx, routerProvider, new ScriptedProvider());
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));

    const first = await startAction(ctx, router, 'Brich die Erinnerung Steuerberater anrufen ab');
    ctx.bus.emit('test', 'action:result', {
      turnId: first.request.turnId,
      requestId: first.request.requestId,
      action: first.request.action,
      ok: false,
      speak: 'Es gibt mehrere passende Erinnerungen. Bitte nenne zusätzlich den Zeitpunkt.',
      reminderCancelAmbiguity: {
        candidates: [
          { id: 41, dueLocal: '2026-08-30T16:30' },
          { id: 42, dueLocal: '2026-08-30T17:05' },
        ],
      },
    });
    await first.actionTurn;
    const routerCallsAfterInitialCancel = routerProvider.calls;

    const followup = await startAction(ctx, router, followupText);
    expect(followup.request).toMatchObject({
      action: 'cancel_reminder',
      param: 'id=42',
      provenance: {
        sourceTurnId: followup.request.turnId,
        decisionSource: 'deterministic_shortcut',
        evidenceSource: 'user_text',
        interactionContext: {
          kind: 'reminder_cancel_followup',
          contextTurnId: first.request.turnId,
        },
        validation: 'semantic_grounding',
      },
    });
    expect(routerProvider.calls).toBe(routerCallsAfterInitialCancel);
    ctx.bus.emit('test', 'action:result', {
      turnId: followup.request.turnId,
      requestId: followup.request.requestId,
      action: followup.request.action,
      ok: true,
      speak: 'Die Erinnerung wurde abgebrochen.',
    });
    await followup.actionTurn;
  });

  it.each(['Eins.', 'Die erste.', '1.'])(
    'resolves cancel-reminder list selection %s before normal routing',
    async (followupText) => {
      const routerProvider = new ScriptedProvider(
        'ok',
        '[ACTION:cancel_reminder:text=Essen]',
        '[ACTION:set_timer:1m30s]',
      );
      router = new RouterService(ctx, routerProvider, new ScriptedProvider());
      await router.init();

      const first = await startAction(ctx, router, 'Lösche die Erinnerung Essen');
      ctx.bus.emit('test', 'action:result', {
        turnId: first.request.turnId,
        requestId: first.request.requestId,
        action: first.request.action,
        ok: false,
        reminderCancelAmbiguity: {
          candidates: [
            { id: 61, dueLocal: '2026-08-30T17:15' },
            { id: 62, dueLocal: '2026-08-30T17:16' },
          ],
        },
      });
      await first.actionTurn;
      const routerCallsAfterInitialCancel = routerProvider.calls;

      const followup = await startAction(ctx, router, followupText);
      expect(followup.request).toMatchObject({
        action: 'cancel_reminder',
        param: 'id=61',
      });
      expect(routerProvider.calls).toBe(routerCallsAfterInitialCancel);
      ctx.bus.emit('test', 'action:result', {
        turnId: followup.request.turnId,
        requestId: followup.request.requestId,
        action: followup.request.action,
        ok: true,
        speak: 'Die Erinnerung wurde abgebrochen.',
      });
      await followup.actionTurn;
    },
  );

  it('never guesses when a cancel-reminder time follow-up still matches multiple candidates', async () => {
    const routerProvider = new ScriptedProvider(
      'ok',
      '[ACTION:cancel_reminder:text=Steuerberater anrufen]',
      '[ACTION:set_timer:1m30s]',
    );
    router = new RouterService(
      ctx,
      routerProvider,
      new ScriptedProvider(),
    );
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const outputs: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => outputs.push(message.data.fullText));

    const first = await startAction(ctx, router, 'Brich die Erinnerung Steuerberater anrufen ab');
    ctx.bus.emit('test', 'action:result', {
      turnId: first.request.turnId,
      requestId: first.request.requestId,
      action: first.request.action,
      ok: false,
      reminderCancelAmbiguity: {
        candidates: [
          { id: 51, dueLocal: '2026-08-30T17:05' },
          { id: 52, dueLocal: '2026-08-31T17:05' },
        ],
      },
    });
    await first.actionTurn;

    await router.handleChatMessage('Die um 17:05 Uhr.');

    expect(requests).toHaveLength(1);
    expect(outputs.at(-1)).toBe(
      'Zu dieser Uhrzeit gibt es weiterhin mehrere passende Erinnerungen.',
    );

    const routerCallsAfterInitialCancel = routerProvider.calls;
    const retry = await startAction(ctx, router, 'Eins.');
    expect(retry.request).toMatchObject({
      action: 'cancel_reminder',
      param: 'id=51',
    });
    expect(routerProvider.calls).toBe(routerCallsAfterInitialCancel);
    ctx.bus.emit('test', 'action:result', {
      turnId: retry.request.turnId,
      requestId: retry.request.requestId,
      action: retry.request.action,
      ok: true,
      speak: 'Die Erinnerung wurde abgebrochen.',
    });
    await retry.actionTurn;
  });

  it('rejects an invented reminder text before action dispatch', async () => {
    const routerP = new ScriptedProvider(
      'ok',
      '[ACTION:set_reminder:after=30m|text=Brötchen aus dem Ofen holen]',
    );
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Erinnere mich in 30 Minuten: Steuerberater anrufen');

    expect(requests).toEqual([]);
    expect(done).toContain(
      'Ich konnte den Inhalt der Erinnerung nicht eindeutig aus deiner Anfrage übernehmen. Bitte nenne Zeitpunkt und Inhalt noch einmal zusammen.',
    );
  });

  it('removes invented and duration-shaped timer labels but keeps grounded purposes', async () => {
    const routerP = new ScriptedProvider(
      'ok',
      '[ACTION:set_timer:30s|Halbteller]',
      '[ACTION:set_timer:30s|Timer]',
      '[ACTION:set_timer:1m30s|anderthalb Minuten]',
      '[ACTION:set_timer:8m|Eier]',
      '[ACTION:set_timer:6m|Brötchen]',
    );
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const done: string[] = [];
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    const invented = await runActionTurn('Stelle einen 30 Sekunden-Timer');
    const generic = await runActionTurn('Stelle einen Timer auf 30 Sekunden');
    const duration = await runActionTurn('Stelle einen Timer auf anderthalb Minuten');
    const grounded = await runActionTurn('Stelle einen Eiertimer im Kochtopf auf 8 Minuten');
    const timerCompound = await runActionTurn('Stelle einen Brötchen-Timer auf 6 Minuten');

    expect(invented).toMatchObject({ action: 'set_timer', param: '30s' });
    expect(generic).toMatchObject({ action: 'set_timer', param: '30s' });
    expect(duration).toMatchObject({ action: 'set_timer', param: '1m30s' });
    expect(grounded).toMatchObject({ action: 'set_timer', param: '8m|Eier' });
    expect(timerCompound).toMatchObject({ action: 'set_timer', param: '6m|Brötchen' });
    expect(done).toContain('Ich stelle einen Timer auf 30 Sekunden.');
    expect(done).toContain('Ich stelle einen Timer auf 1 Minute 30 Sekunden.');
    expect(done).toContain('Ich stelle den Eier-Timer auf 8 Minuten.');
    expect(done).toContain('Ich stelle den Brötchen-Timer auf 6 Minuten.');
  });

  it('drops reminder-cancel ambiguity when its owning turn is canceled', async () => {
    const routerProvider = new ScriptedProvider(
      'ok',
      '[ACTION:cancel_reminder:text=Steuerberater anrufen]',
      '[ROUTE:9b]',
    );
    router = new RouterService(ctx, routerProvider, new ScriptedProvider('Keine Auswahl.'));
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));

    const first = await startAction(ctx, router, 'Brich die Erinnerung Steuerberater anrufen ab');
    ctx.bus.emit('test', 'action:result', {
      turnId: first.request.turnId,
      requestId: first.request.requestId,
      action: first.request.action,
      ok: false,
      speak: 'Es gibt mehrere passende Erinnerungen.',
      reminderCancelAmbiguity: {
        candidates: [
          { id: 41, dueLocal: '2026-08-30T16:30' },
          { id: 42, dueLocal: '2026-08-30T17:05' },
        ],
      },
    });
    ctx.bus.emit('test', 'turn:cancel', {
      turnId: first.request.turnId,
      reason: 'barge-in before ambiguity output',
    });
    await first.actionTurn;

    await router.handleChatMessage('Die erste.');

    expect(requests).toHaveLength(1);
  });

  it('rejects invented timer durations and destructive selector escalation', async () => {
    const routerP = new ScriptedProvider(
      'ok',
      '[ACTION:set_timer:50m]',
      '[ACTION:cancel_timer:all]',
    );
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Stelle einen Timer auf 5 Minuten.');
    await router.handleChatMessage('Brich den Eier-Timer ab.');

    expect(requests).toEqual([]);
    expect(done).toEqual([
      'Ich konnte die Timerdauer nicht eindeutig aus deiner Anfrage übernehmen.',
      'Diesen Timer kann ich aus deiner Angabe nicht eindeutig zuordnen.',
    ]);
  });

  it('rejects invalid Timer V2 parameters before action dispatch', async () => {
    const routerP = new ScriptedProvider('ok', '[ACTION:set_timer:30 seconds|Eier]');
    router = new RouterService(ctx, routerP, new ScriptedProvider());
    await router.init();
    const requests: BusEvents['action:request'][] = [];
    const done: string[] = [];
    ctx.bus.on('action:request', (message) => requests.push(message.data));
    ctx.bus.on('llm:done', (message) => done.push(message.data.fullText));

    await router.handleChatMessage('Stelle einen Eier-Timer auf 30 Sekunden');

    expect(requests).toEqual([]);
    expect(done).toEqual(['Ich konnte die Timerdauer nicht eindeutig aus deiner Anfrage übernehmen.']);
  });

});
