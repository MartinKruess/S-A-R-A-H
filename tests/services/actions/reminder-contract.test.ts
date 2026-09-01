import { describe, expect, it } from 'vitest';
import {
  MAX_REMINDER_DELAY_MINUTES,
  cleanReminderText,
  parseCancelReminderParam,
  parseListReminderParam,
  parseSetReminderParam,
  resolveReminderDueLocal,
  serializeCancelReminderParam,
  serializeSetReminderParam,
  type ReminderClock,
} from '../../../src/services/actions/reminder-contract.js';

function fixedClock(local: string): ReminderClock {
  const baseMs = Date.parse(`${local}:00.000Z`);
  return {
    nowMs: () => baseMs,
    toLocal: (epochMs) => new Date(epochMs).toISOString().slice(0, 16),
  };
}

describe('reminder contract', () => {
  it.each([
    ['after=30m|text=Steuerberater anrufen', 'after=30m|text=Steuerberater anrufen'],
    ['after=1h30m|text=Losfahren', 'after=1h30m|text=Losfahren'],
    ['after=2d|text=Pflanzen gießen', 'after=2d|text=Pflanzen gießen'],
    ['after=1w|text=Mülltonne rausstellen', 'after=1w|text=Mülltonne rausstellen'],
    ['after=90m|text=  Losfahren  ', 'after=1h30m|text=Losfahren'],
    ['at=today@14:30|text=Pause machen', 'at=today@14:30|text=Pause machen'],
    ['at=tomorrow@11:00|text=Steuerberater anrufen', 'at=tomorrow@11:00|text=Steuerberater anrufen'],
    ['at=day-after-tomorrow@08:15|text=Medikament nehmen', 'at=day-after-tomorrow@08:15|text=Medikament nehmen'],
    ['at=weekday:fri@10:00|text=Wochenabschluss', 'at=weekday:fri@10:00|text=Wochenabschluss'],
    ['at=month-day:03-17@09:00|text=Geburtstag', 'at=month-day:03-17@09:00|text=Geburtstag'],
    ['at=date:2027-03-17@09:00|text=Termin', 'at=date:2027-03-17@09:00|text=Termin'],
    ['at=time@18:00|text=Feierabend', 'at=time@18:00|text=Feierabend'],
  ])('parses and canonically serializes %s', (wire, canonical) => {
    const parsed = parseSetReminderParam(wire);
    expect(parsed).not.toBeNull();
    if (parsed) expect(serializeSetReminderParam(parsed)).toBe(canonical);
  });

  it.each([
    'after=30s|text=Nicht runden',
    'after=0m|text=Ungültig',
    `after=${MAX_REMINDER_DELAY_MINUTES + 1}m|text=Zu weit`,
    'after=1m1h|text=Falsche Reihenfolge',
    'after=1h|text=',
    'after=1h',
    'at=tomorrow|text=Uhrzeit fehlt',
    'at=today@24:00|text=Ungültig',
    'at=weekday:funday@10:00|text=Ungültig',
    'at=date:2027-02-29@10:00|text=Ungültig',
    'after=1h|text=Böse|Action',
    'after=1h|text=Böse]Action',
  ])('rejects invalid set wire %s', (wire) => {
    expect(parseSetReminderParam(wire)).toBeNull();
  });

  it('normalizes reminder text without accepting control characters or wire delimiters', () => {
    expect(cleanReminderText('  Steuerberater   anrufen  ')).toBe('Steuerberater anrufen');
    expect(cleanReminderText('ＡＢＣ')).toBe('ABC');
    expect(cleanReminderText('Zeile\nZwei')).toBeNull();
    expect(cleanReminderText('A|B')).toBeNull();
  });

  it('parses list selectors strictly', () => {
    expect(parseListReminderParam(' TODAY ')).toBe('today');
    expect(parseListReminderParam('upcoming')).toBe('upcoming');
    expect(parseListReminderParam('tomorrow')).toBeNull();
  });

  it.each([
    ['all', 'all'],
    ['id=42', 'id=42'],
    ['text=  Steuerberater anrufen  ', 'text=Steuerberater anrufen'],
    ['at=tomorrow@11:00', 'at=tomorrow@11:00'],
    ['at=weekday:fri@10:00|text=Wochenabschluss', 'at=weekday:fri@10:00|text=Wochenabschluss'],
  ])('parses and canonically serializes cancel selector %s', (wire, canonical) => {
    const parsed = parseCancelReminderParam(wire);
    expect(parsed).not.toBeNull();
    if (parsed) expect(serializeCancelReminderParam(parsed)).toBe(canonical);
  });

  it.each([
    'id=0',
    'id=1.5',
    'text=',
    'at=tomorrow',
    'at=tomorrow@11:00|text=',
    'after=30m',
    'something',
  ])('rejects invalid cancel selector %s', (wire) => {
    expect(parseCancelReminderParam(wire)).toBeNull();
  });
});

