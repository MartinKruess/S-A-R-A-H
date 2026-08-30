export type BootPerformanceEvent = 'start' | 'ready' | 'failed';

type BootPerformanceDetails = Record<string, string | number | boolean | null>;

/**
 * @param component - Technischer Startabschnitt ohne Nutzinhalte.
 * @param event - Beginn oder terminales Ergebnis des Abschnitts.
 * @param details - Optionale technische Messwerte.
 *
 * - Schreibt nur bei explizit aktiviertem `SARAH_BOOT_TRACE`.
 * - Nutzt die gemeinsame monotone Prozesszeit für vergleichbare Abschnitte.
 *
 * @category Utility
 */
export function traceBootPerformance(
  component: string,
  event: BootPerformanceEvent,
  details: BootPerformanceDetails = {},
): void {
  if (process.env.SARAH_BOOT_TRACE !== '1') return;
  console.log('[BootPerf]', JSON.stringify({
    component,
    event,
    atMs: performance.now(),
    ...details,
  }));
}
