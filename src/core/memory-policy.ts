import {
  areMemoryExclusionsWithinLimits,
  normalizeMemoryExclusions,
} from './memory-exclusions.js';

export interface TurnPersistencePolicy {
  allowed: boolean;
  exclusions: readonly string[];
}

const INSURANCE_EXCLUSION_TERMS = [
  'versicherung', 'versicherungen', 'versicherungsdaten', 'versicherungsnummer', 'versicherungsnummern',
  'versicherungsschein', 'versicherungsscheine', 'versicherungsscheinnummer', 'versicherungsscheinnummern',
  'police', 'policen', 'policennummer', 'policennummern',
] as const;

export const MEMORY_EXCLUSION_CATEGORY_IDS = {
  BROWSER_DATA: 'browser-data',
  THIRD_PARTY_NAMES: 'third-party-names',
  HEALTH: 'health',
  FINANCES: 'finances',
  INSURANCE: 'insurance',
} as const;

const BUILTIN_EXCLUSION_TERMS: Readonly<Record<string, readonly string[]>> = {
  [MEMORY_EXCLUSION_CATEGORY_IDS.BROWSER_DATA]: [
    'browser', 'browserverlauf', 'webverlauf', 'cookie', 'cookies', 'webseite', 'webseiten', 'website', 'websites', 'url',
  ],
  [MEMORY_EXCLUSION_CATEGORY_IDS.HEALTH]: [
    'gesundheit', 'krank', 'krankheit', 'krankheiten', 'diagnose', 'diagnosen', 'arzt', 'aerztin', 'aerzte',
    'medizin', 'medikament', 'medikamente', 'therapie', 'therapien', 'schmerz', 'schmerzen', 'diabetes',
    'gesundheitszustand', 'blutdruck', 'blutdruckwert', 'blutdruckwerte', 'depression', 'depressionen',
    'gesundheitsdaten', 'erkrankung', 'erkrankungen', 'symptom', 'symptome', 'arzneimittel', 'behandlung',
    'behandlungen', 'befund', 'befunde', 'laborwert', 'laborwerte', 'hausarzt', 'facharzt', 'hiv', 'aids',
    'krebs', 'krebsdiagnose', 'krebserkrankung', 'tumor', 'tumore', 'psychiater', 'psychiaterin', 'psychiatrie',
    'ibuprofen', 'schwangerschaft',
    'schwanger', 'allergie', 'allergien', 'impfung', 'impfungen',
    'health', 'medical', 'illness', 'disease', 'diagnosis', 'diagnoses', 'doctor', 'physician', 'medication',
    'medicine', 'therapy', 'treatment', 'pain', 'blood pressure', 'cancer', 'tumor', 'psychiatrist', 'psychiatry',
    'pregnancy', 'pregnant', 'allergy', 'vaccination', 'lab result',
  ],
  [MEMORY_EXCLUSION_CATEGORY_IDS.FINANCES]: [
    'finanzen', 'finanziell', 'bank', 'banken', 'konto', 'konten', 'kontostand', 'iban', 'geld', 'gehalt',
    'kredit', 'kredite', 'versicherung', 'versicherungen', 'kartennummer', 'kreditkarte', 'debitkarte',
    'bankkonto', 'bankkonten', 'kontonummer', 'kontonummern', 'kontodaten', 'bankdaten',
    'bankverbindung', 'bankverbindungen', 'bic', 'bankleitzahl', 'blz', 'sparkasse', 'sparkassen',
    'depot', 'depots', 'depotnummer', 'depotnummern', ...INSURANCE_EXCLUSION_TERMS,
  ],
  [MEMORY_EXCLUSION_CATEGORY_IDS.INSURANCE]: INSURANCE_EXCLUSION_TERMS,
};

const EXCLUSION_CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  'browser-data': MEMORY_EXCLUSION_CATEGORY_IDS.BROWSER_DATA,
  'browser-daten': MEMORY_EXCLUSION_CATEGORY_IDS.BROWSER_DATA,
  browserdaten: MEMORY_EXCLUSION_CATEGORY_IDS.BROWSER_DATA,
  browserverlauf: MEMORY_EXCLUSION_CATEGORY_IDS.BROWSER_DATA,
  'third-party-names': MEMORY_EXCLUSION_CATEGORY_IDS.THIRD_PARTY_NAMES,
  'namen-dritter': MEMORY_EXCLUSION_CATEGORY_IDS.THIRD_PARTY_NAMES,
  'namen dritter': MEMORY_EXCLUSION_CATEGORY_IDS.THIRD_PARTY_NAMES,
  health: MEMORY_EXCLUSION_CATEGORY_IDS.HEALTH,
  gesundheit: MEMORY_EXCLUSION_CATEGORY_IDS.HEALTH,
  gesundheitsdaten: MEMORY_EXCLUSION_CATEGORY_IDS.HEALTH,
  'medizinische daten': MEMORY_EXCLUSION_CATEGORY_IDS.HEALTH,
  medical: MEMORY_EXCLUSION_CATEGORY_IDS.HEALTH,
  'medical data': MEMORY_EXCLUSION_CATEGORY_IDS.HEALTH,
  finances: MEMORY_EXCLUSION_CATEGORY_IDS.FINANCES,
  finance: MEMORY_EXCLUSION_CATEGORY_IDS.FINANCES,
  finanzen: MEMORY_EXCLUSION_CATEGORY_IDS.FINANCES,
  finanzdaten: MEMORY_EXCLUSION_CATEGORY_IDS.FINANCES,
  insurance: MEMORY_EXCLUSION_CATEGORY_IDS.INSURANCE,
  versicherung: MEMORY_EXCLUSION_CATEGORY_IDS.INSURANCE,
};

