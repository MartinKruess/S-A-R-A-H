import { describe, it, expect } from 'vitest';
import { buildRoutingPrompt } from './routing-prompt.js';

describe('buildRoutingPrompt media_* coverage', () => {
  const prompt = buildRoutingPrompt();
  it('lists all five media transport actions', () => {
    for (const a of ['media_play', 'media_pause', 'media_toggle', 'media_next', 'media_previous']) {
      expect(prompt).toContain(a);
    }
  });
  it('shows an active-session example (empty target) and a named-target example', () => {
    expect(prompt).toContain('[ACTION:media_pause:]');
    expect(prompt).toContain('[ACTION:media_pause:spotify]');
  });
});
