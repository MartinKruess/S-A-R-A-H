import type { RuntimeSnapshot } from './app-lifecycle-controller.js';

export const CHAT_UNAVAILABLE_MESSAGE =
  'Sarah ist noch nicht bereit oder der Router ist nicht verfügbar.';

export const WORKER_UNAVAILABLE_MESSAGE =
  'Auf meine tieferen Gedanken kann ich gerade nicht zugreifen. Einfache Befehle funktionieren weiterhin.';

export const STT_UNAVAILABLE_MESSAGE =
  'Meine Spracherkennung ist gerade nicht verfügbar. Du kannst mir weiterhin im Chat schreiben.';

export const TTS_UNAVAILABLE_MESSAGE =
  'Meine Sprachausgabe ist gerade nicht verfügbar. Textantworten und Spracheingabe funktionieren weiterhin.';

/**
 * @param snapshot - Aktueller, zentral veröffentlichter Laufzeitstatus.
 *
 * - Akzeptiert Eingaben nur in einem arbeitsfähigen Gesamtzustand.
 * - Verlangt zusätzlich einen nachweislich bereiten Router.
 *
 * @returns Ob Text- und Spracheingaben verarbeitet werden können.
 *
 * @category Validation
 */
export function isChatAvailable(snapshot: RuntimeSnapshot): boolean {
  return ['ready', 'degraded'].includes(snapshot.state)
    && snapshot.capabilities.router?.state === 'ready';
}
