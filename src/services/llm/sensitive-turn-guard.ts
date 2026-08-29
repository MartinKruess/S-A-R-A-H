import { containsUnconditionallyPrivateData } from '../../core/memory-policy.js';

const REDACTION = '[VERTRAULICHE_DATEN]';
const SECRET_ASSIGNMENT = /(?:(?:passw(?:ort|ord)|password|passphrase|kennwort|pw|pwd|pin|puk|tan|otp|totp(?:[-_ ]?(?:code|token))?|api[-_ ]?(?:key|schl(?:u|ü)ssel)|(?:access|refresh|auth|bearer|session|id|oauth)[-_ ]?token|client[-_ ]?secret|recovery[-_ ]?code|kontonummer|kundennummer|cvv|cvc)\s*(?:ist|lautet|[:=])\s*)("[^"]{1,128}"|'[^']{1,128}'|[^\s,;]{3,128})/giu;
const LOGIN_ASSIGNMENT = /(?:(?:[\p{L}\p{N}-]+[-_ ])?login(?:daten)?|zugangsdaten)\s*(?:ist|lautet|sind|lauten|[:=])\s*([^\r\n]{3,128})/giu;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,3})?\b/gu;
const PAYMENT_CARD = /(?<![\p{L}\p{N}])(?:\d[ -]?){13,19}(?![\p{L}\p{N}])/gu;

export interface SensitiveTurnGuard {
  hasSensitiveInput: boolean;
  literals: readonly string[];
}

function collectMatches(
  input: string,
  pattern: RegExp,
  capture = 0,
  accept: (value: string) => boolean = () => true,
): string[] {
  pattern.lastIndex = 0;
  return [...input.matchAll(pattern)]
    .map((match) => match[capture]?.trim().replace(/^(['"])(.*)\1$/u, '$2') ?? '')
    .filter((value) => value.length >= 3 && accept(value));
}

function looksLikeSecretValue(value: string): boolean {
  return /\d/u.test(value) || /[^\p{L}.!?]/u.test(value);
}

/** Builds the exact-value guard used only for one sensitive user turn. */
export function createSensitiveTurnGuard(input: string): SensitiveTurnGuard {
  if (!containsUnconditionallyPrivateData(input)) return { hasSensitiveInput: false, literals: [] };
  const literals = [
    ...collectMatches(input, SECRET_ASSIGNMENT, 1, looksLikeSecretValue),
    ...collectMatches(input, LOGIN_ASSIGNMENT, 1),
    ...collectMatches(input, IBAN),
    ...collectMatches(input, PAYMENT_CARD),
  ];
  return {
    hasSensitiveInput: literals.length > 0,
    literals: [...new Set(literals)].sort((left, right) => right.length - left.length),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sensitiveLiteralPattern(literal: string): RegExp {
  const compact = literal.replace(/[\s-]/g, '');
  if (/^[A-Z]{2}\d{13,32}$/iu.test(compact) || /^\d{13,19}$/u.test(compact)) {
    return new RegExp([...compact].map(escapeRegExp).join('[\\s-]*'), 'giu');
  }
  return new RegExp(escapeRegExp(literal), 'giu');
}

/** Redacts only exact sensitive values learned from the current user turn. */
export function redactSensitiveLiterals(text: string, guard: SensitiveTurnGuard): string {
  return guard.literals.reduce(
    (result, literal) => result.replace(sensitiveLiteralPattern(literal), REDACTION),
    text,
  );
}

/** Prevents a secret-bearing turn from becoming reusable live model context. */
export function redactSensitiveLiveContext(text: string, guard: SensitiveTurnGuard): string {
  if (!guard.hasSensitiveInput) return text;
  const redacted = redactSensitiveLiterals(text, guard);
  return redacted === text ? '[SENSIBLE_NUTZERDATEN_AUS_LIVE_KONTEXT_ENTFERNT]' : redacted;
}
