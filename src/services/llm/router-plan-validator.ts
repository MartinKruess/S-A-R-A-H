import { randomUUID } from 'node:crypto';
import type {
  ActionIntent,
  ActionParameterResolution,
  ActionProvenance,
} from '../../core/action-intent.js';
import type { ProgramRole } from '../../core/config-schema.js';
import {
  createDecisionContext,
  type DecisionCapability,
  type DecisionContext,
} from '../../core/decision-context.js';
import {
  createIntentPlan,
  type IntentClauseReference,
  type IntentPlan,
  type ValidatedExplicitIntent,
} from '../../core/intent-plan.js';
import type { TurnEnvelope } from '../../core/turn-contract.js';
import { isActionName, type ActionName } from '../actions/action-schemas.js';
import type { ReminderClock } from '../actions/reminder-contract.js';
import { groundActionRequest } from './router-action-grounding.js';
import {
  parseRouterPlanProposal,
  routerPlanProposalSchema,
  type RouterIntentProposal,
  type RouterPlanProposal,
  type RouterProposalParseFailure,
} from './router-proposal-contract.js';

export type RouterPlanFailure =
  | `proposal_${RouterProposalParseFailure}`
  | 'missing_evidence'
  | 'ambiguous_evidence'
  | 'incomplete_evidence'
  | 'unordered_evidence'
  | 'unknown_action'
  | 'insufficient_action_grounding'
  | 'decision_context_mismatch'
  | 'capability_unavailable'
  | 'unresolved_program_role'
  | 'invalid_action'
  | 'invalid_plan';

export type RouterPlanResult =
  | { readonly ok: true; readonly plan: IntentPlan }
  | { readonly ok: false; readonly reason: RouterPlanFailure };

export interface RouterPlanValidationDependencies {
  readonly reminderClock: ReminderClock;
  readonly decisionContext: DecisionContext;
  readonly createIntentId?: () => string;
}

type EvidenceResolution =
  | { readonly ok: true; readonly evidence: IntentClauseReference; readonly text: string }
  | { readonly ok: false; readonly reason: 'missing_evidence' | 'ambiguous_evidence' };

const ALLOWED_CONNECTOR_WORDS: ReadonlySet<string> = new Set([
  'und',
  'sowie',
  'dann',
  'danach',
  'anschließend',
  'anschliessend',
  'daraufhin',
  'außerdem',
  'ausserdem',
  'and',
  'then',
  'afterwards',
  'also',
]);

const SEQUENTIAL_CONNECTOR_WORDS: ReadonlySet<string> = new Set([
  'dann',
  'danach',
  'anschließend',
  'anschliessend',
  'daraufhin',
  'then',
  'afterwards',
]);

