import { describe, expect, it } from 'vitest';
import { groundTimerRequest, groundTimerSelector, groundedTimerDurations } from './timer-grounding.js';

describe('timer grounding', () => {
  it.each([
    ['30 Sekunden', 30],
    ['anderthalb Minuten', 90],
    ['1,5 Minuten', 90],
    ['1,75 Minuten', 105],
    ['fünfeinhalb Minuten', 330],
    ['eine Dreiviertelstunde', 2_700],
    ['eine halbe Stunde', 1_800],
    ['eine Viertelstunde', 900],
    ['drei Viertelstunden', 2_700],
    ['1 Stunde 30 Minuten', 5_400],
    ['2 Minuten 36', 156],
  ])('extracts %s as %d seconds', (text, seconds) => {
    expect(groundedTimerDurations(`Stelle einen Timer auf ${text}.`).has(seconds)).toBe(true);
  });

  it('does not accept the incomplete minute part of an implicit-seconds duration', () => {
    const durations = groundedTimerDurations('Stelle einen Timer auf 2 Minuten 36.');
    expect(durations.has(156)).toBe(true);
    expect(durations.has(120)).toBe(false);
  });

  it.each([
    ['eine halbe Stunde und fünf Minuten', 2_100, '35m'],
    ['eine Viertelstunde und 30 Sekunden', 930, '15m30s'],
    ['eine Dreiviertelstunde und zehn Minuten', 3_300, '55m'],
  ])('combines %s into one grounded duration', (text, seconds, canonical) => {
    expect([...groundedTimerDurations(text)]).toEqual([seconds]);
    expect(groundTimerRequest({ durationSeconds: seconds }, text)).toBe(canonical);
  });

  it('never combines separate duration clauses into one authorized timer', () => {
    const text = 'Stelle einen Timer auf 5 Minuten; 10 Minuten brauche ich später fürs Kochen.';

    expect([...groundedTimerDurations(text)]).toEqual([300, 600]);
    expect(groundTimerRequest({ durationSeconds: 900 }, text)).toBeNull();
    expect(groundTimerRequest({ durationSeconds: 300 }, text)).toBeNull();
  });

  it('rejects a model-invented duration and removes only an invented label', () => {
    expect(groundTimerRequest(
      { durationSeconds: 300, label: 'Halbteller' },
      'Stelle einen Timer auf 30 Sekunden.',
    )).toBeNull();
    expect(groundTimerRequest(
      { durationSeconds: 30, label: 'Halbteller' },
      'Stelle einen Timer auf 30 Sekunden.',
    )).toBe('30s');
  });

  it('grounds destructive selectors without escalating to all', () => {
    expect(groundTimerSelector({ kind: 'all' }, 'Brich den Eier-Timer ab.')).toBeNull();
    expect(groundTimerSelector({ kind: 'all' }, 'Brich alle Timer ab.')).toBe('all');
    expect(groundTimerSelector({ kind: 'label', label: 'Brötchen' }, 'Brich den Eier-Timer ab.')).toBeNull();
    expect(groundTimerSelector({ kind: 'label', label: 'Eier' }, 'Brich den Eier-Timer ab.')).toBe('label=Eier');
    expect(groundTimerSelector({ kind: 'duration', durationSeconds: 1_800 }, 'Brich den 5-Minuten-Timer ab.')).toBeNull();
    expect(groundTimerSelector({ kind: 'duration', durationSeconds: 300 }, 'Brich den 5-Minuten-Timer ab.')).toBe('duration=5m');
  });
});
