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
});
