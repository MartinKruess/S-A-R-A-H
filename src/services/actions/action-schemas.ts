import { z } from 'zod';
import type { ConfirmationLevel } from '../../core/action-confirmation.js';

const integerString = z.string().trim().regex(/^-?\d+$/u).transform(Number);

/**
 * Single source of truth for V1 actions: names (allowlist) + param schemas.
 * RouterService imports the allowlist from here (llm → actions, no cycle) —
 * there is deliberately NO second copy anywhere (R4-Mi4).
 */
export const ACTION_SCHEMAS = {
  open_program: z.string().min(1).max(100),
  web_search: z.string().min(2).max(200),
  show_browser: z.string().min(1).max(100),
  set_volume: integerString.pipe(z.number().int().min(0).max(100)),
  spotify_volume: integerString.pipe(z.number().int().min(0).max(100)),
  // Signed delta; the parser delivers e.g. "-25" for a relative change.
  spotify_volume_adjust: integerString.pipe(z.number().int().min(-100).max(100)),
  set_timer: integerString.pipe(z.number().int().min(1).max(1440)),
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

type ActionConfirmationRisk = 'read' | 'change' | 'critical';

const ACTION_CONFIRMATION_RISK: Record<ActionName, ActionConfirmationRisk> = {
  open_program: 'change',
  web_search: 'read',
  show_browser: 'read',
  set_volume: 'change',
  spotify_volume: 'change',
  spotify_volume_adjust: 'change',
  set_timer: 'change',
  lock_screen: 'change',
  media_play: 'change',
  media_pause: 'change',
  media_toggle: 'change',
  media_next: 'change',
  media_previous: 'change',
};

/**
 * @param level - Aktuell konfigurierte Bestätigungsstufe.
 * @param action - Validierter Action-Name.
 *
 * - Erzwingt kritische Actions auf jeder Stufe.
 * - Erzwingt bei `maximal` zusätzlich jede zustandsverändernde Action.
 * - Lässt reine Suche und Ergebnisanzeige ohne Bestätigung zu.
 *
 * @returns Ob vor der Ausführung eine korrelierte Zustimmung erforderlich ist.
 *
 * @category Authorization Business Logic
 */
export function requiresActionConfirmation(level: ConfirmationLevel, action: ActionName): boolean {
  const risk = ACTION_CONFIRMATION_RISK[action];
  return risk === 'critical' || (level === 'maximal' && risk === 'change');
}

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
