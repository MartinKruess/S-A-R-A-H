export const MAX_TIMER_DURATION_SECONDS = 24 * 60 * 60;
export const MAX_TIMER_LABEL_LENGTH = 40;

export interface TimerRequest {
  durationSeconds: number;
  label?: string;
}

export type TimerSelector =
  | { kind: 'all' }
  | { kind: 'label'; label: string }
  | { kind: 'duration'; durationSeconds: number };

function parseDuration(value: string): number | null {
  const duration = value.trim().toLocaleLowerCase('de-DE');
  if (/^\d+$/u.test(duration)) {
    const minutes = Number(duration);
    const seconds = minutes * 60;
    return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= MAX_TIMER_DURATION_SECONDS
      ? seconds
      : null;
  }

  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/u.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const seconds = (Number(match[1] ?? 0) * 3600)
    + (Number(match[2] ?? 0) * 60)
    + Number(match[3] ?? 0);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= MAX_TIMER_DURATION_SECONDS
    ? seconds
    : null;
}

/**
 * @param value - Untrusted label from the compact timer wire format.
 *
 * - Applies NFKC normalization and collapses whitespace.
 * - Rejects control characters, delimiters, empty values and labels over 40 characters.
 *
 * @returns Clean display label or `null` when invalid.
 *
 * @category Validation Transformation
 */
export function cleanTimerLabel(value: string): string | null {
  const normalized = value.normalize('NFKC');
  if (/\p{C}|[|\]]/u.test(normalized)) return null;
  const cleaned = normalized.replace(/\s+/gu, ' ').trim();
  return cleaned.length >= 1 && cleaned.length <= MAX_TIMER_LABEL_LENGTH ? cleaned : null;
}

export function normalizeTimerLabelForMatch(value: string): string | null {
  return cleanTimerLabel(value)?.toLocaleLowerCase('de-DE') ?? null;
}

/** Parses and canonicalizes a compact `set_timer` parameter. */
export function parseTimerRequest(param: string): TimerRequest | null {
  const firstSeparator = param.indexOf('|');
  if (firstSeparator !== param.lastIndexOf('|')) return null;
  const durationPart = firstSeparator < 0 ? param : param.slice(0, firstSeparator);
  const durationSeconds = parseDuration(durationPart);
  if (durationSeconds === null) return null;
  if (firstSeparator < 0) return { durationSeconds };
  const label = cleanTimerLabel(param.slice(firstSeparator + 1));
  return label ? { durationSeconds, label } : null;
}

/** Serializes a timer request into the canonical compact wire format. */
export function serializeTimerRequest(request: TimerRequest): string | null {
  const duration = serializeTimerDuration(request.durationSeconds);
  if (!duration) return null;
  if (request.label === undefined) return duration;
  const label = cleanTimerLabel(request.label);
  return label ? `${duration}|${label}` : null;
}

/** Parses and canonicalizes a compact `cancel_timer` selector. */
export function parseTimerSelector(param: string): TimerSelector | null {
  const selector = param.trim();
  if (selector.toLocaleLowerCase('de-DE') === 'all') return { kind: 'all' };
  if (selector.toLocaleLowerCase('de-DE').startsWith('label=')) {
    const label = cleanTimerLabel(selector.slice('label='.length));
    return label ? { kind: 'label', label } : null;
  }
  if (selector.toLocaleLowerCase('de-DE').startsWith('duration=')) {
    const durationSeconds = parseDuration(selector.slice('duration='.length));
    return durationSeconds === null ? null : { kind: 'duration', durationSeconds };
  }
  return null;
}

/** Serializes a timer selector into the canonical compact wire format. */
export function serializeTimerSelector(selector: TimerSelector): string | null {
  if (selector.kind === 'all') return 'all';
  if (selector.kind === 'duration') {
    const duration = serializeTimerDuration(selector.durationSeconds);
    return duration ? `duration=${duration}` : null;
  }
  const label = cleanTimerLabel(selector.label);
  return label ? `label=${label}` : null;
}

/** Serializes seconds in canonical `h`, `m`, `s` order. */
export function serializeTimerDuration(durationSeconds: number): string | null {
  if (!Number.isSafeInteger(durationSeconds)
    || durationSeconds < 1
    || durationSeconds > MAX_TIMER_DURATION_SECONDS) return null;
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;
  return `${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}${seconds ? `${seconds}s` : ''}`;
}

/** Formats a canonical duration as deterministic German text. */
export function formatTimerDuration(durationSeconds: number): string {
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} ${hours === 1 ? 'Stunde' : 'Stunden'}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? 'Minute' : 'Minuten'}`);
  if (seconds) parts.push(`${seconds} ${seconds === 1 ? 'Sekunde' : 'Sekunden'}`);
  return parts.join(' ');
}
