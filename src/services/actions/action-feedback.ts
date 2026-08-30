import type { ActionName } from './action-schemas.js';
import {
  formatTimerDuration,
  parseTimerRequest,
  parseTimerSelector,
} from './timer-contract.js';
import {
  parseCancelReminderParam,
  parseListReminderParam,
  parseSetReminderParam,
} from './reminder-contract.js';

function safeTarget(param: string): string {
  const target = param.replace(/[\r\n\t]/g, ' ').trim().slice(0, 100);
  if (!target) return 'das Programm';
  return target.charAt(0).toLocaleUpperCase('de-DE') + target.slice(1);
}

/**
 * @param action - Validierte Aktion aus der zentralen Action-Allowlist.
 * @param param - Bereits schema-validierter Aktionsparameter.
 *
 * - Erzeugt eine sofortige, feste Rückmeldung während die Aktion läuft.
 * - Verhindert sichtbare freie Texte aus dem Routing-Modell.
 *
 * @returns Kurze deutsche Fortschrittsmeldung.
 *
 * @category Transformation
 */
export function getActionAcknowledgement(action: ActionName, param: string): string {
  switch (action) {
    case 'open_program':
      return `Ich öffne ${safeTarget(param)}.`;
    case 'web_search':
      return 'Ich suche danach.';
    case 'show_browser':
      return 'Ich öffne das Ergebnis.';
    case 'set_volume':
      return `Ich stelle die Systemlautstärke auf ${param} Prozent.`;
    case 'spotify_volume':
      return `Ich stelle Spotify auf ${param} Prozent.`;
    case 'spotify_volume_adjust': {
      const delta = Number(param);
      const direction = delta < 0 ? 'leiser' : 'lauter';
      const degree = Math.abs(delta) <= 10 ? 'etwas ' : '';
      return `Ich mache Spotify ${degree}${direction}.`;
    }
    case 'media_pause':
      return 'Ich pausiere die Wiedergabe.';
    case 'media_play':
      return 'Ich starte die Wiedergabe.';
    case 'media_toggle':
      return 'Ich wechsle den Wiedergabestatus.';
    case 'media_next':
      return 'Ich springe zum nächsten Titel.';
    case 'media_previous':
      return 'Ich springe zum vorherigen Titel.';
    case 'set_timer':
      {
        const timer = parseTimerRequest(param);
        if (!timer) return 'Ich stelle den Timer.';
        const duration = formatTimerDuration(timer.durationSeconds);
        return timer.label
          ? `Ich stelle den ${timer.label}-Timer auf ${duration}.`
          : `Ich stelle einen Timer auf ${duration}.`;
      }
    case 'cancel_timer': {
      const selector = parseTimerSelector(param);
      if (!selector) return 'Ich prüfe den Timer.';
      if (selector.kind === 'all') return 'Ich prüfe die laufenden Timer.';
      return selector.kind === 'label'
        ? `Ich prüfe den ${selector.label}-Timer.`
        : `Ich prüfe die Timer mit ${formatTimerDuration(selector.durationSeconds)} Laufzeit.`;
    }
    case 'set_reminder':
      return parseSetReminderParam(param)
        ? 'Ich speichere die Erinnerung.'
        : 'Ich prüfe die Erinnerung.';
    case 'list_reminders':
      return parseListReminderParam(param) === 'today'
        ? 'Ich schaue nach den heutigen Erinnerungen.'
        : 'Ich schaue nach deinen offenen Erinnerungen.';
    case 'cancel_reminder':
      return parseCancelReminderParam(param)?.kind === 'all'
        ? 'Ich prüfe alle offenen Erinnerungen.'
        : 'Ich prüfe die passende Erinnerung.';
    case 'lock_screen':
      return 'Ich sperre den Bildschirm.';
  }
}

/**
 * @param action - Validierte Aktion.
 * @param param - Bereits validierter Aktionsparameter.
 *
 * @returns Kurze nutzerseitige Beschreibung für eine Sicherheitsbestätigung.
 *
 * @category Transformation
 */
export function getActionConfirmationDescription(action: ActionName, param: string): string {
  switch (action) {
    case 'open_program':
      return `das Programm „${safeTarget(param)}“ öffnen`;
    case 'set_timer':
      {
        const timer = parseTimerRequest(param);
        if (!timer) return 'den Timer starten';
        const duration = formatTimerDuration(timer.durationSeconds);
        return timer.label
          ? `den ${timer.label}-Timer für ${duration} starten`
          : `einen Timer für ${duration} starten`;
      }
    case 'cancel_timer': {
      const selector = parseTimerSelector(param);
      if (!selector) return 'den Timer abbrechen';
      if (selector.kind === 'all') return 'alle Timer abbrechen';
      return selector.kind === 'label'
        ? `den ${selector.label}-Timer abbrechen`
        : `den Timer mit ${formatTimerDuration(selector.durationSeconds)} Laufzeit abbrechen`;
    }
    case 'set_reminder': {
      const reminder = parseSetReminderParam(param);
      return reminder
        ? `eine Erinnerung an „${safeTarget(reminder.text)}“ speichern`
        : 'eine Erinnerung speichern';
    }
    case 'list_reminders':
      return 'die offenen Erinnerungen anzeigen';
    case 'cancel_reminder': {
      const reminder = parseCancelReminderParam(param);
      if (reminder?.kind === 'all') return 'alle offenen Erinnerungen abbrechen';
      return 'die ausgewählte Erinnerung abbrechen';
    }
    case 'lock_screen':
      return 'den Bildschirm sperren';
    case 'set_volume':
      return `die Systemlautstärke auf ${param} Prozent setzen`;
    case 'spotify_volume':
      return `die Spotify-Lautstärke auf ${param} Prozent setzen`;
    case 'spotify_volume_adjust':
      return `die Spotify-Lautstärke um ${param} Prozent verändern`;
    case 'media_play':
    case 'media_pause':
    case 'media_toggle':
    case 'media_next':
    case 'media_previous':
      return 'die angeforderte Mediensteuerung ausführen';
    case 'web_search':
      return 'die Websuche ausführen';
    case 'show_browser':
      return 'das Suchergebnis öffnen';
  }
}
