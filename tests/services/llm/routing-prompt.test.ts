import { describe, it, expect } from 'vitest';
import { createDecisionContext } from '../../../src/core/decision-context.js';
import { buildRoutingPrompt } from '../../../src/services/llm/routing-prompt.js';

const decisionContext = createDecisionContext({
  version: 1,
  turn: {
    turnId: 'routing-prompt-turn',
    mode: 'chat',
    privateContext: false,
    inputOrigin: { kind: 'user_text' },
  },
  programRoles: [],
  preferredSourceHints: [],
  capabilities: {
    lifecycleGeneration: 1,
    modelExecutionMode: 'exclusive',
    router: { state: 'available', reason: 'ready' },
    localAnswer: { state: 'available', reason: 'ready' },
    actions: { state: 'available', reason: 'ready' },
    webSearch: { state: 'available', reason: 'ready' },
    visibleBrowserResult: { state: 'available', reason: 'ready' },
    reminders: { state: 'available', reason: 'ready' },
    media: { state: 'unknown', reason: 'no_readiness_source' },
    specialists: {
      coding: { state: 'unavailable', reason: 'no_adapter' },
      research: { state: 'unavailable', reason: 'no_adapter' },
      vision: { state: 'unavailable', reason: 'no_adapter' },
    },
  },
});

describe('buildRoutingPrompt media_* coverage', () => {
  const prompt = buildRoutingPrompt();
  it('lists all five media transport actions', () => {
    for (const a of ['media_play', 'media_pause', 'media_toggle', 'media_next', 'media_previous']) {
      expect(prompt).toContain(a);
    }
  });
  it('shows an active-session example with an empty target', () => {
    expect(prompt).toContain('[ACTION:media_pause:]');
  });
});

describe('buildRoutingPrompt output contract', () => {
  it('limits plan actions to the clause-grounded subset', () => {
    const prompt = buildRoutingPrompt(new Date(2026, 8, 4, 10, 0), decisionContext);

    expect(prompt).toContain('Plan action intents may use only open_program, web_search');
    expect(prompt).toContain('lock_screen');
    expect(prompt).toContain('Generic media transport remains legacy single-intent only');
    expect(prompt).toContain('complete search clause');
    expect(prompt).toContain('Hotels und Restaurants');
    expect(prompt).toContain('behind a long conditional aside or sentence boundary');
    expect(prompt).toContain('Do not propose any sequential answer after an earlier action');
    expect(prompt).toContain('Action-result context is not available to plans yet');
    expect(prompt).toContain('Questions that explicitly ask which reminders');
  });

  it('permits only provider-neutral single coding or research handoffs', () => {
    const availableContext = createDecisionContext({
      ...decisionContext,
      capabilities: {
        ...decisionContext.capabilities,
        specialists: {
          coding: { state: 'available', reason: 'ready' },
          research: { state: 'available', reason: 'ready' },
          vision: { state: 'unavailable', reason: 'no_adapter' },
        },
      },
    });
    const prompt = buildRoutingPrompt(new Date(2026, 8, 4, 10, 0), availableContext);

    expect(prompt).toContain('exactly 1 explicit coding or research delegation goal');
    expect(prompt).toContain('A single action, answer or vision request still uses exactly one legacy tag');
    expect(prompt).toContain('Never name or choose a provider');
    expect(prompt).toContain('User: Baue TTS in Sarah ein');
    expect(prompt).toContain('"specialist":"coding"');
    expect(prompt).toContain('User: Wie implementiert man TTS?\n[ROUTE:9b]');
    expect(prompt).toContain('User: Wann fand die Fußball-WM statt?\n[ROUTE:9b]');
  });

  it('forbids user-visible prose and routes every non-action to the worker', () => {
    const prompt = buildRoutingPrompt();

    expect(prompt).toContain('Return EXACTLY ONE tag and nothing else');
    expect(prompt).toContain('Never answer the user');
    expect(prompt).toContain('For every non-action message return [ROUTE:9b]');
    expect(prompt).not.toContain('[ROUTE:self]');
    expect(prompt).not.toContain('SARAH_PROPOSAL_V1');
  });

  it('defines Timer V2 durations, semantic labels and explicit cancel selectors', () => {
    const prompt = buildRoutingPrompt();

    expect(prompt).toContain('[ACTION:set_timer:<duration>|<optional short label>]');
    expect(prompt).toContain('[ACTION:set_timer:5m30s|Brötchen]');
    expect(prompt).toContain('"30 Sekunden" is 30s, never 30 minutes');
    expect(prompt).toContain('without a fixed vocabulary');
    expect(prompt).toContain('NEVER invent or infer a label');
    expect(prompt).toContain('Without an explicit purpose or object, output no | and no label');
    expect(prompt).toContain('User: Stelle einen 30 Sekunden-Timer\n[ACTION:set_timer:30s]');
    expect(prompt).toContain('User: Stelle einen Timer auf anderthalb Minuten\n[ACTION:set_timer:1m30s]');
    expect(prompt).toContain('User: Stelle einen Timer auf 2 Minuten 36\n[ACTION:set_timer:2m36s]');
    expect(prompt).toContain('User: Stelle einen Timer für die Eier im Kochtopf auf 8 Minuten\n[ACTION:set_timer:8m|Eier]');
    expect(prompt).toContain('[ACTION:cancel_timer:label=Eier]');
    expect(prompt).toContain('[ACTION:cancel_timer:duration=30m]');
    expect(prompt).toContain('[ACTION:cancel_timer:all]');
  });

  it('defines persistent reminders separately from relative timers', () => {
    const prompt = buildRoutingPrompt(new Date(2026, 7, 30, 15, 22));

    expect(prompt).toContain('Absolute clock times and reminders are not timers');
    expect(prompt).toContain('The local system clock is 2026-08-30 15:22, weekday=sun');
    expect(prompt).toContain('[ACTION:set_reminder:after=30m|text=Steuerberater anrufen]');
    expect(prompt).toContain('[ACTION:set_reminder:at=tomorrow@11:00|text=Steuerberater anrufen]');
    expect(prompt).toContain('[ACTION:set_reminder:at=today@17:04|text=Reminder-Test]');
    expect(prompt).toContain('[ACTION:set_reminder:at=time@17:05|text=Remindertest]');
    expect(prompt).toContain('[ACTION:set_reminder:at=date:2026-08-30@17:06|text=Remindertest]');
    expect(prompt).toContain('[ACTION:set_reminder:after=10m|text=Haare schneiden]');
    expect(prompt).toContain('[ACTION:cancel_reminder:text=Essen]');
    expect(prompt).toContain('[ACTION:set_timer:3m|Eier kochen]');
    expect(prompt).toContain('[ACTION:list_reminders:upcoming]');
    expect(prompt).toContain('[ACTION:list_reminders:today]');
    expect(prompt).toContain('[ACTION:cancel_reminder:all]');
    expect(prompt).toContain('User: Erinnere mich morgen an den Steuerberater\n[ROUTE:9b]');
    expect(prompt).toContain('User: Erinnere mich in 30 Sekunden an die Brötchen\n[ROUTE:9b]');
  });
});
