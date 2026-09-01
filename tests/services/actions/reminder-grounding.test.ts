import { describe, expect, it } from 'vitest';
import {
  parseCancelReminderParam,
  parseSetReminderParam,
  type ReminderClock,
} from '../../../src/services/actions/reminder-contract.js';
import {
  groundSetReminderRequest,
  isCancelReminderRequestGrounded,
  isReminderScheduleGrounded,
  isReminderTextGrounded,
} from '../../../src/services/actions/reminder-grounding.js';

function fixedClock(local: string): ReminderClock {
  const baseMs = Date.parse(`${local}:00.000Z`);
  return {
    nowMs: () => baseMs,
    toLocal: (epochMs) => new Date(epochMs).toISOString().slice(0, 16),
  };
}

function request(wire: string) {
  const parsed = parseSetReminderParam(wire);
  if (!parsed) throw new Error(`invalid test wire: ${wire}`);
  return parsed;
}

function cancelRequest(wire: string) {
  const parsed = parseCancelReminderParam(wire);
  if (!parsed) throw new Error(`invalid cancel test wire: ${wire}`);
  return parsed;
}

describe('reminder grounding', () => {
  const clock = fixedClock('2026-08-30T10:15');

  it('keeps only a contiguous content phrase from the current utterance', () => {
    expect(isReminderTextGrounded(
      'den Steuerberater anzurufen',
      'Erinnere mich morgen um 11 Uhr daran, den Steuerberater anzurufen.',
    )).toBe(true);
    expect(isReminderTextGrounded(
      'Steuerberater und Bank anrufen',
      'Erinnere mich daran, den Steuerberater anzurufen.',
    )).toBe(false);
  });

  it.each([
    [{ kind: 'after', minutes: 30 } as const, 'Erinnere mich in 30 Minuten daran, loszufahren.'],
    [{ kind: 'after', minutes: 90 } as const, 'Erinnere mich in 1 Stunde und 30 Minuten daran, loszufahren.'],
    [{ kind: 'after', minutes: 90 } as const, 'Erinnere mich in anderthalb Stunden daran, loszufahren.'],
    [{ kind: 'after', minutes: 2 * 24 * 60 } as const, 'Erinnere mich in zwei Tagen daran, anzurufen.'],
    [{ kind: 'after', minutes: 7 * 24 * 60 } as const, 'Erinnere mich in einer Woche daran, anzurufen.'],
    [{ kind: 'after', minutes: 10 } as const, 'Erinnerung, zehn Minuten, Haare schneiden.'],
  ])('grounds explicit relative schedule %#', (schedule, userText) => {
    expect(isReminderScheduleGrounded(schedule, userText)).toBe(true);
  });

  it('rejects separate or alternative relative schedules instead of summing them', () => {
    expect(isReminderScheduleGrounded(
      { kind: 'after', minutes: 90 },
      'Erinnere mich in 30 Minuten an Essen und in 1 Stunde an Trinken.',
    )).toBe(false);
    expect(isReminderScheduleGrounded(
      { kind: 'after', minutes: 10 },
      'Erinnere mich in 5 oder 10 Minuten an Essen.',
    )).toBe(false);
  });

  it.each([
    [{ kind: 'tomorrow', time: '11:00' } as const, 'Erinnere mich morgen um 11 Uhr an den Termin.'],
    [{ kind: 'day-after-tomorrow', time: '08:15' } as const, 'Erinnere mich übermorgen um 8:15 an das Medikament.'],
    [{ kind: 'weekday', weekday: 'fri', time: '10:00' } as const, 'Erinnere mich Freitag um 10 Uhr an den Abschluss.'],
    [{ kind: 'month-day', month: 3, day: 17, time: '09:00' } as const, 'Erinnere mich am 17. März um 9 Uhr an den Geburtstag.'],
    [{ kind: 'date', date: '2027-03-17', time: '09:00' } as const, 'Erinnere mich am 17.03.2027 um 9 Uhr an den Termin.'],
    [{ kind: 'time', time: '18:00' } as const, 'Erinnere mich um 18 Uhr an den Feierabend.'],
  ])('grounds explicit absolute schedule %#', (schedule, userText) => {
    expect(isReminderScheduleGrounded(schedule, userText)).toBe(true);
  });

  it('rejects a time-only schedule when the user explicitly named a day or date', () => {
    expect(isReminderScheduleGrounded(
      { kind: 'time', time: '17:06' },
      '30.08.2026 um 17.06 Uhr Remindertest',
    )).toBe(false);
    expect(isReminderScheduleGrounded(
      { kind: 'time', time: '17:06' },
      'Heute um 17.06 Uhr Remindertest',
    )).toBe(false);
  });

  it('binds an absolute time to the reminder clause instead of a time inside its content', () => {
    const userText = 'Erinnere mich morgen um 9 Uhr daran, dass der Termin um 10 Uhr beginnt.';
    expect(isReminderScheduleGrounded({ kind: 'tomorrow', time: '09:00' }, userText)).toBe(true);
    expect(isReminderScheduleGrounded({ kind: 'tomorrow', time: '10:00' }, userText)).toBe(false);
  });

  it('allows alternatives in reminder content but not in the schedule clause', () => {
    expect(isReminderScheduleGrounded(
      { kind: 'tomorrow', time: '09:00' },
      'Erinnere mich morgen um 9 Uhr daran, Milch oder Brot zu kaufen.',
    )).toBe(true);
    expect(isReminderScheduleGrounded(
      { kind: 'after', minutes: 10 },
      'Erinnerung in 10 Minuten Milch oder Brot kaufen.',
    )).toBe(true);
    expect(isReminderScheduleGrounded(
      { kind: 'tomorrow', time: '10:00' },
      'Erinnere mich morgen um 9 oder 10 Uhr an den Termin.',
    )).toBe(false);
  });

  it('rejects model-invented content and time independently', () => {
    const inventedText = request('at=tomorrow@11:00|text=Bank anrufen');
    expect(groundSetReminderRequest(
      inventedText,
      'Erinnere mich morgen um 11 Uhr an den Steuerberater.',
      clock,
    )).toEqual({ ok: false, reason: 'ungrounded_text' });

    const inventedTime = request('at=tomorrow@12:00|text=den Steuerberater');
    expect(groundSetReminderRequest(
      inventedTime,
      'Erinnere mich morgen um 11 Uhr an den Steuerberater.',
      clock,
    )).toEqual({ ok: false, reason: 'ungrounded_time' });
  });

  it('returns a canonical grounded request and concrete future due minute', () => {
    const result = groundSetReminderRequest(
      request('after=90m|text=  loszufahren  '),
      'Erinnere mich in anderthalb Stunden daran, loszufahren.',
      clock,
    );
    expect(result).toEqual({
      ok: true,
      canonicalParam: 'at=date:2026-08-30@11:45|text=loszufahren',
      dueLocal: '2026-08-30T11:45',
    });
  });

  it('normalizes an invented today or tomorrow selector for a bare clock time', () => {
    expect(groundSetReminderRequest(
      request('at=today@09:00|text=Remindertest'),
      'Erstelle ein Reminder 9 Uhr Remindertest.',
      clock,
    )).toEqual({
      ok: true,
      canonicalParam: 'at=date:2026-08-31@09:00|text=Remindertest',
      dueLocal: '2026-08-31T09:00',
    });
    expect(groundSetReminderRequest(
      request('at=tomorrow@11:00|text=Remindertest'),
      '11 Uhr, Remindertest.',
      clock,
    )).toEqual({
      ok: true,
      canonicalParam: 'at=date:2026-08-30@11:00|text=Remindertest',
      dueLocal: '2026-08-30T11:00',
    });
  });

  it('rejects an explicitly grounded but past today schedule', () => {
    const result = groundSetReminderRequest(
      request('at=today@09:00|text=anzurufen'),
      'Erinnere mich heute um 9 Uhr daran, anzurufen.',
      clock,
    );
    expect(result).toEqual({ ok: false, reason: 'non_future_time' });
  });

  it('grounds cancellation selectors without escalating an ambiguous request to all', () => {
    expect(isCancelReminderRequestGrounded(
      cancelRequest('text=Steuerberater anrufen'),
      'Brich die Erinnerung Steuerberater anrufen ab.',
    )).toBe(true);
    expect(isCancelReminderRequestGrounded(
      cancelRequest('at=tomorrow@11:00|text=Steuerberater anrufen'),
      'Brich die Erinnerung morgen um 11 Uhr an Steuerberater anrufen ab.',
    )).toBe(true);
    expect(isCancelReminderRequestGrounded(
      cancelRequest('all'),
      'Brich die Erinnerung an den Steuerberater ab.',
    )).toBe(false);
    expect(isCancelReminderRequestGrounded(
      cancelRequest('all'),
      'Brich alle meine Erinnerungen ab.',
    )).toBe(true);
    expect(isCancelReminderRequestGrounded(
      cancelRequest('id=3'),
      'Brich die Erinnerung um 3 Uhr ab.',
    )).toBe(false);
    expect(isCancelReminderRequestGrounded(
      cancelRequest('id=3'),
      'Brich Erinnerung 3 ab.',
    )).toBe(false);
  });
});
