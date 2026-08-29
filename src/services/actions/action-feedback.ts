import type { ActionName } from './action-schemas.js';

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
      return `Ich stelle einen Timer auf ${param} Minuten.`;
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
      return `einen Timer für ${param} Minuten starten`;
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
