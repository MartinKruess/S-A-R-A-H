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

function groundedRelativeMinutes(userText: string): readonly number[] {
  const normalized = normalizeUserText(userText);
  const afterIn = /\bin\s+(.+)$/u.exec(normalized)?.[1];
  const shorthand = /\b(?:erinnerung|reminder)\b/u.test(normalized)
    ? normalized
    : null;
  const durationSource = afterIn ?? shorthand;
  if (!durationSource) return [];
  const bounded = durationSource.split(/\b(?:daran|damit|um\s+zu)\b/u, 1)[0];
  const results = new Set<number>();
  if (/\b(?:anderthalb|eineinhalb)\s+stunden?\b/u.test(bounded)) results.add(90);
  if (/\b(?:eine\s+)?dreiviertelstunde\b/u.test(bounded)) results.add(45);

  const unitPattern = /(\d+|ein|eine|einen|einer|einem|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s*(minuten?|stunden?|tage?|wochen?)/gu;
  let sum = 0;
  let found = false;
  for (const match of bounded.matchAll(unitPattern)) {
    const amount = parseAmount(match[1]);
    if (amount === null) continue;
    found = true;
    const unit = match[2];
    sum += unit.startsWith('minute')
      ? amount
      : unit.startsWith('stunde')
        ? amount * 60
        : unit.startsWith('tag')
          ? amount * 24 * 60
          : amount * 7 * 24 * 60;
  }
  if (found) results.add(sum);
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
    return groundedRelativeMinutes(userText).includes(schedule.minutes);
  }
  return isTimeGrounded(schedule.time, userText) && isAbsoluteDayGrounded(schedule, userText);
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
    return new RegExp(`(?:^|\\D)${request.id}(?=$|\\D)`, 'u').test(normalized);
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
  const groundedRequest = { ...request, schedule };
  const canonicalParam = serializeSetReminderParam(groundedRequest);
  if (!canonicalParam) return { ok: false, reason: 'invalid_param' };
  if (!isReminderTextGrounded(request.text, userText)) {
    return { ok: false, reason: 'ungrounded_text' };
  }
  if (!isReminderScheduleGrounded(schedule, userText)) {
    return { ok: false, reason: 'ungrounded_time' };
  }
  const dueLocal = resolveReminderDueLocal(schedule, clock);
  return dueLocal
    ? { ok: true, canonicalParam, dueLocal }
    : { ok: false, reason: 'non_future_time' };
}