const SECRET_LABEL_PATTERN = /(?<![\p{L}\p{N}])(?:passw(?:o|ö)rter|passwords|passw(?:o|ö)rtern|passwort|password|passphrase|kennw(?:o|ö)rter|kennwort|pw|pwd|pin|puk|tan|otp|totp[-_ ]?(?:code|token)?|2fa[-_ ]?(?:code|token)?|mfa[-_ ]?(?:code|token)?|einmal(?:code|passwort)|verifizierungs[-_ ]?(?:code|token)|api[-_ ]?key|api[-_ ]?schl(?:u|ü)ssel|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|bearer[-_ ]?token|session[-_ ]?token|id[-_ ]?token|github[-_ ]?token|gitlab[-_ ]?token|oauth[-_ ]?token|zugriffs[-_ ]?token|client[-_ ]?secret|recovery[-_ ]?code|wiederherstellungs[-_ ]?code|backup[-_ ]?code|seed[-_ ]?phrase|recovery[-_ ]?seed|mnemonic|jwt|json[-_ ]?web[-_ ]?token|ssh[-_ ]?(?:private[-_ ]?key|privat(?:schl(?:u|ü)ssel|key))|private[-_ ]?key|privater[-_ ]?schl(?:u|ü)ssel|karten(?:nummer|pin)|kreditkarten(?:nummer|pin)|debitkarten(?:nummer|pin)|cvv|cvc|sicherheitscode|steuer(?:nummer|identifikationsnummer|[-_ ]?id)|sozialversicherungsnummer|personalausweisnummer|reisepassnummer|zugangsdaten)(?![\p{L}\p{N}])/iu;
const IBAN_PATTERN = /\b[A-Z]{2}\s?\d{2}(?:[\s-]?[A-Z0-9]){11,30}\b/iu;
const PAYMENT_CARD_CANDIDATE_PATTERN = /(?<![\p{L}\p{N}])(?:\d[ -]?){13,19}(?![\p{L}\p{N}])/gu;
const UUID_PATTERN = /(?<![\p{L}\p{N}])[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\p{L}\p{N}])/giu;
const SECRET_ASSIGNMENT_PATTERN = /\b(?:pin|puk|tan|otp|einmalcode|cvv|cvc)\b\s*(?:ist|lautet|[:=])?\s*[\p{L}\p{N}-]{3,128}\b/iu;
const LOGIN_ASSIGNMENT_PATTERN = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}-]+[-_ ])?login(?:daten)?(?![\p{L}\p{N}])\s*(?:ist|lautet|sind|lauten|[:=])/iu;
const BANK_INSURANCE_DATA_LABEL_PATTERN = /(?<![\p{L}\p{N}])(?:kontonummern?|kontodaten|kontostand|bankdaten|bankverbindungen?|bic|bankleitzahl|blz|depots?|depotnummern?|versicherungsdaten|versicherungsnummern?|versicherungsscheinnummern?|policennummern?)(?![\p{L}\p{N}])/iu;
const BANK_CUSTOMER_NUMBER_PATTERN = /(?:\b(?:bank|sparkasse)\b.{0,40}\bkundennummer\b|\bkundennummer\b.{0,40}\b(?:bank|sparkasse)\b)/iu;

function containsPaymentCardNumber(value: string): boolean {
  const withoutUuids = value.replace(UUID_PATTERN, '');
  return (withoutUuids.match(PAYMENT_CARD_CANDIDATE_PATTERN) ?? []).some((candidate) => {
    const digits = candidate.replace(/\D/gu, '');
    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (doubleDigit) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
  });
}

function normalizeForComparison(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .trim()
    .toLocaleLowerCase('de-DE');
}

