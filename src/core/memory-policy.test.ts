import { describe, expect, it } from 'vitest';
import { mustKeepTurnTransient } from './memory-policy.js';

describe('mustKeepTurnTransient', () => {
  const browserPolicy = { allowed: true, exclusions: ['Browser-Daten'] } as const;

  it('recognizes actual HTTP(S) URLs as browser data without requiring the word URL', () => {
    expect(mustKeepTurnTransient(['Privat: https://example.com/private'], browserPolicy)).toBe(true);
    expect(mustKeepTurnTransient(['Siehe HTTP://EXAMPLE.COM/path?q=1.'], browserPolicy)).toBe(true);
  });

  it('does not mistake URL-like plain text or other protocols for web URLs', () => {
    expect(mustKeepTurnTransient(['example.com ist nur ein Domainname'], browserPolicy)).toBe(false);
    expect(mustKeepTurnTransient(['mailto:person@example.com'], browserPolicy)).toBe(false);
  });
});