function connectorOrder(text: string): ValidatedExplicitIntent['order'] | null {
  const words = text
    .replace(/[\s,;:.!?&()[\]{}'"„“‚‘\-–—]+/gu, ' ')
    .trim()
    .toLocaleLowerCase('de-DE')
    .split(' ')
    .filter((word) => word.length > 0);
  if (words.some((word) => !ALLOWED_CONNECTOR_WORDS.has(word))) return null;
  return words.some((word) => SEQUENTIAL_CONNECTOR_WORDS.has(word))
    ? 'after_previous'
    : 'independent';
}

function intentOrdinal(index: number): 0 | 1 | 2 {
  if (index === 0 || index === 1 || index === 2) return index;
  throw new Error('Intent ordinal is outside the bounded contract');
}

function resolveEvidence(
  effectiveText: string,
  evidenceText: string,
  ordinal: 0 | 1 | 2,
  createIntentId: () => string,
): EvidenceResolution {
  const normalizedEvidence = evidenceText.normalize('NFC').trim();
  const startOffset = effectiveText.indexOf(normalizedEvidence);
  if (startOffset < 0) return { ok: false, reason: 'missing_evidence' };
  if (effectiveText.indexOf(normalizedEvidence, startOffset + 1) >= 0) {
    return { ok: false, reason: 'ambiguous_evidence' };
  }
  return {
    ok: true,
    evidence: {
      intentId: createIntentId(),
      ordinal,
      startOffset,
      endOffset: startOffset + normalizedEvidence.length,
    },
    text: normalizedEvidence,
  };
}

function createActionProvenance(
  envelope: TurnEnvelope,
  evidence: IntentClauseReference,
  validation: ActionProvenance['validation'],
  parameterResolution?: ActionParameterResolution,
): ActionProvenance {
  const inputEvidence = envelope.command.kind === 'custom'
    ? {
      evidenceSource: 'custom_command_expansion' as const,
      customCommand: envelope.command.command,
    }
    : { evidenceSource: 'user_text' as const };
  return {
    sourceTurnId: envelope.turnId,
    decisionSource: 'router_model',
    validation,
    evidenceScope: { kind: 'clause', ...evidence },
    ...(parameterResolution ? { parameterResolution } : {}),
    ...inputEvidence,
  };
}

const PROGRAM_ROLE_PHRASES: Readonly<Record<ProgramRole, RegExp>> = {
  browser: /\b(?:browser|internetbrowser)\b/iu,
  code_editor: /\b(?:editor|code[\s-]?editor|entwicklungsumgebung|ide)\b/iu,
  music_player: /\b(?:musik[\s-]?player|player)\b/iu,
};
const OPEN_PROGRAM_REQUEST = /\b(?:offn[a-z]*|start[a-z]*|launch[a-z]*)\b|\bmach\b.{0,60}\bauf\b/u;

function normalizedGroundingText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('de-DE');
}

function resolveProgramRoleAction(
  proposal: Extract<RouterIntentProposal, { kind: 'action' }>,
  evidenceText: string,
  context: DecisionContext,
): { readonly param: string; readonly resolution: ActionParameterResolution } | null {
  if (proposal.action !== 'open_program') return null;
  const match = /^role:(browser|code_editor|music_player)$/u.exec(proposal.param);
  const role = match?.[1] as ProgramRole | undefined;
  const normalizedEvidence = normalizedGroundingText(evidenceText);
  if (
    !role
    || !OPEN_PROGRAM_REQUEST.test(normalizedEvidence)
    || !PROGRAM_ROLE_PHRASES[role].test(normalizedEvidence)
  ) return null;
  const bindings = context.programRoles.filter((binding) => binding.role === role);
  if (bindings.length !== 1) return null;
  const binding = bindings[0];
  if (!binding) return null;
  return {
    param: binding.programName,
    resolution: {
      kind: 'program_role',
      role,
      programName: binding.programName,
    },
  };
}

function isCapabilityAvailable(capability: DecisionCapability): boolean {
  return capability.state === 'available';
}

function actionCapabilityAvailable(action: ActionName, context: DecisionContext): boolean {
  if (!isCapabilityAvailable(context.capabilities.actions)) return false;
  if (action === 'web_search') return isCapabilityAvailable(context.capabilities.webSearch);
  if (action === 'show_browser') {
    return isCapabilityAvailable(context.capabilities.visibleBrowserResult);
  }
  if (action === 'set_reminder' || action === 'list_reminders' || action === 'cancel_reminder') {
    return isCapabilityAvailable(context.capabilities.reminders);
  }
  if (
    action === 'spotify_volume'
    || action === 'spotify_volume_adjust'
    || action === 'media_play'
    || action === 'media_pause'
    || action === 'media_toggle'
    || action === 'media_next'
    || action === 'media_previous'
  ) return isCapabilityAvailable(context.capabilities.media);
  return true;
}

function contextMatchesEnvelope(context: DecisionContext, envelope: TurnEnvelope): boolean {
  if (context.turn.turnId !== envelope.turnId || context.turn.mode !== envelope.mode) return false;
  if (envelope.command.kind === 'anonymous' && !context.turn.privateContext) return false;
  if (envelope.command.kind === 'custom') {
    return context.turn.inputOrigin.kind === 'custom_command_expansion'
      && context.turn.inputOrigin.customCommand === envelope.command.command;
  }
  return context.turn.inputOrigin.kind === 'user_text';
}

function validateActionProposal(
  proposal: Extract<RouterIntentProposal, { kind: 'action' }>,
  evidence: IntentClauseReference,
  evidenceText: string,
  envelope: TurnEnvelope,
  reminderClock: ReminderClock,
  context: DecisionContext,
): ActionIntent<ActionName> | RouterPlanFailure {
  if (!isActionName(proposal.action)) return 'unknown_action';
  if (!actionCapabilityAvailable(proposal.action, context)) return 'capability_unavailable';
  const roleResolution = resolveProgramRoleAction(proposal, evidenceText, context);
  if (proposal.action === 'open_program' && proposal.param.startsWith('role:')) {
    if (!roleResolution) return 'unresolved_program_role';
    return {
      action: proposal.action,
      param: roleResolution.param,
      provenance: createActionProvenance(
        envelope,
        evidence,
        'semantic_grounding',
        roleResolution.resolution,
      ),
    };
  }
  const grounding = groundActionRequest(
    proposal.action,
    proposal.param,
    evidenceText,
    reminderClock,
  );
  if (!grounding.ok) return 'invalid_action';
  if (grounding.validation !== 'semantic_grounding') return 'insufficient_action_grounding';
  const intent: ActionIntent<ActionName> = {
    action: proposal.action,
    param: grounding.param,
    provenance: createActionProvenance(envelope, evidence, grounding.validation),
  };
  return intent;
}

function validateProposalIntent(
  proposal: RouterIntentProposal,
  evidence: IntentClauseReference,
  evidenceText: string,
  order: ValidatedExplicitIntent['order'],
  envelope: TurnEnvelope,
  reminderClock: ReminderClock,
  context: DecisionContext,
): ValidatedExplicitIntent | RouterPlanFailure {
  if (proposal.kind === 'action') {
    const action = validateActionProposal(
      proposal,
      evidence,
      evidenceText,
      envelope,
      reminderClock,
      context,
    );
    return typeof action === 'string' ? action : { kind: 'action', order, intent: action };
  }
  if (proposal.kind === 'answer') {
    if (!isCapabilityAvailable(context.capabilities.localAnswer)) {
      return 'capability_unavailable';
    }
    return { kind: 'answer', order, evidence, text: evidenceText };
  }
  if (!isCapabilityAvailable(context.capabilities.specialists[proposal.specialist])) {
    return 'capability_unavailable';
  }
  return {
    kind: 'handoff',
    order,
    evidence,
    capability: proposal.specialist,
    task: evidenceText,
  };
}

/**
 * @param proposal - Bereits strukturell geprüfter, aber nicht vertrauenswürdiger Router-Vorschlag.
 * @param envelope - Autoritativer Turn mit dem wirksamen Quelltext.
 * @param dependencies - Lokale Clock- und ID-Abhängigkeiten.
 *
 * - Verankert jede Klausel eindeutig und in Nutzerreihenfolge.
 * - Prüft Actions ausschließlich gegen ihre eigene Klausel.
 * - Erzeugt einen lokalen Plan, ohne etwas auszuführen oder zu veröffentlichen.
 *
 * @returns Vollständiger vertrauenswürdiger Plan oder ein einzelner Ablehnungsgrund.
 *
 * @category Validation Business Logic
 */
export function validateRouterPlanProposal(
  proposal: RouterPlanProposal,
  envelope: TurnEnvelope,
  dependencies: RouterPlanValidationDependencies,
): RouterPlanResult {
  const parsedProposal = routerPlanProposalSchema.safeParse(proposal);
  if (!parsedProposal.success) return { ok: false, reason: 'proposal_invalid_schema' };
  let decisionContext: DecisionContext;
  try {
    decisionContext = createDecisionContext(dependencies.decisionContext);
  } catch {
    return { ok: false, reason: 'decision_context_mismatch' };
  }
  if (!contextMatchesEnvelope(decisionContext, envelope)) {
    return { ok: false, reason: 'decision_context_mismatch' };
  }
  const effectiveText = envelope.effectiveText;
  const createIntentId = dependencies.createIntentId ?? randomUUID;
  const intents: ValidatedExplicitIntent[] = [];
  let previousEndOffset = 0;

  for (let index = 0; index < parsedProposal.data.intents.length; index += 1) {
    const proposedIntent = parsedProposal.data.intents[index];
    if (!proposedIntent) return { ok: false, reason: 'invalid_plan' };
    const resolution = resolveEvidence(
      effectiveText,
      proposedIntent.evidence,
      intentOrdinal(index),
      createIntentId,
    );
    if (!resolution.ok) return resolution;
    if (index > 0 && resolution.evidence.startOffset < previousEndOffset) {
      return { ok: false, reason: 'unordered_evidence' };
    }
    const connector = effectiveText.slice(previousEndOffset, resolution.evidence.startOffset);
    const order = connectorOrder(connector);
    if (order === null) return { ok: false, reason: 'incomplete_evidence' };
    previousEndOffset = resolution.evidence.endOffset;
    const intent = validateProposalIntent(
      proposedIntent,
      resolution.evidence,
      resolution.text,
      index === 0 ? 'independent' : order,
      envelope,
      dependencies.reminderClock,
      decisionContext,
    );
    if (typeof intent === 'string') return { ok: false, reason: intent };
    intents.push(intent);
  }

  if (connectorOrder(effectiveText.slice(previousEndOffset)) === null) {
    return { ok: false, reason: 'incomplete_evidence' };
  }

  try {
    return {
      ok: true,
      plan: createIntentPlan({
        sourceTurnId: envelope.turnId,
        intents,
        privateContext: decisionContext.turn.privateContext,
      }),
    };
  } catch {
    return { ok: false, reason: 'invalid_plan' };
  }
}

/** Parses and validates a router proposal without dispatching any step. */
export function compileRouterPlanProposal(
  output: string,
  envelope: TurnEnvelope,
  dependencies: RouterPlanValidationDependencies,
): RouterPlanResult {
  const parsed = parseRouterPlanProposal(output);
  if (!parsed.ok) return { ok: false, reason: `proposal_${parsed.reason}` };
  return validateRouterPlanProposal(parsed.proposal, envelope, dependencies);
}
