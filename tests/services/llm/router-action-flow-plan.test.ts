import { describe, expect, it, vi } from 'vitest';
import { ActionConfirmationGate } from '../../../src/core/action-confirmation.js';
import type { ActionIntent } from '../../../src/core/action-intent.js';
import type { AppContext } from '../../../src/core/bootstrap.js';
import type { BusEvents } from '../../../src/core/bus-events.js';
import { SarahConfigSchema } from '../../../src/core/config-schema.js';
import { MessageBus } from '../../../src/core/message-bus.js';
import { ServiceRegistry } from '../../../src/core/service-registry.js';
import type { SarahService } from '../../../src/core/service.interface.js';
import type { ServiceStatus } from '../../../src/core/types.js';
import { prepareTurnEnvelope } from '../../../src/core/turn-contract.js';
import { createSystemReminderClock } from '../../../src/services/actions/reminder-contract.js';
import { MediaContext } from '../../../src/services/llm/media-context.js';
import { RouterActionFlow } from '../../../src/services/llm/router-action-flow.js';

const TURN_ID = '11111111-1111-4111-8111-111111111111';
const TIMER_TEXT = 'Stelle einen Timer auf 10 Minuten';

class StubActionService implements SarahService {
  readonly id = 'actions';
  readonly subscriptions = [] as const;
  status: ServiceStatus;

  constructor(status: ServiceStatus) {
    this.status = status;
  }

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}
  onMessage(): void {}
}

function timerIntent(overrides: Partial<ActionIntent['provenance']> = {}): ActionIntent {
  return {
    action: 'set_timer',
    param: '10m',
    provenance: {
      sourceTurnId: TURN_ID,
      decisionSource: 'router_model',
      validation: 'semantic_grounding',
      evidenceScope: {
        kind: 'clause',
        intentId: 'timer-intent',
        ordinal: 0,
        startOffset: 0,
        endOffset: TIMER_TEXT.length,
      },
      evidenceSource: 'user_text',
      ...overrides,
    },
  };
}

function setup(options: {
  actionStatus?: ServiceStatus;
  confirmationLevel?: 'minimal' | 'standard' | 'maximal';
  webAccessAllowed?: boolean;
} = {}) {
  const bus = new MessageBus();
  const registry = new ServiceRegistry(bus);
  if (options.actionStatus !== undefined) {
    registry.register(new StubActionService(options.actionStatus));
  }
  const parsedConfig = SarahConfigSchema.parse({
    trust: {
      confirmationLevel: options.confirmationLevel ?? 'standard',
      webAccessAllowed: options.webAccessAllowed ?? true,
    },
  });
  const context = {
    bus,
    registry,
    parsedConfig,
    actionConfirmations: new ActionConfirmationGate(),
  } as AppContext;
  const emitAssistantResponse = vi.fn(async () => {});
  const flow = new RouterActionFlow({
    context,
    serviceId: 'router',
    mediaContext: new MediaContext(),
    reminderClock: createSystemReminderClock(),
    actionResultTimeoutMs: 1_000,
    isIncognitoActive: () => false,
    getTurnPrivateContext: () => false,
    emitAssistantResponse,
    markBrowserSearchIntentTransient: vi.fn(),
  });
  bus.on('action:result', (message) => flow.handleActionResult(message.data));
  const envelope = prepareTurnEnvelope({
    turnId: TURN_ID,
    source: 'chat',
    mode: 'chat',
    originalText: TIMER_TEXT,
    createdAt: '2026-09-04T10:00:00.000Z',
  }, []);
  bus.emit('test', 'turn:accepted', { turnId: TURN_ID, source: 'chat', mode: 'chat' });
  return { bus, context, emitAssistantResponse, envelope, flow };
}

