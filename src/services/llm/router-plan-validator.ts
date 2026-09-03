import { randomUUID } from 'node:crypto';
import type { ActionIntent, ActionProvenance } from '../../core/action-intent.js';
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
  | 'invalid_action'
  | 'invalid_plan';

export type RouterPlanResult =
  | { readonly ok: true; readonly plan: IntentPlan }
  | { readonly ok: false; readonly reason: RouterPlanFailure };

export interface RouterPlanValidationDependencies {
  readonly reminderClock: ReminderClock;
  readonly createIntentId?: () => string;
  readonly privateContext?: boolean;
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
    ...inputEvidence,
  };
}

function validateActionProposal(
  proposal: Extract<RouterIntentProposal, { kind: 'action' }>,
  evidence: IntentClauseReference,
  evidenceText: string,
  envelope: TurnEnvelope,
  reminderClock: ReminderClock,
): ActionIntent<ActionName> | RouterPlanFailure {
  if (!isActionName(proposal.action)) return 'unknown_action';
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
): ValidatedExplicitIntent | RouterPlanFailure {
  if (proposal.kind === 'action') {
    const action = validateActionProposal(proposal, evidence, evidenceText, envelope, reminderClock);
    return typeof action === 'string' ? action : { kind: 'action', order, intent: action };
  }
  if (proposal.kind === 'answer') {
    return { kind: 'answer', order, evidence, text: evidenceText };
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
        privateContext: dependencies.privateContext === true || envelope.command.kind === 'anonymous',
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
