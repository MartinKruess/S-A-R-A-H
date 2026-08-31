import {
  normalizeReminderTextForMatch,
  resolveReminderDueLocal,
  serializeSetReminderParam,
  type ReminderAbsoluteSchedule,
  type ReminderClock,
  type ReminderSchedule,
  type ReminderWeekday,
  type CancelReminderRequest,
  type SetReminderRequest,
} from './reminder-contract.js';

export type ReminderGroundingFailure = 'invalid_param' | 'ungrounded_text' | 'ungrounded_time' | 'non_future_time';

export type ReminderGroundingResult =
  | { ok: true; canonicalParam: string; dueLocal: string }
  | { ok: false; reason: ReminderGroundingFailure };

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  ein: 1,
  eine: 1,
  einen: 1,
  einer: 1,
  einem: 1,
  eins: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fünf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwölf: 12,
};

const WEEKDAY_WORDS: Readonly<Record<ReminderWeekday, string>> = {
  mon: 'montag',
  tue: 'dienstag',
  wed: 'mittwoch',
  thu: 'donnerstag',
  fri: 'freitag',
  sat: 'samstag',
  sun: 'sonntag',
};

const MONTH_WORDS = [
  '', 'januar', 'februar', 'märz', 'april', 'mai', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'dezember',
] as const;

function normalizeUserText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('de-DE');
}

function reminderScheduleClause(userText: string): string {
  return normalizeUserText(userText).split(/\b(?:daran|damit|um\s+zu|an)\b/u, 1)[0].trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function hasGroundedPhrase(userText: string, phrase: string): boolean {
  const normalizedUser = normalizeUserText(userText);
  const normalizedPhrase = normalizeReminderTextForMatch(phrase);
  if (!normalizedPhrase) return false;
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedPhrase)}(?=$|[^\\p{L}\\p{N}])`,
    'u',
  ).test(normalizedUser);
}

function hasWholeToken(userText: string, token: string): boolean {
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(token)}(?=$|[^\\p{L}\\p{N}])`,
    'u',
  ).test(userText);
}

function parseAmount(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number(value);
  return NUMBER_WORDS[value] ?? null;
}

function relativeUnitMinutes(unit: string): number {
  if (unit.startsWith('woche')) return 7 * 24 * 60;
  if (unit.startsWith('tag')) return 24 * 60;
  if (unit.startsWith('stunde')) return 60;
  return 1;
}

function relativeUnitRank(unit: string): number {
  if (unit.startsWith('woche')) return 4;
  if (unit.startsWith('tag')) return 3;
  if (unit.startsWith('stunde')) return 2;
  return 1;
}

