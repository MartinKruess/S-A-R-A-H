export interface KeyAccessRetryOptions {
  retries: number;
  delayMs: number;
  isTransient: (error: Error) => boolean;
  wait?: (delayMs: number) => Promise<void>;
}

/**
 * @param operation - Initialisierung, die auf den Schlüsselschutz des Betriebssystems zugreift.
 * @param options - Begrenzte Wiederholungs- und Fehlerklassifikation.
 *
 * - Wiederholt ausschließlich ausdrücklich vorübergehende Schlüsselzugriffsfehler.
 * - Reicht endgültigen Schlüsselverlust und fachfremde Fehler sofort weiter.
 * - Begrenzt die Versuche, damit Sarah nicht in einer Startschleife hängen bleibt.
 *
 * @returns Ergebnis des ersten erfolgreichen Initialisierungsversuchs.
 *
 * @category Recovery Utility
 */
export async function retryTransientKeyAccess<T>(
  operation: () => Promise<T>,
  options: KeyAccessRetryOptions,
): Promise<T> {
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      if (!options.isTransient(error) || attempt >= options.retries) throw error;
      await wait(options.delayMs);
    }
  }
}
