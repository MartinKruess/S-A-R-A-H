import {
  normalizeTimerLabelForMatch,
  serializeTimerRequest,
  serializeTimerSelector,
  type TimerRequest,
  type TimerSelector,
} from './timer-contract.js';

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

const HALF_NUMBER_WORDS: Readonly<Record<string, number>> = {
  eineinhalb: 1.5,
  anderthalb: 1.5,
  zweieinhalb: 2.5,
  dreieinhalb: 3.5,
  viereinhalb: 4.5,
  fünfeinhalb: 5.5,
  sechseinhalb: 6.5,
  siebeneinhalb: 7.5,
  achteinhalb: 8.5,
  neuneinhalb: 9.5,
  zehneinhalb: 10.5,
  elfeinhalb: 11.5,
  zwölfeinhalb: 12.5,
};

const TIMER_DURATION_LABEL_PATTERN = /(?:^|[^\p{L}\p{N}])(?:sekunde(?:n)?|minute(?:n)?|stunde(?:n)?)(?=$|[^\p{L}\p{N}])/iu;
const GENERIC_TIMER_LABELS: ReadonlySet<string> = new Set(['timer', 'wecker']);

function normalizeUserText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('de-DE');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function hasGroundedLabel(userText: string, label: string): boolean {
  const normalizedLabel = normalizeTimerLabelForMatch(label);
  if (!normalizedLabel) return false;
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedLabel)}(?:\\s*-?\\s*timer)?(?=$|[^\\p{L}\\p{N}])`,
    'u',
  ).test(normalizeUserText(userText));
}

function unitSeconds(unit: string): number {
  if (unit.startsWith('stunde')) return 3_600;
  if (unit.startsWith('minute')) return 60;
  return 1;
}

function unitRank(unit: string): number {
  if (unit.startsWith('stunde')) return 3;
  if (unit.startsWith('minute')) return 2;
  return 1;
}

function parseNumericAmount(value: string): number | null {
  const normalized = value.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Extracts explicitly spoken timer durations as candidate second values. */
export function groundedTimerDurations(userText: string): ReadonlySet<number> {
  const normalized = normalizeUserText(userText);
  const candidates = new Set<number>();
  const parts: Array<{ start: number; end: number; seconds: number; rank: number }> = [];

  const fractionPatterns = [
    { pattern: /\b(?:eine\s+)?dreiviertelstunde\b/gu, seconds: 45 * 60 },
    { pattern: /\b(?:eine\s+)?halbe\s+stunde\b/gu, seconds: 30 * 60 },
    { pattern: /\b(?:eine\s+)?viertelstunde\b/gu, seconds: 15 * 60 },
    { pattern: /\b(?:drei\s+viertelstunden?|dreiviertel\s+stunden?)\b/gu, seconds: 45 * 60 },
  ] as const;
  for (const { pattern, seconds } of fractionPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      if (match.index === undefined) continue;
      parts.push({
        start: match.index,
        end: match.index + match[0].length,
        seconds,
        rank: 3,
      });
    }
  }

  const numericUnitPattern = /(\d+(?:[.,]\d+)?)\s*-?\s*(stunden?|minuten?|sekunden?)/gu;
  for (const match of normalized.matchAll(numericUnitPattern)) {
    const amount = parseNumericAmount(match[1]);
    if (amount === null || match.index === undefined) continue;
    const seconds = amount * unitSeconds(match[2]);
    if (!Number.isSafeInteger(seconds)) continue;
    parts.push({
      start: match.index,
      end: match.index + match[0].length,
      seconds,
      rank: unitRank(match[2]),
    });
  }

  const wordPattern = new RegExp(
    `\\b(${[...Object.keys(NUMBER_WORDS), ...Object.keys(HALF_NUMBER_WORDS)].join('|')})\\s*-?\\s*(stunden?|minuten?|sekunden?)`,
    'gu',
  );
  for (const match of normalized.matchAll(wordPattern)) {
    const amount = NUMBER_WORDS[match[1]] ?? HALF_NUMBER_WORDS[match[1]];
    if (amount === undefined || match.index === undefined) continue;
    const seconds = amount * unitSeconds(match[2]);
    if (!Number.isSafeInteger(seconds)) continue;
    parts.push({
      start: match.index,
      end: match.index + match[0].length,
      seconds,
      rank: unitRank(match[2]),
    });
  }

  parts.sort((left, right) => left.start - right.start || right.end - left.end);
  let group: typeof parts = [];
  const commitGroup = (): void => {
    if (group.length === 0) return;
    let seconds = group.reduce((sum, part) => sum + part.seconds, 0);
    const last = group[group.length - 1];
    if (last?.rank === 2) {
      const trailing = /^\s+(\d{1,2})(?=$|[^\p{L}\p{N}])/u.exec(normalized.slice(last.end));
      if (trailing) seconds += Number(trailing[1]);
    }
    candidates.add(seconds);
  };
  for (const part of parts) {
    const previous = group[group.length - 1];
    const joinsPrevious = previous
      && part.rank < previous.rank
      && /^[\s,]*(?:und[\s,]*)?$/u.test(normalized.slice(previous.end, part.start));
    if (!joinsPrevious) {
      commitGroup();
      group = [];
    }
    group.push(part);
  }
  commitGroup();
  return candidates;
}

/** Grounds a complete set-timer request in the current utterance. */
export function groundTimerRequest(request: TimerRequest, userText: string): string | null {
  const durations = groundedTimerDurations(userText);
  if (durations.size !== 1 || !durations.has(request.durationSeconds)) return null;
  const normalizedLabel = request.label ? normalizeTimerLabelForMatch(request.label) : null;
  const keepLabel = request.label
    && normalizedLabel
    && hasGroundedLabel(userText, request.label)
    && !TIMER_DURATION_LABEL_PATTERN.test(normalizedLabel)
    && !GENERIC_TIMER_LABELS.has(normalizedLabel);
  const grounded = keepLabel ? request : { durationSeconds: request.durationSeconds };
  return serializeTimerRequest(grounded);
}

/** Grounds every destructive timer selector in the current utterance. */
export function groundTimerSelector(selector: TimerSelector, userText: string): string | null {
  const normalized = normalizeUserText(userText);
  if (selector.kind === 'all') {
    return /\b(?:alle|sämtliche)\s+(?:meine\s+)?(?:timer|wecker)\b/u.test(normalized)
      ? 'all'
      : null;
  }
  if (selector.kind === 'label') {
    return hasGroundedLabel(userText, selector.label) ? serializeTimerSelector(selector) : null;
  }
  const durations = groundedTimerDurations(userText);
  return durations.size === 1 && durations.has(selector.durationSeconds)
    ? serializeTimerSelector(selector)
    : null;
}
