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
  set_timer: z.coerce.number().int().min(1).max(1440),
  // Parser delivers '' for a param-less tag; any non-empty param is invalid (R4-Mi3).
  lock_screen: z.literal(''),
} as const;

export type ActionName = keyof typeof ACTION_SCHEMAS;

const ACTION_NAME_SET: ReadonlySet<string> = new Set(Object.keys(ACTION_SCHEMAS));

export function isActionName(name: string): name is ActionName {
  return ACTION_NAME_SET.has(name);
}

/**
 * Heuristic gate vocabulary (Spec §3): decides ONLY whether a 9B-window
 * message is worth the swap back to the router. Never executes anything.
 */
export const ACTION_HINT_WORDS: readonly string[] = [
  'öffne', 'öffnen', 'starte', 'start',
  'such', 'suche', 'zeig', 'zeige',
  'timer', 'wecker',
  'lautstärke', 'lauter', 'leiser',
  'sperr', 'sperre', 'bildschirm',
];

const HINT_PATTERN = new RegExp(
  `(?:^|[\\s,.!?])(${ACTION_HINT_WORDS.join('|')})(?=$|[\\s,.!?])`,
  'i',
);

export function looksLikeActionCommand(text: string): boolean {
  return HINT_PATTERN.test(text.normalize('NFC'));
}
