import { describe, it, expect } from 'vitest';
import { parseRouteTag } from '../../../src/services/llm/route-parser';

describe('parseRouteTag', () => {
  it('parses [ROUTE:self] with feedback', () => {
    const result = parseRouteTag('[ROUTE:self] Natürlich, öffne ich sofort!');
    expect(result).toEqual({ route: 'self', feedback: 'Natürlich, öffne ich sofort!' });
  });

  it('parses [ROUTE:9b] with feedback', () => {
    const result = parseRouteTag('[ROUTE:9b] Oh das muss ich mir genauer ansehen.');
    expect(result).toEqual({ route: '9b', feedback: 'Oh das muss ich mir genauer ansehen.' });
  });

  it('parses [ROUTE:backend] with feedback', () => {
    const result = parseRouteTag('[ROUTE:backend] Ich sehe mir das an, das dauert einen Moment.');
    expect(result).toEqual({ route: 'backend', feedback: 'Ich sehe mir das an, das dauert einen Moment.' });
  });

  it('parses [ROUTE:extern] with feedback', () => {
    const result = parseRouteTag('[ROUTE:extern] Das leite ich weiter.');
    expect(result).toEqual({ route: 'extern', feedback: 'Das leite ich weiter.' });
  });

  it('parses [ROUTE:vision] with feedback', () => {
    const result = parseRouteTag('[ROUTE:vision] Lass mich das Bild ansehen.');
    expect(result).toEqual({ route: 'vision', feedback: 'Lass mich das Bild ansehen.' });
  });

  it('returns self fallback when no tag present', () => {
    const result = parseRouteTag('Klar, mache ich!');
    expect(result).toEqual({ route: 'self', feedback: 'Klar, mache ich!' });
  });

  it('returns self fallback for empty string', () => {
    const result = parseRouteTag('');
    expect(result).toEqual({ route: 'self', feedback: '' });
  });

  it('handles tag with leading whitespace', () => {
    const result = parseRouteTag('  [ROUTE:9b] Moment bitte.');
    expect(result).toEqual({ route: '9b', feedback: 'Moment bitte.' });
  });

  it('handles tag with newlines in feedback', () => {
    const result = parseRouteTag('[ROUTE:self] Zeile eins.\nZeile zwei.');
    expect(result).toEqual({ route: 'self', feedback: 'Zeile eins.\nZeile zwei.' });
  });

  it('falls back to self for unknown route tag', () => {
    const result = parseRouteTag('[ROUTE:bla] Irgendwas.');
    expect(result).toEqual({ route: 'self', feedback: 'Irgendwas.' });
  });
});
