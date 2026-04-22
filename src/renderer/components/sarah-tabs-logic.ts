/**
 * Pure helpers for sarah-tabs.
 *
 * Kapselt Keyboard-Mapping, Index-Arithmetik und URL-Hash-Resolution.
 * DOM-frei, damit in Node-Vitest ohne happy-dom/jsdom testbar.
 */

export type TabAction = 'next' | 'prev' | 'first' | 'last' | 'activate';

/**
 * Ordnet eine Keyboard-Taste einer Tab-Aktion zu.
 * Folgt dem WAI-ARIA Tabs-Pattern:
 *   - ArrowLeft / ArrowRight: Fokus wechseln
 *   - Home / End: zum ersten / letzten Tab springen
 *   - Enter / Space: aktuellen Fokus-Tab aktivieren
 */
export function keyToTabAction(key: string): TabAction | null {
  if (key === 'ArrowRight') return 'next';
  if (key === 'ArrowLeft') return 'prev';
  if (key === 'Home') return 'first';
  if (key === 'End') return 'last';
  if (key === 'Enter' || key === ' ') return 'activate';
  return null;
}

/**
 * Bestimmt den nächsten Tab-Index nach einer Aktion.
 * Wrap-around bei next/prev (letzter → erster, erster → letzter).
 * Bei leerer Tab-Liste (total === 0) wird der aktuelle Index zurückgegeben
 * (darf nicht crashen).
 */
export function nextTabIndex(
  current: number,
  action: 'next' | 'prev' | 'first' | 'last',
  total: number,
): number {
  if (total <= 0) return current;
  switch (action) {
    case 'next':  return (current + 1) % total;
    case 'prev':  return (current - 1 + total) % total;
    case 'first': return 0;
    case 'last':  return total - 1;
  }
}

/**
 * Löst den initial aktiven Tab aus dem URL-Hash auf.
 * Fällt auf `defaultId` zurück, wenn der Hash leer, ungültig oder nicht
 * in `validIds` enthalten ist. Führendes `#` wird optional gestripped.
 */
export function resolveInitialTabId(
  hash: string,
  defaultId: string,
  validIds: readonly string[],
): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return defaultId;
  return validIds.includes(raw) ? raw : defaultId;
}
