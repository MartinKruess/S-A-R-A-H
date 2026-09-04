import type { TurnId } from './turn-contract.js';
import { isActionName, type ActionName } from './action-name.js';
import { PROGRAM_ROLES, type ProgramRole } from './config-schema.js';

export type ActionDecisionSource = 'router_model' | 'deterministic_shortcut';
export type ActionValidation = 'schema_only' | 'semantic_grounding';
export type ActionInteractionContext = 'media_followup' | 'reminder_cancel_followup' | 'visible_search_result';

/**
 * Binds parameter evidence either to the complete effective turn text or to one validated clause.
 * Clause offsets use the effective text and an exclusive end offset.
 *
 * @category Validation
 */
export type ActionEvidenceScope =
  | { readonly kind: 'whole_turn' }
  | {
    readonly kind: 'clause';
    readonly intentId: string;
    readonly ordinal: 0 | 1 | 2;
    readonly startOffset: number;
    readonly endOffset: number;
  };

export type ActionEvidence =
  | { readonly evidenceSource: 'user_text' }
  | { readonly evidenceSource: 'custom_command_expansion'; readonly customCommand: string };

export interface ActionParameterResolution {
  readonly kind: 'program_role';
  readonly role: ProgramRole;
  readonly programName: string;
}

/**
 * Describes action provenance that the router model cannot choose freely.
 *
 * - Separates decision source, parameter evidence, and validation strength.
 * - Carries neither raw input text nor custom-command arguments.
 *
 * @category Validation
 */
export type ActionProvenance = Readonly<{
  sourceTurnId: TurnId;
  decisionSource: ActionDecisionSource;
  validation: ActionValidation;
  evidenceScope: ActionEvidenceScope;
  interactionContext?: Readonly<{
    kind: ActionInteractionContext;
    contextTurnId: TurnId;
  }>;
  parameterResolution?: ActionParameterResolution;
}> & ActionEvidence;

/**
 * Represents one normalized action before confirmation or execution.
 *
 * - `param` contains the canonical string produced by the action schema.
 * - `provenance` remains unchanged through confirmation and execution.
 *
 * @category Validation
 */
export interface ActionIntent<TAction extends string = string> {
  readonly action: TAction;
  readonly param: string;
  readonly provenance: ActionProvenance;
}

const ACTION_DECISION_SOURCES: ReadonlySet<string> = new Set([
  'router_model',
  'deterministic_shortcut',
]);
const ACTION_VALIDATIONS: ReadonlySet<string> = new Set([
  'schema_only',
  'semantic_grounding',
]);
const ACTION_INTERACTION_CONTEXTS: ReadonlySet<string> = new Set([
  'media_followup',
  'reminder_cancel_followup',
  'visible_search_result',
]);
const ACTION_PROGRAM_ROLES: ReadonlySet<string> = new Set(PROGRAM_ROLES);

function isBoundedText(value: string, maxLength: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

/**
 * Validates the shared runtime shape of an action intent at trust boundaries.
 *
 * - Enforces the central action allowlist and bounded canonical parameters.
 * - Validates provenance enums, evidence offsets and optional context bindings.
 * - Requires program-role resolution to match the final open-program parameter.
 *
 * @returns Whether the intent is structurally safe to copy, plan or confirm.
 *
 * @category Validation
 */
export function isValidActionIntent(
  intent: ActionIntent | null | undefined,
): intent is ActionIntent<ActionName> {
  if (!intent || typeof intent !== 'object') return false;
  if (typeof intent.action !== 'string' || !isActionName(intent.action)) return false;
  if (typeof intent.param !== 'string' || intent.param.length > 300) return false;
  const provenance = intent.provenance;
  if (!provenance || typeof provenance !== 'object') return false;
  if (!isBoundedText(provenance.sourceTurnId, 128)) return false;
  if (!ACTION_DECISION_SOURCES.has(provenance.decisionSource)) return false;
  if (!ACTION_VALIDATIONS.has(provenance.validation)) return false;

  const scope = provenance.evidenceScope;
  if (!scope || typeof scope !== 'object') return false;
  if (scope.kind === 'clause') {
    if (
      !isBoundedText(scope.intentId, 128)
      || !Number.isSafeInteger(scope.ordinal)
      || scope.ordinal < 0
      || scope.ordinal > 2
      || !Number.isSafeInteger(scope.startOffset)
      || !Number.isSafeInteger(scope.endOffset)
      || scope.startOffset < 0
      || scope.endOffset <= scope.startOffset
    ) return false;
  } else if (scope.kind !== 'whole_turn') {
    return false;
  }

  if (provenance.evidenceSource === 'custom_command_expansion') {
    if (!/^\/[a-z0-9_-]{1,50}$/iu.test(provenance.customCommand)) return false;
  } else if (provenance.evidenceSource !== 'user_text') {
    return false;
  }

  const interaction = provenance.interactionContext;
  if (interaction !== undefined && (
    !interaction
    || !ACTION_INTERACTION_CONTEXTS.has(interaction.kind)
    || !isBoundedText(interaction.contextTurnId, 128)
  )) return false;

  const resolution = provenance.parameterResolution;
  if (resolution !== undefined && (
    !resolution
    || intent.action !== 'open_program'
    || resolution.kind !== 'program_role'
    || !ACTION_PROGRAM_ROLES.has(resolution.role)
    || !isBoundedText(resolution.programName, 100)
    || resolution.programName !== intent.param
  )) return false;

  return true;
}