describe('local reminder resolution', () => {
  const clock = fixedClock('2026-08-30T10:15'); // Sunday

  it('resolves relative durations and the midnight boundary', () => {
    expect(resolveReminderDueLocal({ kind: 'after', minutes: 30 }, clock)).toBe('2026-08-30T10:45');
    const late = fixedClock('2026-12-31T23:45');
    expect(resolveReminderDueLocal({ kind: 'after', minutes: 30 }, late)).toBe('2027-01-01T00:15');
  });

  it('rounds relative reminders up so minute precision never fires early', () => {
    const nowMs = Date.parse('2026-08-30T10:15:45.000Z');
    const withSeconds: ReminderClock = {
      nowMs: () => nowMs,
      toLocal: (epochMs) => new Date(epochMs).toISOString().slice(0, 16),
    };

    expect(resolveReminderDueLocal({ kind: 'after', minutes: 30 }, withSeconds)).toBe('2026-08-30T10:46');
  });

  it('resolves today, tomorrow and day-after-tomorrow without changing explicit past today', () => {
    expect(resolveReminderDueLocal({ kind: 'today', time: '11:00' }, clock)).toBe('2026-08-30T11:00');
    expect(resolveReminderDueLocal({ kind: 'today', time: '10:00' }, clock)).toBeNull();
    expect(resolveReminderDueLocal({ kind: 'tomorrow', time: '09:00' }, clock)).toBe('2026-08-31T09:00');
    expect(resolveReminderDueLocal({ kind: 'day-after-tomorrow', time: '09:00' }, clock)).toBe('2026-09-01T09:00');
  });

  it('moves a pure elapsed clock time to tomorrow only when it already passed', () => {
    expect(resolveReminderDueLocal({ kind: 'time', time: '11:00' }, clock)).toBe('2026-08-30T11:00');
    expect(resolveReminderDueLocal({ kind: 'time', time: '10:00' }, clock)).toBe('2026-08-31T10:00');
  });

  it('resolves the next future weekday occurrence', () => {
    expect(resolveReminderDueLocal({ kind: 'weekday', weekday: 'fri', time: '10:00' }, clock)).toBe('2026-09-04T10:00');
    expect(resolveReminderDueLocal({ kind: 'weekday', weekday: 'sun', time: '11:00' }, clock)).toBe('2026-08-30T11:00');
    expect(resolveReminderDueLocal({ kind: 'weekday', weekday: 'sun', time: '10:00' }, clock)).toBe('2026-09-06T10:00');
  });

  it('resolves month-day across year and leap-year boundaries', () => {
    expect(resolveReminderDueLocal({ kind: 'month-day', month: 8, day: 31, time: '09:00' }, clock)).toBe('2026-08-31T09:00');
    expect(resolveReminderDueLocal({ kind: 'month-day', month: 3, day: 17, time: '09:00' }, clock)).toBe('2027-03-17T09:00');
    const afterLeapDay = fixedClock('2028-03-01T09:00');
    expect(resolveReminderDueLocal({ kind: 'month-day', month: 2, day: 29, time: '09:00' }, afterLeapDay)).toBe('2032-02-29T09:00');
  });

  it('accepts only future explicit dates', () => {
    expect(resolveReminderDueLocal({ kind: 'date', date: '2027-03-17', time: '09:00' }, clock)).toBe('2027-03-17T09:00');
    expect(resolveReminderDueLocal({ kind: 'date', date: '2026-08-29', time: '09:00' }, clock)).toBeNull();
  });

  it('accepts a repeated local minute only when the later DST occurrence is still ahead', () => {
    const nowMs = Date.parse('2026-10-25T00:30:30.000Z');
    const repeatedMinuteClock: ReminderClock = {
      nowMs: () => nowMs,
      toLocal: (epochMs) => {
        if (epochMs === nowMs || epochMs === nowMs + 60 * 60_000 - 30_000) {
          return '2026-10-25T02:30';
        }
        return '2026-10-25T02:31';
      },
    };

    expect(resolveReminderDueLocal(
      { kind: 'date', date: '2026-10-25', time: '02:30' },
      repeatedMinuteClock,
    )).toBe('2026-10-25T02:30');
    expect(resolveReminderDueLocal(
      { kind: 'date', date: '2026-10-25', time: '02:29' },
      repeatedMinuteClock,
    )).toBeNull();
  });
});
