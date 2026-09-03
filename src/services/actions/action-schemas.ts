import { z } from 'zod';
import type { ActionName } from '../../core/action-name.js';
export { isActionName } from '../../core/action-name.js';
export type { ActionName } from '../../core/action-name.js';
import {
  parseTimerRequest,
  parseTimerSelector,
  serializeTimerRequest,
  serializeTimerSelector,
} from './timer-contract.js';
import {
  parseCancelReminderParam,
  parseListReminderParam,
  parseSetReminderParam,
  serializeCancelReminderParam,
  serializeListReminderParam,
  serializeSetReminderParam,
} from './reminder-contract.js';

const integerString = z.string().trim().regex(/^-?\d+$/u).transform(Number);

const timerRequestString = z.string().max(100).transform((param, context): string => {
  const parsed = parseTimerRequest(param);
  const canonical = parsed ? serializeTimerRequest(parsed) : null;
  if (canonical) return canonical;
  context.addIssue({ code: 'custom', message: 'Invalid timer request' });
  return '';
});

const timerSelectorString = z.string().max(100).transform((param, context): string => {
  const parsed = parseTimerSelector(param);
  const canonical = parsed ? serializeTimerSelector(parsed) : null;
  if (canonical) return canonical;
  context.addIssue({ code: 'custom', message: 'Invalid timer selector' });
  return '';
});

const setReminderString = z.string().max(300).transform((param, context): string => {
  const parsed = parseSetReminderParam(param);
  const canonical = parsed ? serializeSetReminderParam(parsed) : null;
  if (canonical) return canonical;
  context.addIssue({ code: 'custom', message: 'Invalid reminder request' });
  return '';
});

const listReminderString = z.string().max(20).transform((param, context): string => {
  const parsed = parseListReminderParam(param);
  if (parsed) return serializeListReminderParam(parsed);
  context.addIssue({ code: 'custom', message: 'Invalid reminder list scope' });
  return '';
});

const cancelReminderString = z.string().max(300).transform((param, context): string => {
  const parsed = parseCancelReminderParam(param);
  const canonical = parsed ? serializeCancelReminderParam(parsed) : null;
  if (canonical) return canonical;
  context.addIssue({ code: 'custom', message: 'Invalid reminder selector' });
  return '';
});

/**
 * Parameter schemas for the central V1 action allowlist.
 * `ActionName` comes from the dependency-free core list and this record must
 * contain one schema for every action in that list.
 */
export const ACTION_SCHEMAS = {
  open_program: z.string().min(1).max(100),
  web_search: z.string().min(2).max(200),
  show_browser: z.string().min(1).max(100),
  set_volume: integerString.pipe(z.number().int().min(0).max(100)),
  spotify_volume: integerString.pipe(z.number().int().min(0).max(100)),
  // Signed delta; the parser delivers e.g. "-25" for a relative change.
  spotify_volume_adjust: integerString.pipe(z.number().int().min(-100).max(100)),
  set_timer: timerRequestString,
  cancel_timer: timerSelectorString,
  set_reminder: setReminderString,
  list_reminders: listReminderString,
  cancel_reminder: cancelReminderString,
  // Parser delivers '' for a param-less tag; any non-empty param is invalid (R4-Mi3).
  lock_screen: z.literal(''),
  // Generic media transport (Schicht 1). Param = optional target: '' = active session,
  // else a program name substring ("spotify", "chrome") to pick that session.
  media_play: z.string().max(40),
  media_pause: z.string().max(40),
  media_toggle: z.string().max(40),
  media_next: z.string().max(40),
  media_previous: z.string().max(40),
} as const satisfies Record<ActionName, z.ZodType>;

/**
 * Heuristic gate vocabulary (Spec §3): decides ONLY whether a 9B-window
 * message is worth the swap back to the router. Never executes anything.
 *
 * These are word-START STEMS, prefix-matched, so every conjugation of a command
 * verb is caught — imperative AND infinitive/polite forms: 'start' covers
 * starte/starten/startest ("kannst du Spotify starten"), 'öffn' covers
 * öffne/öffnen/öffnest, 'such' covers such/suche/suchen. The stems are anchored
 * to a word boundary, so mid-word hits like "Eröffnung" (≠ 'öffn' at word start)
 * do NOT match. Over-matching only costs one extra routing swap (never a wrong
 * action), so we bias toward catching commands — but we avoid very common verbs
 * like "mach(en)"/"stell(en)" whose actions are already anchored by a noun
 * ('lautstärke'/'timer').
 */
export const ACTION_HINT_STEMS: readonly string[] = [
  'öffn', 'start', 'such', 'google', 'zeig',
  'timer', 'wecker', 'erinner', 'termin',
  'lautstärke', 'lauter', 'leiser',
  'spotify', 'musik', 'lied', 'paus', 'nächst', 'skip',
  'sperr', 'bildschirm',
];
// Transport stems catch the bare media commands so a warm 9B window always swaps
// them back to the router — the router, not the 9B worker, owns command dispatch.
// 'lied' anchors every track command ("ein Lied vor/zurück", "nächstes Lied"),
// like 'lautstärke'/'timer' anchor their actions; 'paus' → Pause/pausier…,
// 'nächst' → nächstes/nächste, 'skip'. 'lied'/'nächst' may also fire on chat
// ("nächste Woche", "über dieses Lied"); per the note above that only costs one
// extra routing swap, never a wrong action.

const HINT_PATTERN = new RegExp(
  `(?:^|[\\s,.!?])(${ACTION_HINT_STEMS.join('|')})`,
  'i',
);

export function looksLikeActionCommand(text: string): boolean {
  return HINT_PATTERN.test(text.normalize('NFC'));
}
