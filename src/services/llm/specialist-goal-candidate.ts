const ADDRESS_PATTERN = /^(?:(?:hey|hallo|hi)\s+)?sarah\s*[,;:!?-]?\s*/u;
const QUESTION_START_PATTERN = /^(?:wer|was|wann|wo|wohin|woher|warum|wieso|weshalb|wie|welch\p{L}*|wieviel\p{L}*)\b/u;
const POLITE_PREFIX_PATTERN = /^(?:bitte\s+)/u;
const REQUEST_MODAL_PATTERN = /^(?:kannst|koenntest|konntest|wuerdest|wurdest)\s+du\s+(?:bitte\s+)?/u;
const EXPLANATION_START_PATTERN = /^(?:(?:mir|uns)\s+)?(?:erklar\p{L}*|zeig\p{L}*|sag\p{L}*|beschreib\p{L}*)\b|^(?:ich\s+(?:mochte|will)\s+wissen)\b/u;
const DIRECT_CODING_VERB_PATTERN = /^(?:implementier\p{L}*|programmier\p{L}*|refaktorier\p{L}*|debugg\p{L}*)\b/u;
const DIRECT_RESEARCH_VERB_PATTERN = /^(?:recherchier\p{L}*|research)\b/u;
const CODING_OBJECT_PATTERN = /\b(?:code|coding|funktion\p{L}*|klasse\p{L}*|modul\p{L}*|test\p{L}*|bug\p{L}*|fehler\p{L}*|repository|repo|projekt\p{L}*|diff|api|tts)\b/u;
const CODING_MUTATION_PATTERN = /\b(?:implementier\p{L}*|programmier\p{L}*|refaktorier\p{L}*|debugg\p{L}*|reparier\p{L}*|beheb\p{L}*|fix\p{L}*)\b/u;
const BUILD_IN_PATTERN = /^bau\p{L}*\b.{1,240}\bin\b.{1,160}\bein\b/u;
const WRITE_CODE_PATTERN = /^schreib\p{L}*\b.{0,200}\b(?:code|funktion\p{L}*|klasse\p{L}*|test\p{L}*|modul\p{L}*|skript\p{L}*)\b/u;

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/ß/gu, 'ss')
    .toLocaleLowerCase('de-DE')
    .trim();
}

function stripRequestPreamble(value: string): string {
  const withoutAddress = value.replace(ADDRESS_PATTERN, '');
  const withoutPoliteness = withoutAddress.replace(POLITE_PREFIX_PATTERN, '');
  return withoutPoliteness.replace(REQUEST_MODAL_PATTERN, '').trimStart();
}

/**
 * Conservatively identifies a single explicit coding or research delegation goal.
 *
 * - Treats the result only as a reason to consult the router.
 * - Excludes ordinary questions and non-coding writing/build requests.
 * - Does not choose a provider or authorize a handoff.
 *
 * @category Validation
 */
export function looksLikeExplicitSpecialistGoal(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized || normalized.length > 1_000) return false;
  const candidate = stripRequestPreamble(normalized);
  if (
    !candidate
    || QUESTION_START_PATTERN.test(candidate)
    || EXPLANATION_START_PATTERN.test(candidate)
  ) return false;
  if (DIRECT_RESEARCH_VERB_PATTERN.test(candidate)) return true;
  if (DIRECT_CODING_VERB_PATTERN.test(candidate)) return true;
  if (BUILD_IN_PATTERN.test(candidate)) return true;
  if (WRITE_CODE_PATTERN.test(candidate)) return true;
  return CODING_OBJECT_PATTERN.test(candidate) && CODING_MUTATION_PATTERN.test(candidate);
}
