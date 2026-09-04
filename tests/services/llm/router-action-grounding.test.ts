import { describe, expect, it } from 'vitest';
import type { ActionName } from '../../../src/services/actions/action-schemas.js';
import type { ReminderClock } from '../../../src/services/actions/reminder-contract.js';
import { groundActionRequest } from '../../../src/services/llm/router-action-grounding.js';

const clock: ReminderClock = {
  nowMs: () => Date.UTC(2026, 8, 4, 10, 0),
  toLocal: (epochMs) => new Date(epochMs).toISOString().slice(0, 16),
};

function ground(action: ActionName, param: string, evidence: string) {
  return groundActionRequest(action, param, evidence, clock);
}

describe('router action clause grounding', () => {
  it.each([
    ['open_program', 'spotify', 'Öffne Spotify'],
    ['web_search', 'hotels kiel', 'Suche Hotels in Kiel'],
    ['web_search', 'hotels und restaurants', 'Suche Hotels und Restaurants'],
    ['show_browser', '1', 'Öffne das erste Ergebnis'],
    ['show_browser', 'Fahrrad Test', 'Zeige das Ergebnis Fahrrad Test'],
    ['spotify_volume', '30', 'Stelle Spotify auf 30 Prozent'],
    ['spotify_volume_adjust', '-5', 'Mach die Musik etwas leiser'],
    ['spotify_volume_adjust', '25', 'Mach Spotify lauter'],
    ['spotify_volume_adjust', '-10', 'Senke Spotify um 10 Prozent'],
    ['set_volume', '40', 'Stelle die Systemlautstärke auf 40 Prozent'],
    ['list_reminders', 'today', 'Welche Erinnerungen stehen heute an?'],
    ['list_reminders', 'today', 'Zeig mir die Termine für heute'],
    ['list_reminders', 'upcoming', 'Zeige alle Erinnerungen'],
    ['list_reminders', 'upcoming', 'Welche Erinnerungen sind noch offen?'],
    ['lock_screen', '', 'Sperre den Bildschirm'],
    ['lock_screen', '', 'Bitte sperre meinen PC'],
    ['open_program', 'spotify', 'Kannst du bitte Spotify öffnen?'],
  ] as const)(
    'grounds %s=%s only from its own evidence clause',
    (action, param, evidence) => {
      expect(ground(action, param, evidence)).toEqual({
        ok: true,
        param,
        validation: 'semantic_grounding',
      });
    },
  );

  it.each([
    ['open_program', 'Discord', 'Öffne Spotify'],
    ['open_program', 'Programm', 'Öffne das Programm'],
    ['open_program', 'spotify', 'Öffne Spotify nicht'],
    ['open_program', 'spotify', 'Öffne Spotify erst morgen'],
    ['open_program', 'spotify', 'Öffne Spotify, wenn du Zeit hast'],
    ['web_search', 'hotels hamburg', 'Suche Hotels in Kiel'],
    ['web_search', 'suche', 'Suche Hotels in Kiel'],
    ['web_search', 'eule', 'Suche Hotels ohne den Codenamen Eule'],
    ['web_search', 'hotels', 'Suche Hotels und Restaurants'],
    ['web_search', 'hotels', 'Suche Hotels aber keine Restaurants'],
    ['show_browser', '2', 'Öffne das erste Ergebnis'],
    ['spotify_volume', '50', 'Stelle Spotify auf 30 Prozent'],
    ['spotify_volume', '30', 'Stelle die Systemlautstärke auf 30 Prozent'],
    ['spotify_volume_adjust', '25', 'Mach Spotify leiser'],
    ['spotify_volume_adjust', '-10', 'Senke Spotify um 20 Prozent'],
    ['set_volume', '40', 'Stelle Spotify auf 40 Prozent'],
    ['list_reminders', 'today', 'Zeige alle Erinnerungen'],
    ['list_reminders', 'upcoming', 'Welche Erinnerungen stehen heute an?'],
    ['list_reminders', 'today', 'Welche Erinnerungen stehen heute und morgen an?'],
    ['list_reminders', 'upcoming', 'Zeige alle Erinnerungen ab morgen'],
    ['lock_screen', '', 'Erkläre mir den Sperrbildschirm'],
    ['lock_screen', '', 'Sperre den Bildschirm später'],
    ['media_pause', 'spotify', 'Pausiere Spotify'],
  ] as const)(
    'does not semantically ground invented or unsupported plan parameter %s=%s',
    (action, param, evidence) => {
      const result = ground(action, param, evidence);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.validation).toBe('schema_only');
    },
  );
});
