import type { TurnId } from './turn-contract.js';
import type { ProgramRole } from './config-schema.js';

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
