export const MAX_REMINDER_TEXT_LENGTH = 200;
export const MAX_REMINDER_DELAY_MINUTES = 366 * 24 * 60;

export type ReminderWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type ReminderAbsoluteSchedule =
  | { kind: 'today'; time: string }
  | { kind: 'tomorrow'; time: string }
  | { kind: 'day-after-tomorrow'; time: string }
  | { kind: 'weekday'; weekday: ReminderWeekday; time: string }
  | { kind: 'month-day'; month: number; day: number; time: string }
  | { kind: 'date'; date: string; time: string }
  | { kind: 'time'; time: string };

export type ReminderSchedule =
  | { kind: 'after'; minutes: number }
  | ReminderAbsoluteSchedule;

export interface SetReminderRequest {
  schedule: ReminderSchedule;
  text: string;
}

export type ListReminderRequest = 'today' | 'upcoming';

export type CancelReminderRequest =
  | { kind: 'all' }
  | { kind: 'id'; id: number }
  | { kind: 'text'; text: string }
  | { kind: 'at'; schedule: ReminderAbsoluteSchedule; text?: string };

export interface ReminderClock {
  nowMs(): number;
  toLocal(epochMs: number): string;
}

const WEEKDAYS: readonly ReminderWeekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/u;

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

interface CivilDateTime extends CivilDate {
  time: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isValidCivilDate(date: CivilDate): boolean {
  const candidate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return candidate.getUTCFullYear() === date.year
    && candidate.getUTCMonth() === date.month - 1
    && candidate.getUTCDate() === date.day;
}

function parseDate(value: string): CivilDate | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isValidCivilDate(date) ? date : null;
}

function parseLocal(value: string): CivilDateTime | null {
  const match = LOCAL_PATTERN.exec(value);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isValidCivilDate(date) ? { ...date, time: match[4] } : null;
}

function formatDate(date: CivilDate): string {
  return `${String(date.year).padStart(4, '0')}-${pad2(date.month)}-${pad2(date.day)}`;
}

function formatLocal(date: CivilDate, time: string): string {
  return `${formatDate(date)}T${time}`;
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
}

function weekdayOf(date: CivilDate): ReminderWeekday {
  return WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
}

function parseDuration(value: string): number | null {
  const duration = value.trim().toLocaleLowerCase('de-DE');
  const match = /^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/u.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3] && !match[4])) return null;
  const minutes = (Number(match[1] ?? 0) * 7 * 24 * 60)
    + (Number(match[2] ?? 0) * 24 * 60)
    + (Number(match[3] ?? 0) * 60)
    + Number(match[4] ?? 0);
  return Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= MAX_REMINDER_DELAY_MINUTES
    ? minutes
    : null;
}

function serializeDuration(minutes: number): string | null {
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_REMINDER_DELAY_MINUTES) {
    return null;
  }
  const weeks = Math.floor(minutes / (7 * 24 * 60));
  const afterWeeks = minutes % (7 * 24 * 60);
  const days = Math.floor(afterWeeks / (24 * 60));
  const afterDays = afterWeeks % (24 * 60);
  const hours = Math.floor(afterDays / 60);
  const remainingMinutes = afterDays % 60;
  return `${weeks ? `${weeks}w` : ''}${days ? `${days}d` : ''}${hours ? `${hours}h` : ''}${remainingMinutes ? `${remainingMinutes}m` : ''}`;
}

/** Normalizes reminder content while rejecting control and wire delimiter characters. */
export function cleanReminderText(value: string): string | null {
  const normalized = value.normalize('NFKC');
  if (/\p{C}|[|\]]/u.test(normalized)) return null;
  const cleaned = normalized.replace(/\s+/gu, ' ').trim();
  return cleaned.length >= 1 && cleaned.length <= MAX_REMINDER_TEXT_LENGTH ? cleaned : null;
}

export function normalizeReminderTextForMatch(value: string): string | null {
  return cleanReminderText(value)?.toLocaleLowerCase('de-DE') ?? null;
}

