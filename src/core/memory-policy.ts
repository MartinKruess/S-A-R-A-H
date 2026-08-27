export interface TurnPersistencePolicy {
  allowed: boolean;
  exclusions: readonly string[];
}

const BUILTIN_EXCLUSION_TERMS: Readonly<Record<string, readonly string[]>> = {
  'browser-daten': ['browser', 'browserverlauf', 'webverlauf', 'cookie', 'cookies', 'webseite', 'website', 'url'],
  'namen dritter': ['name', 'namen', 'heißt', 'heisst', 'person', 'kollege', 'kollegin'],
  gesundheit: ['gesundheit', 'krank', 'diagnose', 'arzt', 'ärzt', 'medizin', 'medikament', 'therapie', 'schmerz'],
  finanzen: ['finanz', 'bank', 'konto', 'kontostand', 'iban', 'geld', 'gehalt', 'kredit', 'versicherung'],
};

function normalizeForComparison(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase('de-DE');
}

function containsWebUrl(value: string): boolean {
  const candidates = value.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  return candidates.some((candidate) => {
    try {
      const parsed = new URL(candidate.replace(/[),.;!?]+$/u, ''));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  });
}

/**
 * @param contents - Sämtliche Inhalte eines abgeschlossenen Turns.
 * @param policy - Beim Turn-Start eingefrorene Memory-Freigabe und Ausschlüsse.
 *
 * - Verweigert Persistenz bei deaktiviertem Gedächtnis.
 * - Behandelt konfigurierte Ausschlüsse Unicode-normalisiert und ohne Beachtung der Großschreibung.
 * - Entscheidet konservativ für den gesamten Turn, damit Usertext und Antwort nicht getrennt gespeichert werden.
 *
 * @returns `true`, wenn kein Inhalt dieses Turns dauerhaft gespeichert werden darf.
 *
 * @category Authorization Data Access
 */
export function mustKeepTurnTransient(
  contents: readonly string[],
  policy: TurnPersistencePolicy,
): boolean {
  if (!policy.allowed) return true;
  const exclusions = policy.exclusions.flatMap((entry) => {
    const normalized = normalizeForComparison(entry);
    if (!normalized) return [];
    return [normalized, ...(BUILTIN_EXCLUSION_TERMS[normalized] ?? [])];
  });
  if (exclusions.length === 0) return false;

  const excludesBrowserData = policy.exclusions.some(
    (entry) => normalizeForComparison(entry) === 'browser-daten',
  );

  return contents.some((content) => {
    if (excludesBrowserData && containsWebUrl(content)) return true;
    const normalized = normalizeForComparison(content);
    return exclusions.some((exclusion) => normalized.includes(exclusion));
  });
}
