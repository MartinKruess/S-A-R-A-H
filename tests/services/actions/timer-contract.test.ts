import { describe, expect, it } from 'vitest';
import {
  cleanTimerLabel,
  formatTimerDuration,
  parseTimerRequest,
  parseTimerSelector,
  serializeTimerRequest,
  serializeTimerSelector,
} from '../../../src/services/actions/timer-contract.js';

describe('timer contract', () => {
  it.each([
    ['1', { durationSeconds: 60 }],
    ['30s', { durationSeconds: 30 }],
    ['5m30s', { durationSeconds: 330 }],
    ['1h30m', { durationSeconds: 5400 }],
    ['45m', { durationSeconds: 2700 }],
    ['24h', { durationSeconds: 86_400 }],
    ['30', { durationSeconds: 1800 }],
  ])('parses set duration %s', (param, expected) => {
    expect(parseTimerRequest(param)).toEqual(expected);
  });

  it.each(['0s', '-1s', '1.5m', '5x', '1m2m', '30s1m', '1h2h', '24h1s', '25h'])('rejects invalid duration %s', (param) => {
    expect(parseTimerRequest(param)).toBeNull();
  });

  it('normalizes labels and rejects empty, long, control and delimiter values', () => {
    expect(parseTimerRequest('5m|  Brötchen   im   Ofen  ')).toEqual({
      durationSeconds: 300,
      label: 'Brötchen im Ofen',
    });
    expect(cleanTimerLabel('Ｅｉｅｒ')).toBe('Eier');
    expect(parseTimerRequest('5m|')).toBeNull();
    expect(parseTimerRequest('5m|   ')).toBeNull();
    expect(parseTimerRequest(`5m|${'a'.repeat(41)}`)).toBeNull();
    expect(parseTimerRequest('5m|Eier\u0000')).toBeNull();
    expect(parseTimerRequest('5m|Eier\t')).toBeNull();
    expect(parseTimerRequest('5m|Eier\u200B')).toBeNull();
    expect(parseTimerRequest('5m|Eier]')).toBeNull();
    expect(parseTimerRequest('5m|Eier|Brötchen')).toBeNull();
  });

  it('serializes requests canonically', () => {
    expect(serializeTimerRequest({ durationSeconds: 330, label: '  Brötchen  ' })).toBe('5m30s|Brötchen');
    expect(serializeTimerRequest({ durationSeconds: 5400 })).toBe('1h30m');
    expect(serializeTimerRequest({ durationSeconds: 0 })).toBeNull();
  });

  it('parses and serializes all selector variants', () => {
    expect(parseTimerSelector('all')).toEqual({ kind: 'all' });
    expect(parseTimerSelector('label=  Eier  ')).toEqual({ kind: 'label', label: 'Eier' });
    expect(parseTimerSelector('duration=30m')).toEqual({ kind: 'duration', durationSeconds: 1800 });
    expect(serializeTimerSelector({ kind: 'all' })).toBe('all');
    expect(serializeTimerSelector({ kind: 'label', label: ' Brötchen ' })).toBe('label=Brötchen');
    expect(serializeTimerSelector({ kind: 'duration', durationSeconds: 330 })).toBe('duration=5m30s');
  });

  it.each(['', 'everything', 'label=', 'label=Eier]', 'duration=0s', 'duration=30s1m'])('rejects invalid selector %s', (param) => {
    expect(parseTimerSelector(param)).toBeNull();
  });

  it('formats German durations deterministically', () => {
    expect(formatTimerDuration(1)).toBe('1 Sekunde');
    expect(formatTimerDuration(330)).toBe('5 Minuten 30 Sekunden');
    expect(formatTimerDuration(5400)).toBe('1 Stunde 30 Minuten');
  });
});