function parseAbsoluteSchedule(value: string): ReminderAbsoluteSchedule | null {
  const separator = value.lastIndexOf('@');
  if (separator < 0) return null;
  const dayPart = value.slice(0, separator).trim().toLocaleLowerCase('de-DE');
  const time = value.slice(separator + 1).trim();
  if (!TIME_PATTERN.test(time)) return null;
  if (dayPart === 'today') return { kind: 'today', time };
  if (dayPart === 'tomorrow') return { kind: 'tomorrow', time };
  if (dayPart === 'day-after-tomorrow') return { kind: 'day-after-tomorrow', time };
  if (dayPart === 'time') return { kind: 'time', time };
  if (dayPart.startsWith('weekday:')) {
    const weekday = dayPart.slice('weekday:'.length);
    return WEEKDAYS.includes(weekday as ReminderWeekday)
      ? { kind: 'weekday', weekday: weekday as ReminderWeekday, time }
      : null;
  }
  if (dayPart.startsWith('month-day:')) {
    const match = /^(\d{2})-(\d{2})$/u.exec(dayPart.slice('month-day:'.length));
    if (!match) return null;
    const month = Number(match[1]);
    const day = Number(match[2]);
    return isValidCivilDate({ year: 2000, month, day })
      ? { kind: 'month-day', month, day, time }
      : null;
  }
  if (dayPart.startsWith('date:')) {
    const date = dayPart.slice('date:'.length);
    return parseDate(date) ? { kind: 'date', date, time } : null;
  }
  return null;
}

function serializeAbsoluteSchedule(schedule: ReminderAbsoluteSchedule): string | null {
  if (!TIME_PATTERN.test(schedule.time)) return null;
  switch (schedule.kind) {
    case 'today':
    case 'tomorrow':
    case 'day-after-tomorrow':
    case 'time':
      return `${schedule.kind}@${schedule.time}`;
    case 'weekday':
      return WEEKDAYS.includes(schedule.weekday)
        ? `weekday:${schedule.weekday}@${schedule.time}`
        : null;
    case 'month-day':
      return isValidCivilDate({ year: 2000, month: schedule.month, day: schedule.day })
        ? `month-day:${pad2(schedule.month)}-${pad2(schedule.day)}@${schedule.time}`
        : null;
    case 'date':
      return parseDate(schedule.date) ? `date:${schedule.date}@${schedule.time}` : null;
  }
}

function parseSchedule(value: string): ReminderSchedule | null {
  if (value.startsWith('after=')) {
    const minutes = parseDuration(value.slice('after='.length));
    return minutes === null ? null : { kind: 'after', minutes };
  }
  if (value.startsWith('at=')) return parseAbsoluteSchedule(value.slice('at='.length));
  return null;
}

function serializeSchedule(schedule: ReminderSchedule): string | null {
  if (schedule.kind === 'after') {
    const duration = serializeDuration(schedule.minutes);
    return duration ? `after=${duration}` : null;
  }
  const absolute = serializeAbsoluteSchedule(schedule);
  return absolute ? `at=${absolute}` : null;
}

/** Parses a compact set-reminder wire parameter. */
export function parseSetReminderParam(param: string): SetReminderRequest | null {
  const separator = param.indexOf('|text=');
  if (separator < 1 || separator !== param.lastIndexOf('|text=')) return null;
  const schedule = parseSchedule(param.slice(0, separator));
  const text = cleanReminderText(param.slice(separator + '|text='.length));
  return schedule && text ? { schedule, text } : null;
}

/** Serializes a reminder request to the single canonical wire representation. */
export function serializeSetReminderParam(request: SetReminderRequest): string | null {
  const schedule = serializeSchedule(request.schedule);
  const text = cleanReminderText(request.text);
  return schedule && text ? `${schedule}|text=${text}` : null;
}

export function parseListReminderParam(param: string): ListReminderRequest | null {
  const normalized = param.trim().toLocaleLowerCase('de-DE');
  return normalized === 'today' || normalized === 'upcoming' ? normalized : null;
}

export function serializeListReminderParam(request: ListReminderRequest): string {
  return request;
}