function groundedRelativeMinutes(userText: string): readonly number[] {
  const normalized = normalizeUserText(userText);
  const scheduleClause = reminderScheduleClause(userText);
  if (/\bund\s+in\s+(?:\d+|ein|eine|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\b/u.test(normalized)) {
    return [];
  }
  const afterIn = /\bin\s+(.+)$/u.exec(scheduleClause)?.[1];
  const shorthand = /\b(?:erinnerung|reminder)\b/u.test(scheduleClause)
    ? scheduleClause
    : null;
  const durationSource = afterIn ?? shorthand;
  if (!durationSource) return [];
  const bounded = durationSource;
  const results = new Set<number>();
  const specialDurations = [
    { match: /\b(?:anderthalb|eineinhalb)\s+stunden?\b/u.exec(bounded), minutes: 90 },
    { match: /\b(?:eine\s+)?dreiviertelstunde\b/u.exec(bounded), minutes: 45 },
  ] as const;
  for (const special of specialDurations) {
    if (special.match) results.add(special.minutes);
  }

  const unitPattern = /(\d+|ein|eine|einen|einer|einem|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s*(minuten?|stunden?|tage?|wochen?)/gu;
  const parts: Array<{ start: number; end: number; minutes: number; rank: number }> = [];
  for (const match of bounded.matchAll(unitPattern)) {
    const amount = parseAmount(match[1]);
    if (amount === null || match.index === undefined) continue;
    parts.push({
      start: match.index,
      end: match.index + match[0].length,
      minutes: amount * relativeUnitMinutes(match[2]),
      rank: relativeUnitRank(match[2]),
    });
  }
  const lastDurationEnd = Math.max(
    ...parts.map((part) => part.end),
    ...specialDurations.map(({ match }) => match?.index === undefined ? 0 : match.index + match[0].length),
  );
  const scheduleEvidence = lastDurationEnd > 0 ? bounded.slice(0, lastDurationEnd) : bounded;
  if (/\b(?:oder|sondern)\b/u.test(scheduleEvidence)) return [];
  let group: typeof parts = [];
  const commitGroup = (): void => {
    if (group.length > 0) results.add(group.reduce((sum, part) => sum + part.minutes, 0));
  };
  for (const part of parts) {
    const previous = group[group.length - 1];
    const joinsPrevious = previous
      && part.rank < previous.rank
      && /^[\s,]*(?:und[\s,]*)?$/u.test(bounded.slice(previous.end, part.start));
    if (!joinsPrevious) {
      commitGroup();
      group = [];
    }
    group.push(part);
  }
  commitGroup();
  return [...results];
}

function isTimeGrounded(time: string, userText: string): boolean {
  const normalized = normalizeUserText(userText);
  const [hourText, minuteText] = time.split(':');
  const hour = String(Number(hourText));
  const minute = String(Number(minuteText));
  if (new RegExp(`(?:^|\\D)${hourText}:${minuteText}(?=$|\\D)`, 'u').test(normalized)) return true;
  if (new RegExp(`(?:^|\\D)${hour}[.:]${minuteText}(?=$|\\D)`, 'u').test(normalized)) return true;
  if (minuteText === '00' && new RegExp(`(?:^|\\D)${hour}\\s+uhr(?=$|\\D)`, 'u').test(normalized)) return true;
  return new RegExp(`(?:^|\\D)${hour}\\s+uhr\\s+${minute}(?=$|\\D)`, 'u').test(normalized);
}

function groundedClockTimes(userText: string): ReadonlySet<string> {
  const normalized = reminderScheduleClause(userText);
  const times = new Set<string>();
  const add = (hour: string, minute: string): void => {
    times.add(`${String(Number(hour)).padStart(2, '0')}:${minute.padStart(2, '0')}`);
  };
  for (const match of normalized.matchAll(/(?:^|\D)([01]?\d|2[0-3])[.:]([0-5]\d)(?!\.\d)(?=$|\D)/gu)) {
    add(match[1], match[2]);
  }
  for (const match of normalized.matchAll(/\b([01]?\d|2[0-3])\s+uhr(?:\s+([0-5]?\d))?\b/gu)) {
    add(match[1], match[2] ?? '00');
  }
  return times;
}

function isAbsoluteDayGrounded(schedule: ReminderAbsoluteSchedule, userText: string): boolean {
  const normalized = normalizeUserText(userText);
  switch (schedule.kind) {
    case 'today':
      return hasWholeToken(normalized, 'heute');
    case 'tomorrow':
      return hasWholeToken(normalized, 'morgen') && !hasWholeToken(normalized, 'übermorgen');
    case 'day-after-tomorrow':
      return hasWholeToken(normalized, 'übermorgen');
    case 'time':
      return !hasExplicitDaySelector(normalized);
    case 'weekday':
      return new RegExp(`\\b${WEEKDAY_WORDS[schedule.weekday]}\\b`, 'u').test(normalized);
    case 'month-day': {
      const numeric = new RegExp(`(?:^|\\D)0?${schedule.day}\\.0?${schedule.month}\\.?(?=$|\\D)`, 'u');
      const named = new RegExp(`(?:^|\\D)${schedule.day}\\.?\\s+${MONTH_WORDS[schedule.month]}(?=$|\\D)`, 'u');
      return numeric.test(normalized) || named.test(normalized);
    }
    case 'date': {
      const [year, month, day] = schedule.date.split('-').map(Number);
      const numeric = new RegExp(`(?:^|\\D)0?${day}\\.0?${month}\\.${year}(?=$|\\D)`, 'u');
      const named = new RegExp(`(?:^|\\D)${day}\\.?\\s+${MONTH_WORDS[month]}\\s+${year}(?=$|\\D)`, 'u');
      return numeric.test(normalized) || named.test(normalized);
    }
  }
}

function hasExplicitDaySelector(normalizedUserText: string): boolean {
  if (/\b(?:heute|morgen|übermorgen|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/u.test(normalizedUserText)) {
    return true;
  }
  if (/(?:^|\D)\d{1,2}\.\d{1,2}\.\d{4}(?=$|\D)/u.test(normalizedUserText)) {
    return true;
  }
  if (/\b(?:am|für\s+den|zum)\s+\d{1,2}\.\d{1,2}\.?(?=$|\D)/u.test(normalizedUserText)) {
    return true;
  }
  return MONTH_WORDS.slice(1).some((month) => hasWholeToken(normalizedUserText, month));
}

/** Checks whether the compact schedule has explicit evidence in the current utterance. */
export function isReminderScheduleGrounded(schedule: ReminderSchedule, userText: string): boolean {
  if (schedule.kind === 'after') {
    const candidates = groundedRelativeMinutes(userText);
    return candidates.length === 1 && candidates[0] === schedule.minutes;
  }
  const scheduleClause = reminderScheduleClause(userText);
  if (/\b(?:oder|sondern)\b/u.test(scheduleClause)) return false;
  const groundedTimes = groundedClockTimes(userText);
  return groundedTimes.size === 1
    && groundedTimes.has(schedule.time)
    && isTimeGrounded(schedule.time, scheduleClause)
    && isAbsoluteDayGrounded(schedule, scheduleClause);
}

export function isReminderTextGrounded(text: string, userText: string): boolean {
  return hasGroundedPhrase(userText, text);
}

/** Grounds every destructive reminder selector in the current user utterance. */
export function isCancelReminderRequestGrounded(
  request: CancelReminderRequest,
  userText: string,
): boolean {
  const normalized = normalizeUserText(userText);
  if (request.kind === 'all') {
    return /\b(?:alle|sämtliche)\s+(?:meine\s+)?erinnerungen\b/u.test(normalized);
  }
  if (request.kind === 'id') {
    // IDs are internal correlation data and are never visible to the user.
    // RouterService grounds them only against its short-lived ambiguity context.
    return false;
  }
  if (request.kind === 'text') return isReminderTextGrounded(request.text, userText);
  return isReminderScheduleGrounded(request.schedule, userText)
    && (request.text === undefined || isReminderTextGrounded(request.text, userText));
}

/** Grounds a parsed set request and resolves it to a future local minute. */
export function groundSetReminderRequest(
  request: SetReminderRequest,
  userText: string,
  clock: ReminderClock,
): ReminderGroundingResult {
  const normalizedUser = normalizeUserText(userText);
  const schedule = (request.schedule.kind === 'today' || request.schedule.kind === 'tomorrow')
    && !hasExplicitDaySelector(normalizedUser)
    ? { kind: 'time' as const, time: request.schedule.time }
    : request.schedule;
  if (!isReminderTextGrounded(request.text, userText)) {
    return { ok: false, reason: 'ungrounded_text' };
  }
  if (!isReminderScheduleGrounded(schedule, userText)) {
    return { ok: false, reason: 'ungrounded_time' };
  }
  const dueLocal = resolveReminderDueLocal(schedule, clock);
  if (!dueLocal) return { ok: false, reason: 'non_future_time' };
  const [date, time] = dueLocal.split('T');
  const canonicalParam = serializeSetReminderParam({
    schedule: { kind: 'date', date, time },
    text: request.text,
  });
  return canonicalParam
    ? { ok: true, canonicalParam, dueLocal }
    : { ok: false, reason: 'invalid_param' };
}
