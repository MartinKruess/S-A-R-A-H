const POLITENESS = '(?:bitte|please)';
const REQUEST_MODAL = '(?:(?:kannst|koenntest|konntest|wuerdest|wurdest)\\s+du|(?:can|could|would)\\s+you)';
const DIRECTIVE_VERBS = [
  'erklaer(?:e|st|en)?', 'sag(?:e|st|en)?', 'erzaehl(?:e|st|en)?',
  'beantworte(?:st|n)?', 'beschreibe(?:st|n)?', 'vergleiche?(?:st|n)?',
  'fass(?:e|t|en)?', 'nenn(?:e|st|en)?', 'diskutiere(?:st|n)?',
  'analysiere(?:st|n)?', 'recherchiere(?:st|n)?', 'implementiere(?:st|n)?',
  'repariere(?:st|n)?', 'schreib(?:e|st|en)?', 'aender(?:e|st|n)?',
  'bau(?:e|st|en)?', 'pruef(?:e|st|en)?',
  'oeffne?(?:st|n)?', 'start(?:e|est|en)?', 'launch(?:e|st|en)?',
  'such(?:e|st|en)?', 'google(?:st|n)?', 'zeig(?:e|st|en)?',
  'stell(?:e|st|en)?', 'setz(?:e|t|en)?', 'mach(?:e|st|en)?',
  'erinner(?:e|st|n)?', 'loesch(?:e|st|en)?', 'entfern(?:e|st|en)?',
  'brich', 'stopp(?:e|st|en)?', 'pausier(?:e|st|en)?', 'spiel(?:e|st|en)?',
  'sperr(?:e|st|en)?', 'erhoeh(?:e|st|en)?', 'senk(?:e|st|en)?',
  'reduzier(?:e|st|en)?', 'dreh(?:e|st|en)?',
  'explain', 'tell', 'say', 'find', 'answer', 'discuss', 'describe', 'compare',
  'summarize', 'name', 'analyze', 'research', 'implement', 'repair', 'fix',
  'write', 'change', 'modify', 'build', 'check',
  'open', 'start', 'launch', 'search', 'google', 'show', 'set', 'make',
  'remind', 'delete', 'remove', 'cancel', 'stop', 'pause', 'play', 'lock',
  'increase', 'raise', 'lower', 'decrease', 'reduce', 'turn',
] as const;
const QUESTION_WORDS = [
  'wer', 'was', 'wann', 'wo', 'wohin', 'woher', 'warum', 'wieso', 'weshalb',
  'wie', 'welche(?:r|s|n|m)?', 'wieviel(?:e)?',
  'who', 'what', 'when', 'where', 'why', 'how', 'which',
] as const;
const DIRECTIVE_START_PATTERN = new RegExp(
  `^(?:${POLITENESS}\\s+)?(?:${DIRECTIVE_VERBS.join('|')})\\b`,
  'u',
);
const QUESTION_START_PATTERN = new RegExp(
  `^(?:${POLITENESS}\\s+)?(?:${QUESTION_WORDS.join('|')})\\b`,
  'u',
);
const DIRECTIVE_WITHIN_CLAUSE_PATTERN = new RegExp(
  `\\b(?:${DIRECTIVE_VERBS.join('|')})\\b`,
  'u',
);
const ADDRESS_PATTERN = /^(?:(?:hey|hallo|hi)\s+)?sarah\s*[,;:!?-]\s*/u;
const SHARED_MODAL_PATTERN = new RegExp(
  `^(?:${POLITENESS}\\s+)?${REQUEST_MODAL}\\s+(?:${POLITENESS}\\s+)?`,
  'u',
);
const MULTI_INTENT_CONNECTOR_PATTERN = /\b(?:und(?:\s+dann)?|sowie|dann|danach|anschliessend|daraufhin|ausserdem|zusaetzlich|oder|and(?:\s+then)?|then|afterwards|also|or)\b/gu;
const CLAUSE_BOUNDARY_PATTERN = /[,.!?;:&]["'”’)]*\s+/gu;
const FOLLOWING_CLAUSE_PREAMBLE_PATTERN = /^(?:(?:und|sowie|dann|danach|anschliessend|daraufhin|ausserdem|zusaetzlich|oder|and|then|afterwards|also|or)\s+)/u;
const EMBEDDED_QUESTION_INTRO_PATTERN = new RegExp(
  `^(?:${POLITENESS}\\s+)?${REQUEST_MODAL}\\s+(?:${POLITENESS}\\s+)?(?:mir|uns|me|us)?\\s*(?:sag(?:en)?|erklaer(?:en)?|beantworte(?:n)?|beschreib(?:en)?|tell|explain|answer|describe)\\b`,
  'u',
);

function normalizedCandidateText(value: string): string {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('de-DE')
    .replace(/ä/gu, 'ae')
    .replace(/ö/gu, 'oe')
    .replace(/ü/gu, 'ue')
    .replace(/ß/gu, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('de-DE');
}

function withoutAddress(value: string): string {
  return value.replace(ADDRESS_PATTERN, '');
}

function clauseContent(value: string, allowConnectorPreamble: boolean): {
  content: string;
  hasLocalModal: boolean;
} {
  const withoutPreamble = allowConnectorPreamble
    ? value.replace(FOLLOWING_CLAUSE_PREAMBLE_PATTERN, '')
    : value;
  const candidate = withoutAddress(withoutPreamble).trim();
  const modalMatch = candidate.match(SHARED_MODAL_PATTERN);
  return {
    content: modalMatch ? candidate.slice(modalMatch[0].length).trimStart() : candidate,
    hasLocalModal: modalMatch !== null,
  };
}

function hasObjectBeforeDirective(value: string): boolean {
  const words = value.match(/[a-z0-9]+/gu) ?? [];
  if (words.length < 2 || words.length > 18) return false;
  const directive = DIRECTIVE_WITHIN_CLAUSE_PATTERN.exec(value);
  if (!directive || directive.index === 0) return false;
  return /[a-z0-9]/u.test(value.slice(0, directive.index));
}

function startsExplicitIntentClause(
  value: string,
  options: { allowConnectorPreamble?: boolean; inheritedModal?: boolean } = {},
): boolean {
  const clause = clauseContent(value, options.allowConnectorPreamble ?? false);
  if (DIRECTIVE_START_PATTERN.test(clause.content) || QUESTION_START_PATTERN.test(clause.content)) {
    return true;
  }
  return (clause.hasLocalModal || options.inheritedModal === true)
    && hasObjectBeforeDirective(clause.content);
}

function beginsEmbeddedQuestion(left: string, right: string): boolean {
  const question = clauseContent(right, true).content;
  return QUESTION_START_PATTERN.test(question)
    && EMBEDDED_QUESTION_INTRO_PATTERN.test(withoutAddress(left).trim());
}

/** Conservatively identifies coordinated request clauses that require a validated plan. */
export function looksLikeBoundedMultiIntentCandidate(text: string): boolean {
  const normalized = withoutAddress(normalizedCandidateText(text).trim());
  const hasSharedModal = SHARED_MODAL_PATTERN.test(normalized);

  for (const connector of normalized.matchAll(MULTI_INTENT_CONNECTOR_PATTERN)) {
    const left = normalized.slice(0, connector.index ?? 0).trim();
    const tail = normalized.slice((connector.index ?? 0) + connector[0].length).trimStart();
    if (beginsEmbeddedQuestion(left, tail)) continue;
    if (
      startsExplicitIntentClause(left)
      && startsExplicitIntentClause(tail, { inheritedModal: hasSharedModal })
    ) return true;
  }
  for (const boundary of normalized.matchAll(CLAUSE_BOUNDARY_PATTERN)) {
    const left = normalized.slice(0, boundary.index ?? 0).trim();
    const tail = normalized.slice((boundary.index ?? 0) + boundary[0].length).trimStart();
    if (beginsEmbeddedQuestion(left, tail)) continue;
    if (
      startsExplicitIntentClause(left)
      && startsExplicitIntentClause(tail, {
        allowConnectorPreamble: true,
        inheritedModal: hasSharedModal,
      })
    ) return true;
  }
  return false;
}
