import { describe, it, expect } from 'vitest';
import { buildRoutingPrompt } from './routing-prompt.js';

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
  it('forbids user-visible prose and routes every non-action to the worker', () => {
    const prompt = buildRoutingPrompt();

    expect(prompt).toContain('Return EXACTLY ONE tag and nothing else');
    expect(prompt).toContain('Never answer the user');
    expect(prompt).toContain('For every non-action message return [ROUTE:9b]');
    expect(prompt).not.toContain('[ROUTE:self]');
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

  it('routes absolute clock times and reminders away from relative timer actions', () => {
    const prompt = buildRoutingPrompt();

    expect(prompt).toContain('Absolute clock times and reminders are not timers');
    expect(prompt).toContain('User: Erinnere mich um 13:45 Uhr\n[ROUTE:9b]');
  });
});