/** Parses an explicit, fail-closed reminder cancellation selector. */
export function parseCancelReminderParam(param: string): CancelReminderRequest | null {
  const trimmed = param.trim();
  if (trimmed.toLocaleLowerCase('de-DE') === 'all') return { kind: 'all' };
  if (trimmed.toLocaleLowerCase('de-DE').startsWith('id=')) {
    const id = Number(trimmed.slice('id='.length));
    return Number.isSafeInteger(id) && id >= 1 ? { kind: 'id', id } : null;
  }
  if (trimmed.toLocaleLowerCase('de-DE').startsWith('text=')) {
    const text = cleanReminderText(trimmed.slice('text='.length));
    return text ? { kind: 'text', text } : null;
  }
  if (!trimmed.toLocaleLowerCase('de-DE').startsWith('at=')) return null;
  const textSeparator = trimmed.indexOf('|text=');
  if (textSeparator !== trimmed.lastIndexOf('|text=')) return null;
  const schedulePart = textSeparator < 0 ? trimmed : trimmed.slice(0, textSeparator);
  const schedule = parseAbsoluteSchedule(schedulePart.slice('at='.length));
  if (!schedule) return null;
  if (textSeparator < 0) return { kind: 'at', schedule };
  const text = cleanReminderText(trimmed.slice(textSeparator + '|text='.length));
  return text ? { kind: 'at', schedule, text } : null;
}

export function serializeCancelReminderParam(request: CancelReminderRequest): string | null {
  if (request.kind === 'all') return 'all';
  if (request.kind === 'id') return Number.isSafeInteger(request.id) && request.id >= 1
    ? `id=${request.id}`
    : null;
  if (request.kind === 'text') {
    const text = cleanReminderText(request.text);
    return text ? `text=${text}` : null;
  }
  const schedule = serializeAbsoluteSchedule(request.schedule);
  if (!schedule) return null;
  if (request.text === undefined) return `at=${schedule}`;
  const text = cleanReminderText(request.text);
  return text ? `at=${schedule}|text=${text}` : null;
}

/** Resolves a validated symbolic schedule to a concrete future local minute. */
export function resolveReminderDueLocal(schedule: ReminderSchedule, clock: ReminderClock): string | null {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs)) return null;
  const nowLocal = clock.toLocal(nowMs);
  const current = parseLocal(nowLocal);
  if (!current) return null;
  if (schedule.kind === 'after') {
    const duration = serializeDuration(schedule.minutes);
    if (!duration) return null;
    const targetMs = nowMs + schedule.minutes * 60_000;
    const due = clock.toLocal(Math.ceil(targetMs / 60_000) * 60_000);
    return parseLocal(due) && due > nowLocal ? due : null;
  }

  let date: CivilDate;
  if (schedule.kind === 'today' || schedule.kind === 'time') {
    date = current;
  } else if (schedule.kind === 'tomorrow') {
    date = addCivilDays(current, 1);
  } else if (schedule.kind === 'day-after-tomorrow') {
    date = addCivilDays(current, 2);
  } else if (schedule.kind === 'weekday') {
    date = current;
    while (weekdayOf(date) !== schedule.weekday) date = addCivilDays(date, 1);
  } else if (schedule.kind === 'month-day') {
    let year = current.year;
    let candidate = { year, month: schedule.month, day: schedule.day };
    while (!isValidCivilDate(candidate)) {
      year += 1;
      candidate = { ...candidate, year };
      if (year - current.year > 8) return null;
    }
    date = candidate;
  } else {
    const parsedDate = parseDate(schedule.date);
    if (!parsedDate) return null;
    date = parsedDate;
  }

  let due = formatLocal(date, schedule.time);
  if (schedule.kind === 'time' && due <= nowLocal) {
    due = formatLocal(addCivilDays(date, 1), schedule.time);
  } else if (schedule.kind === 'weekday' && due <= nowLocal) {
    due = formatLocal(addCivilDays(date, 7), schedule.time);
  } else if (schedule.kind === 'month-day' && due <= nowLocal) {
    let year = date.year + 1;
    let candidate = { year, month: schedule.month, day: schedule.day };
    while (!isValidCivilDate(candidate)) {
      year += 1;
      candidate = { ...candidate, year };
      if (year - date.year > 8) return null;
    }
    due = formatLocal(candidate, schedule.time);
  }
  return due > nowLocal ? due : null;
}

/** Creates the production clock that follows the operating system's local time. */
export function createSystemReminderClock(now: () => number = Date.now): ReminderClock {
  return {
    nowMs: now,
    toLocal: (epochMs) => {
      const date = new Date(epochMs);
      return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    },
  };
}
