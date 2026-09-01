import { describe, expect, it } from 'vitest';
import { resolveBrowserResultFollowup } from '../../../src/services/search/browser-result-followup.js';

describe('browser result follow-up', () => {
  it.each([
    ['Öffne Ergebnis 1', '1'],
    ['Zeige mir das 1. Ergebnis', '1'],
    ['Öffne das erste Ergebnis im Browser', '1'],
    ['Zeig mir das zweite Hotel', '2'],
    ['Rufe den dritten Treffer auf', '3'],
    ['Zeige Ergebnis 8', '8'],
  ])('maps %s to result %s', (text, expected) => {
    expect(resolveBrowserResultFollowup(text)).toBe(expected);
  });

  it('extracts an explicit result title without treating it as a new search', () => {
    expect(resolveBrowserResultFollowup(
      'Öffne das Ergebnis OWASP Foundation im Browser',
    )).toBe('OWASP Foundation');
  });

  it.each([
    'Öffne Spotify',
    'Das erste Ergebnis ist interessant',
    'Suche nach dem ersten Hotel',
    'Erkläre mir Ergebnis 1',
  ])('does not intercept unrelated text: %s', (text) => {
    expect(resolveBrowserResultFollowup(text)).toBeNull();
  });
});
