export const ACTION_NAMES = [
  'open_program',
  'web_search',
  'show_browser',
  'set_volume',
  'spotify_volume',
  'spotify_volume_adjust',
  'set_timer',
  'cancel_timer',
  'set_reminder',
  'list_reminders',
  'cancel_reminder',
  'lock_screen',
  'media_play',
  'media_pause',
  'media_toggle',
  'media_next',
  'media_previous',
] as const;

export type ActionName = typeof ACTION_NAMES[number];

const ACTION_NAME_SET: ReadonlySet<string> = new Set(ACTION_NAMES);

export function isActionName(name: string): name is ActionName {
  return ACTION_NAME_SET.has(name);
}