/** Expands configured privacy categories into normalized match terms. */
export function expandMemoryExclusions(exclusions: readonly string[]): string[] {
  if (!areMemoryExclusionsWithinLimits(exclusions)) return [];
  return normalizeMemoryExclusions(exclusions).flatMap((entry) => {
    const normalized = normalizeForComparison(entry);
    if (!normalized) return [];
    const category = EXCLUSION_CATEGORY_ALIASES[normalized] ?? normalized;
    return [normalized, category, ...(BUILTIN_EXCLUSION_TERMS[category] ?? [])];
  });
}

/**
 * @param exclusions - Aktuell konfigurierte Memory-Ausschlüsse.
 * @param category - Exakter Kategoriename, dessen Aktivierung geprüft wird.
 *
 * - Normalisiert Großschreibung und Unicode wie die Persistenzprüfung.
 * - Wertet keine Teilbegriffe oder erweiterten Kategorieterme als Konfiguration.
 *
 * @returns `true`, wenn die Kategorie ausdrücklich konfiguriert ist.
 *
 * @category Authorization Validation
 */
export function hasConfiguredMemoryExclusion(
  exclusions: readonly string[],
  category: string,
): boolean {
  const normalizedCategory = normalizeForComparison(category);
  const categoryId = EXCLUSION_CATEGORY_ALIASES[normalizedCategory] ?? normalizedCategory;
  return exclusions.some((entry) => {
    const normalizedEntry = normalizeForComparison(entry);
    return (EXCLUSION_CATEGORY_ALIASES[normalizedEntry] ?? normalizedEntry) === categoryId;
  });
}

export class MemoryPolicyApplyError extends Error {
  readonly code = 'MEMORY_POLICY_APPLY_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'MemoryPolicyApplyError';
  }
}

function tokenize(value: string): string[] {
  return normalizeForComparison(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsTokenSequence(content: string, candidate: string): boolean {
  const contentTokens = tokenize(content);
  const candidateTokens = tokenize(candidate);
  if (candidateTokens.length === 0 || candidateTokens.length > contentTokens.length) return false;
  return contentTokens.some((_, index) => candidateTokens.every(
    (token, offset) => contentTokens[index + offset] === token,
  ));
}

/**
 * @param value - Inhalt, der eventuell ein niemals speicherbares Geheimnis enthält.
 *
 * - Erkennt bezeichnete Zugangsdaten und hochsensible Identifikationswerte.
 * - Erkennt IBANs und typische ZahlungsKartennummern unabhängig von Memory-Einstellungen.
 *
 * @returns `true`, wenn der Inhalt technisch nie in Gesprächs-Memory gelangen darf.
 *
 * @category Authorization Validation
 */
export function containsUnconditionallyPrivateData(value: string): boolean {
  // Unicode format controls are invisible in UI text and must not let a label
  // such as API_KEY or PASSWORT bypass the immutable persistence guard.
  const visibleValue = value.normalize('NFKC').replace(/\p{Cf}+/gu, '');
  return SECRET_LABEL_PATTERN.test(visibleValue)
    || SECRET_ASSIGNMENT_PATTERN.test(visibleValue)
    || LOGIN_ASSIGNMENT_PATTERN.test(visibleValue)
    || BANK_INSURANCE_DATA_LABEL_PATTERN.test(visibleValue)
    || BANK_CUSTOMER_NUMBER_PATTERN.test(visibleValue)
    || IBAN_PATTERN.test(visibleValue)
    || containsPaymentCardNumber(visibleValue);
}

function containsWebUrl(value: string): boolean {
  const candidates = value.match(/(?:https?:\/\/|www\.)[^\s<>"']+|(?<![@\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63}(?:\/[^\s<>"']*)?/giu) ?? [];
  return candidates.some((candidate) => {
    try {
      const normalized = /^https?:\/\//iu.test(candidate) ? candidate : `https://${candidate}`;
      const parsed = new URL(normalized.replace(/[),.;!?]+$/u, ''));
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
  if (!areMemoryExclusionsWithinLimits(policy.exclusions)) return true;
  if (contents.some(containsUnconditionallyPrivateData)) return true;

  // A local token list cannot reliably distinguish a third-party name from
  // first-party or harmless prose. This category therefore fails closed: its
  // privacy guarantee takes precedence over retaining any otherwise safe turn.
  // Trade-off: while enabled, all turns remain transient.
  if (hasConfiguredMemoryExclusion(
    policy.exclusions,
    MEMORY_EXCLUSION_CATEGORY_IDS.THIRD_PARTY_NAMES,
  )) return true;

  const exclusions = expandMemoryExclusions(policy.exclusions);
  if (exclusions.length === 0) return false;

  const excludesBrowserData = hasConfiguredMemoryExclusion(
    policy.exclusions,
    MEMORY_EXCLUSION_CATEGORY_IDS.BROWSER_DATA,
  );

  return contents.some((content) => {
    if (excludesBrowserData && containsWebUrl(content)) return true;
    return exclusions.some((exclusion) => containsTokenSequence(content, exclusion));
  });
}
