import type { BusEvents } from '../../core/bus-events.js';
import type { TurnId } from '../../core/turn-contract.js';
import { parseTimerRequest, serializeTimerRequest } from '../actions/timer-contract.js';
import {
  parseSetReminderParam,
  serializeCancelReminderParam,
  serializeSetReminderParam,
} from '../actions/reminder-contract.js';

const REMINDER_CANCEL_FOLLOWUP_TIMEOUT_MS = 2 * 60_000;
export const REMINDER_CANCEL_TIME_FOLLOWUP_PATTERN = /^(?:(?:die|der)(?:\s+erinnerung)?\s+)?(?:um\s+)?([01]?\d|2[0-3])(?:(?:[.:]\s*([0-5]\d))|(?:\s+uhr(?:\s+([0-5]?\d))?))(?:\s+uhr)?(?:\s+[\p{L}\p{N}][\p{L}\p{N}\s-]*)?[.!?]?$/iu;

const REMINDER_CANCEL_INDEX_WORDS: Readonly<Record<string, number>> = {
  eins: 1, erste: 1, erster: 1, ersten: 1, erstes: 1,
  zwei: 2, zweite: 2, zweiter: 2, zweiten: 2, zweites: 2,
  drei: 3, dritte: 3, dritter: 3, dritten: 3, drittes: 3,
  vier: 4, vierte: 4,
  fünf: 5, fünfte: 5,
};

export interface ReminderCancelFollowupContext {
  ownerTurnId: TurnId;
  candidates: Array<{ id: number; dueLocal: string }>;
  expiresAt: number;
}

export function parseReminderCancelFollowupIndex(value: string): number | null {
  const normalized = value.normalize('NFKC')
    .trim()
    .toLocaleLowerCase('de-DE')
    .replace(/[.!?]+$/u, '')
    .replace(/^(?:die|der|das|nummer)\s+/u, '')
    .trim();
  if (/^[1-9]\d*$/u.test(normalized)) return Number(normalized);
  return REMINDER_CANCEL_INDEX_WORDS[normalized] ?? null;
}

function isExplicitReminderCreationIntent(value: string): boolean {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('de-DE');
  if (/\btimers?\b/u.test(normalized)) return false;
  return /\b(?:erinnerung|reminder)\b/u.test(normalized)
    || /\berinner(?:e)?\s+mich\b/u.test(normalized);
}

export function reminderFromMisroutedTimer(param: string, userText: string): string | null {
  if (!isExplicitReminderCreationIntent(userText)) return null;
  const timer = parseTimerRequest(param);
  if (!timer?.label || timer.durationSeconds % 60 !== 0) return null;
  return serializeSetReminderParam({
    schedule: { kind: 'after', minutes: timer.durationSeconds / 60 },
    text: timer.label,
  });
}

export function timerFromMisroutedReminder(param: string, userText: string): string | null {
  const normalized = userText.normalize('NFKC').toLocaleLowerCase('de-DE');
  if (!/\btimers?\b/u.test(normalized) || /\b(?:erinnerung|reminder)\b/u.test(normalized)) return null;
  const reminder = parseSetReminderParam(param);
  if (!reminder || reminder.schedule.kind !== 'after') return null;
  return serializeTimerRequest({
    durationSeconds: reminder.schedule.minutes * 60,
    label: reminder.text,
  });
}

export function reminderCancelFromMisroutedSet(userText: string): string | null {
  const match = /^\s*(?:lösche?|lösch|entferne?|brich|breche)\s+(?:bitte\s+)?(?:die\s+)?erinnerung\s+(.+?)(?:\s+ab)?[.!?]?\s*$/iu.exec(userText);
  if (!match?.[1]) return null;
  return serializeCancelReminderParam({ kind: 'text', text: match[1] });
}

export function isActiveReminderListShortcut(userText: string): boolean {
  const normalized = userText.normalize('NFKC')
    .trim()
    .toLocaleLowerCase('de-DE')
    .replace(/[.!?]+$/u, '')
    .trim();
  return /^(?:zeige\s+(?:mir\s+)?)?(?:die\s+)?(?:aktiven?|alle)\s+erinnerung(?:en)?$/u.test(normalized);
}

export function createReminderCancelFollowupContext(
  ownerTurnId: TurnId,
  ambiguity: BusEvents['action:result']['reminderCancelAmbiguity'],
  nowMs: number,
): ReminderCancelFollowupContext | null {
  if (!ambiguity || ambiguity.candidates.length < 2) return null;
  const candidates: Array<{ id: number; dueLocal: string }> = [];
  const ids = new Set<number>();
  for (const candidate of ambiguity.candidates) {
    if (
      !Number.isSafeInteger(candidate.id)
      || candidate.id <= 0
      || ids.has(candidate.id)
      || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/u.test(candidate.dueLocal)
    ) return null;
    ids.add(candidate.id);
    candidates.push({ id: candidate.id, dueLocal: candidate.dueLocal });
  }
  return {
    ownerTurnId,
    candidates,
    expiresAt: nowMs + REMINDER_CANCEL_FOLLOWUP_TIMEOUT_MS,
  };
}
