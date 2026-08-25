import type { RuntimeSnapshot } from './app-lifecycle-controller.js';

export const CHAT_UNAVAILABLE_MESSAGE =
  'Sarah ist noch nicht bereit oder der Router ist nicht verfügbar.';

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