describe('RouterActionFlow planned actions', () => {
  it('preflights an immediately allowed clause-grounded intent without side effects', () => {
    const { bus, emitAssistantResponse, flow } = setup({ actionStatus: 'running' });
    const requests: BusEvents['action:request'][] = [];
    bus.on('action:request', (message) => requests.push(message.data));

    expect(flow.preflightPlannedAction(timerIntent())).toEqual({ ok: true });
    expect(requests).toEqual([]);
    expect(emitAssistantResponse).not.toHaveBeenCalled();
  });

  it('reports unavailable, invalid, confirmation-required, and denied preflight states', () => {
    expect(setup().flow.preflightPlannedAction(timerIntent())).toEqual({
      ok: false,
      reason: 'action_service_unavailable',
    });
    expect(setup({ actionStatus: 'stopped' }).flow.preflightPlannedAction(timerIntent())).toEqual({
      ok: false,
      reason: 'action_service_unavailable',
    });
    expect(setup({ actionStatus: 'running' }).flow.preflightPlannedAction(timerIntent({
      validation: 'schema_only',
    }))).toEqual({ ok: false, reason: 'invalid_intent' });
    expect(setup({ actionStatus: 'running', confirmationLevel: 'maximal' })
      .flow.preflightPlannedAction(timerIntent())).toEqual({
      ok: false,
      reason: 'confirmation_required',
    });

    const web = timerIntent();
    const webIntent: ActionIntent = {
      ...web,
      action: 'web_search',
      param: 'Fahrräder',
    };
    expect(setup({ actionStatus: 'running', webAccessAllowed: false })
      .flow.preflightPlannedAction(webIntent)).toEqual({
      ok: false,
      reason: 'policy_denied',
    });
  });

  it('dispatches the unchanged intent and returns its correlated success', async () => {
    const { bus, emitAssistantResponse, envelope, flow } = setup({ actionStatus: 'running' });
    const intent = timerIntent();
    let request: BusEvents['action:request'] | undefined;
    bus.on('action:request', (message) => {
      request = message.data;
      bus.emit('actions', 'action:result', {
        turnId: message.data.turnId,
        requestId: message.data.requestId,
        action: message.data.action,
        ok: true,
        speak: 'Der Timer läuft.',
      });
    });

    await expect(flow.executePlannedAction(envelope, intent, new AbortController().signal))
      .resolves.toEqual({ ok: true });
    expect(request).toMatchObject({
      turnId: TURN_ID,
      action: 'set_timer',
      param: '10m',
    });
    expect(request?.provenance).toBe(intent.provenance);
    expect(emitAssistantResponse.mock.calls.map(([, text]) => text)).toEqual([
      'Ich stelle einen Timer auf 10 Minuten.',
      'Der Timer läuft.',
    ]);
  });

  it('returns a correlated action failure after preserving honest feedback', async () => {
    const { bus, emitAssistantResponse, envelope, flow } = setup({ actionStatus: 'running' });
    bus.on('action:request', (message) => {
      bus.emit('actions', 'action:result', {
        turnId: message.data.turnId,
        requestId: message.data.requestId,
        action: message.data.action,
        ok: false,
        speak: 'Der Timer konnte nicht gestartet werden.',
      });
    });

    await expect(flow.executePlannedAction(envelope, timerIntent(), new AbortController().signal))
      .resolves.toEqual({ ok: false });
    expect(emitAssistantResponse.mock.calls.at(-1)?.[1])
      .toBe('Der Timer konnte nicht gestartet werden.');
  });

  it('rechecks live policy before dispatch and rejects a changed source turn', async () => {
    const { bus, context, emitAssistantResponse, envelope, flow } = setup({
      actionStatus: 'running',
      confirmationLevel: 'standard',
    });
    const requests: BusEvents['action:request'][] = [];
    bus.on('action:request', (message) => requests.push(message.data));
    expect(flow.preflightPlannedAction(timerIntent())).toEqual({ ok: true });

    context.parsedConfig.trust.confirmationLevel = 'maximal';
    await expect(flow.executePlannedAction(envelope, timerIntent(), new AbortController().signal))
      .resolves.toEqual({ ok: false });
    expect(requests).toEqual([]);
    expect(emitAssistantResponse.mock.calls.at(-1)?.[1])
      .toBe('Diese Aktion benötigt zuerst eine einzelne Bestätigung.');

    context.parsedConfig.trust.confirmationLevel = 'standard';
    const foreignIntent = timerIntent({ sourceTurnId: 'foreign-turn' });
    await expect(flow.executePlannedAction(envelope, foreignIntent, new AbortController().signal))
      .resolves.toEqual({ ok: false });
    expect(requests).toEqual([]);
    expect(emitAssistantResponse.mock.calls.at(-1)?.[1])
      .toContain('nicht eindeutig');
  });
});
