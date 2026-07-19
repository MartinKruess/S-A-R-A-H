import { z } from 'zod';

/**
 * Single source of truth for V1 actions: names (allowlist) + param schemas.
 * RouterService imports the allowlist from here (llm → actions, no cycle) —
 * there is deliberately NO second copy anywhere (R4-Mi4).
 */
export const ACTION_SCHEMAS = {
  open_program: z.string().min(1).max(100),
  web_search: z.string().min(2).max(200),
  show_browser: z.string().min(1).max(100),
  set_volume: z.coerce.number().int().min(0).max(100),
  spotify_volume: z.coerce.number().int().min(0).max(100),
  // Signed delta; the parser delivers e.g. "-25" for a relative change.
  spotify_volume_adjust: z.coerce.number().int().min(-100).max(100),
  set_timer: z.coerce.number().int().min(1).max(1440),
  // Parser delivers '' for a param-less tag; any non-empty param is invalid (R4-Mi3).
  lock_screen: z.literal(''),
  // Generic media transport (Schicht 1). Param = optional target: '' = active session,
  // else a program name substring ("spotify", "chrome") to pick that session.
  media_play: z.string().max(40),
  media_pause: z.string().max(40),
  media_toggle: z.string().max(40),
  media_next: z.string().max(40),
  media_previous: z.string().max(40),
} as const;

export type ActionName = keyof typeof ACTION_SCHEMAS;

const ACTION_NAME_SET: ReadonlySet<string> = new Set(Object.keys(ACTION_SCHEMAS));

export function isActionName(name: string): name is ActionName {
  return ACTION_NAME_SET.has(name);
}

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
  'timer', 'wecker',
  'lautstärke', 'lauter', 'leiser',
  'spotify', 'musik', 'paus', 'nächst', 'skip',
  'sperr', 'bildschirm',
];
// Transport stems ('paus' → Pause/pausier…, 'nächst' → nächstes (Lied)/nächste,
// 'skip') deliberately catch the bare media commands so a warm 9B window always
// swaps them back to the router — the router, not the 9B worker, owns command
// dispatch. 'nächst' may also fire on chat like "nächste Woche"; per the note
// above that only costs one extra routing swap, never a wrong action.

const HINT_PATTERN = new RegExp(
  `(?:^|[\\s,.!?])(${ACTION_HINT_STEMS.join('|')})`,
  'i',
);

export function looksLikeActionCommand(text: string): boolean {
  return HINT_PATTERN.test(text.normalize('NFC'));
}
