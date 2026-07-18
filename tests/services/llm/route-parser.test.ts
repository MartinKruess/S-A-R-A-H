import { describe, it, expect } from 'vitest';
import { parseRouteTag } from '../../../src/services/llm/route-parser';

describe('parseRouteTag', () => {
  it('parses [ROUTE:self] with feedback', () => {
    const result = parseRouteTag('[ROUTE:self] Natürlich, öffne ich sofort!');
    expect(result).toEqual({ kind: 'route', route: 'self', feedback: 'Natürlich, öffne ich sofort!' });
  });

  it('parses [ROUTE:9b] with feedback', () => {
    const result = parseRouteTag('[ROUTE:9b] Oh das muss ich mir genauer ansehen.');
    expect(result).toEqual({ kind: 'route', route: '9b', feedback: 'Oh das muss ich mir genauer ansehen.' });
  });

  it('parses [ROUTE:backend] with feedback', () => {
    const result = parseRouteTag('[ROUTE:backend] Ich sehe mir das an, das dauert einen Moment.');
    expect(result).toEqual({ kind: 'route', route: 'backend', feedback: 'Ich sehe mir das an, das dauert einen Moment.' });
  });

  it('parses [ROUTE:extern] with feedback', () => {
    const result = parseRouteTag('[ROUTE:extern] Das leite ich weiter.');
    expect(result).toEqual({ kind: 'route', route: 'extern', feedback: 'Das leite ich weiter.' });
  });

  it('parses [ROUTE:vision] with feedback', () => {
    const result = parseRouteTag('[ROUTE:vision] Lass mich das Bild ansehen.');
    expect(result).toEqual({ kind: 'route', route: 'vision', feedback: 'Lass mich das Bild ansehen.' });
  });

  it('returns self fallback when no tag present', () => {
    const result = parseRouteTag('Klar, mache ich!');
    expect(result).toEqual({ kind: 'route', route: 'self', feedback: 'Klar, mache ich!' });
  });

  it('returns self fallback for empty string', () => {
    const result = parseRouteTag('');
    expect(result).toEqual({ kind: 'route', route: 'self', feedback: '' });
  });

  it('handles tag with leading whitespace', () => {
    const result = parseRouteTag('  [ROUTE:9b] Moment bitte.');
    expect(result).toEqual({ kind: 'route', route: '9b', feedback: 'Moment bitte.' });
  });

  it('handles tag with newlines in feedback', () => {
    const result = parseRouteTag('[ROUTE:self] Zeile eins.\nZeile zwei.');
    expect(result).toEqual({ kind: 'route', route: 'self', feedback: 'Zeile eins.\nZeile zwei.' });
  });

  it('falls back to 9b for unknown route tag', () => {
    const result = parseRouteTag('[ROUTE:bla] Irgendwas.');
    expect(result).toEqual({ kind: 'route', route: '9b', feedback: 'Irgendwas.' });
  });

  describe('parseRouteTag — ACTION tags', () => {
    it('parses a simple action with param', () => {
      expect(parseRouteTag('[ACTION:open_program:spotify] Ich öffne Spotify.')).toEqual({
        kind: 'action', action: 'open_program', param: 'spotify', feedback: 'Ich öffne Spotify.',
      });
    });

    it('keeps colons after the second one inside the param', () => {
      expect(parseRouteTag('[ACTION:web_search:hotels: kiel] Moment.')).toEqual({
        kind: 'action', action: 'web_search', param: 'hotels: kiel', feedback: 'Moment.',
      });
    });

    it('parses a param-less action as empty-string param', () => {
      expect(parseRouteTag('[ACTION:lock_screen] Bis gleich.')).toEqual({
        kind: 'action', action: 'lock_screen', param: '', feedback: 'Bis gleich.',
      });
    });

    it('allows leading whitespace, nothing else, before the tag', () => {
      expect(parseRouteTag('  [ACTION:set_volume:50] Ok.').kind).toBe('action');
      expect(parseRouteTag('Klar! [ACTION:set_volume:50] Ok.').kind).toBe('route'); // Tag nicht am Anfang → kein Tag
    });

    it('treats nested/multiple tags as feedback text, never as second action', () => {
      const result = parseRouteTag('[ACTION:set_timer:10] Ok [ACTION:lock_screen] haha');
      expect(result).toEqual({ kind: 'action', action: 'set_timer', param: '10', feedback: 'Ok [ACTION:lock_screen] haha' });
    });

    it('returns unknown action names verbatim (validation happens at the allowlist)', () => {
      expect(parseRouteTag('[ACTION:send_all_data:evil] Klar.')).toEqual({
        kind: 'action', action: 'send_all_data', param: 'evil', feedback: 'Klar.',
      });
    });

    it('keeps full backwards compatibility for all ROUTE cases', () => {
      expect(parseRouteTag('[ROUTE:self] Hallo!')).toEqual({ kind: 'route', route: 'self', feedback: 'Hallo!' });
      expect(parseRouteTag('[ROUTE:9b] Moment.')).toEqual({ kind: 'route', route: '9b', feedback: 'Moment.' });
      expect(parseRouteTag('[ROUTE:unsinn] X')).toEqual({ kind: 'route', route: '9b', feedback: 'X' });
      expect(parseRouteTag('kein Tag')).toEqual({ kind: 'route', route: 'self', feedback: 'kein Tag' });
    });
  });
});
