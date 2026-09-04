import {
  MAX_DECISION_PROGRAM_NAME_LENGTH,
  MAX_DECISION_SOURCE_DESCRIPTION_LENGTH,
  MAX_DECISION_SOURCE_HINTS,
  MAX_DECISION_SOURCE_ID_LENGTH,
  createDecisionContext,
  isSafeDecisionLabel,
  type DecisionCapabilitySnapshot,
  type DecisionContext,
  type DecisionProgramRole,
  type DecisionSourceHint,
} from '../../core/decision-context.js';
import type { Profile, Resources } from '../../core/config-schema.js';
import type { TurnEnvelope } from '../../core/turn-contract.js';

export interface DecisionContextBuilderInput {
  readonly envelope: TurnEnvelope;
  readonly privateContext: boolean;
  readonly profile: Pick<Profile, 'linkPreferences'>;
  readonly resources: Pick<Resources, 'programs' | 'programRoles'>;
  readonly capabilities: DecisionCapabilitySnapshot;
}

const SOURCE_MATCH_STOP_WORDS: ReadonlySet<string> = new Set([
  'aber', 'alle', 'auf', 'aus', 'bei', 'bitte', 'das', 'den', 'der', 'die', 'ein', 'eine',
  'einen', 'einer', 'fuer', 'für', 'ich', 'im', 'in', 'ist', 'mal', 'mein', 'meine', 'mit',
  'mir', 'nach', 'oder', 'suche', 'such', 'und', 'von', 'was', 'wie', 'zu', 'zum', 'zur',
]);

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('de-DE');
}

function boundedValue(value: string, maxLength: number): string | null {
  const normalized = value.normalize('NFC').trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

/**
 * Rejects planner labels that contain executable location details.
 *
 * - Keeps human-readable names and descriptions intact.
 * - Fails closed for URL, Windows/UNC, and absolute or relative Unix path literals.
 *
 * @category Validation
 */
function boundedPlannerLabel(value: string, maxLength: number): string | null {
  const bounded = boundedValue(value, maxLength);
  if (!bounded) return null;
  return isSafeDecisionLabel(bounded) ? bounded : null;
}

function sourceTokens(value: string): readonly string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('de-DE')
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => token.length >= 3 && !SOURCE_MATCH_STOP_WORDS.has(token));
}

function tokensMatch(left: string, right: string): boolean {
  if (left === right) return true;
  return left.length >= 4 && right.length >= 4
    && (left.startsWith(right) || right.startsWith(left));
}

function resolveProgramRoles(resources: DecisionContextBuilderInput['resources']): readonly DecisionProgramRole[] {
  const resolved: DecisionProgramRole[] = [];
  for (const binding of resources.programRoles) {
    const requestedName = normalizedIdentity(binding.programName);
    const matches = resources.programs.filter((program) => (
      program.verified && normalizedIdentity(program.name) === requestedName
    ));
    if (matches.length !== 1) continue;
    const programName = boundedPlannerLabel(
      matches[0]?.name ?? '',
      MAX_DECISION_PROGRAM_NAME_LENGTH,
    );
    if (!programName) continue;
    resolved.push({ role: binding.role, programName });
  }
  return resolved;
}

function selectPreferredSourceHints(
  effectiveText: string,
  profile: DecisionContextBuilderInput['profile'],
): readonly DecisionSourceHint[] {
  const queryTokens = sourceTokens(effectiveText);
  if (queryTokens.length === 0) return [];
  const hints: DecisionSourceHint[] = [];
  const seenIds = new Set<string>();

  for (const preference of profile.linkPreferences) {
    const id = boundedPlannerLabel(preference.id, MAX_DECISION_SOURCE_ID_LENGTH);
    const description = boundedPlannerLabel(
      preference.description,
      MAX_DECISION_SOURCE_DESCRIPTION_LENGTH,
    );
    if (!id || !description || seenIds.has(id)) continue;
    const preferenceTokens = sourceTokens(description);
    const relevant = queryTokens.some((queryToken) => (
      preferenceTokens.some((preferenceToken) => tokensMatch(queryToken, preferenceToken))
    ));
    if (!relevant) continue;
    seenIds.add(id);
    hints.push({ id, description });
    if (hints.length === MAX_DECISION_SOURCE_HINTS) break;
  }
  return hints;
}

/**
 * Projects one turn and its explicit local preferences into bounded planner context.
 *
 * - Resolves program roles only through one verified canonical program name.
 * - Selects relevant source descriptions without exposing their URLs.
 * - Carries custom-command identity but never arguments or expanded text as metadata.
 *
 * @returns Immutable, defensively copied context for the current decision only.
 *
 * @category Transformation Validation
 */
export function buildDecisionContext(input: DecisionContextBuilderInput): DecisionContext {
  const inputOrigin = input.envelope.command.kind === 'custom'
    ? {
      kind: 'custom_command_expansion' as const,
      customCommand: input.envelope.command.command,
    }
    : { kind: 'user_text' as const };

  return createDecisionContext({
    version: 1,
    turn: {
      turnId: input.envelope.turnId,
      mode: input.envelope.mode,
      privateContext: input.privateContext || input.envelope.command.kind === 'anonymous',
      inputOrigin,
    },
    programRoles: resolveProgramRoles(input.resources),
    preferredSourceHints: selectPreferredSourceHints(input.envelope.effectiveText, input.profile),
    capabilities: input.capabilities,
  });
}
