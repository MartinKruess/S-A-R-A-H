import type { TurnId } from './turn-contract.js';

export type ActionDecisionSource = 'router_model' | 'deterministic_shortcut';
export type ActionValidation = 'schema_only' | 'semantic_grounding';
export type ActionInteractionContext = 'media_followup' | 'reminder_cancel_followup' | 'visible_search_result';

export type ActionEvidence =
  | { readonly evidenceSource: 'user_text' }
  | { readonly evidenceSource: 'custom_command_expansion'; readonly customCommand: string };

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
  interactionContext?: Readonly<{
    kind: ActionInteractionContext;
    contextTurnId: TurnId;
  }>;
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
