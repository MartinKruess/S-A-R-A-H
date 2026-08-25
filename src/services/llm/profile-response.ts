import type { SarahConfig } from '../../core/config-schema.js';

const NAME_QUESTION_PATTERNS: readonly RegExp[] = [
  /\bwie (?:heiße|heisse) ich\b/i,
  /\bwas ist mein name\b/i,
  /\bkennst du meinen namen\b/i,
  /\bweißt du\b.*\b(?:meinen namen|wie ich (?:heiße|heisse))\b/i,
];

/**
 * @param text - Aktuelle Nutzernachricht.
 * @param profile - Autoritativer Profilstand der Anwendung.
 *
 * - Beantwortet exakt bekannte Profilfragen ohne Sprachmodell.
 * - Verhindert, dass ein Modell vorhandene Profildaten errät oder verneint.
 *
 * @returns Feste Antwort oder `null`, wenn die Nachricht freie Verarbeitung benötigt.
 *
 * @category Business Logic
 */
export function resolveProfileResponse(
  text: string,
  profile: SarahConfig['profile'],
): string | null {
  const normalized = text.normalize('NFC').trim();
  if (!NAME_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized))) return null;

  const name = profile.displayName.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
  return name ? `Du heißt ${name}.` : 'Du hast mir noch keinen Namen genannt.';
}
