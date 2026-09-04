import { createHash, randomUUID } from 'node:crypto';
import {
  isValidActionIntent,
  type ActionIntent,
  type ActionProvenance,
} from './action-intent.js';
import { PROGRAM_ROLES } from './config-schema.js';
import type { TurnId, TurnMode } from './turn-contract.js';
import { ACTION_SCHEMAS } from '../services/actions/action-schemas.js';

export const MAX_EXPLICIT_INTENTS = 3;
export const MAX_PLAN_STEPS = 6;

export type SpecialistCapability = 'coding' | 'research' | 'vision';
export type ExplicitIntentOrder = 'independent' | 'after_previous';

export interface IntentClauseReference {
  readonly intentId: string;
  readonly ordinal: 0 | 1 | 2;
  readonly startOffset: number;
  readonly endOffset: number;
}

export type ValidatedExplicitIntent =
  | {
    readonly kind: 'action';
    readonly order: ExplicitIntentOrder;
    readonly intent: ActionIntent;
  }
  | {
    readonly kind: 'answer';
    readonly order: ExplicitIntentOrder;
    readonly evidence: IntentClauseReference;
    readonly text: string;
  }
  | {
    readonly kind: 'handoff';
    readonly order: ExplicitIntentOrder;
    readonly evidence: IntentClauseReference;
    readonly capability: SpecialistCapability;
    readonly task: string;
  };

interface PlanStepBase {
  readonly stepId: string;
  readonly intentId: string;
  readonly evidence: IntentClauseReference;
  readonly dependsOn: readonly string[];
}

export interface ActionPlanStep extends PlanStepBase {
  readonly kind: 'action';
  readonly intent: ActionIntent;
}

export interface AnswerPlanStep extends PlanStepBase {
  readonly kind: 'answer';
  readonly text: string;
}

export interface HandoffConfirmationPlanStep extends PlanStepBase {
  readonly kind: 'handoff_confirmation';
  readonly capability: SpecialistCapability;
  readonly task: string;
}

export interface SpecialistHandoffPlanStep extends PlanStepBase {
  readonly kind: 'specialist_handoff';
  readonly capability: SpecialistCapability;
  readonly task: string;
}

export type IntentPlanStep =
  | ActionPlanStep
  | AnswerPlanStep
  | HandoffConfirmationPlanStep
  | SpecialistHandoffPlanStep;

export interface IntentPlan {
  readonly planId: string;
  readonly revision: number;
  readonly sourceTurnId: TurnId;
  readonly privateContext: boolean;
  readonly originMode: TurnMode;
  readonly steps: readonly IntentPlanStep[];
  readonly fingerprint: string;
}

export interface CreateIntentPlanInput {
  readonly sourceTurnId: TurnId;
  readonly intents: readonly ValidatedExplicitIntent[];
  readonly revision?: number;
  readonly privateContext?: boolean;
  readonly originMode?: TurnMode;
}

const SPECIALIST_CAPABILITIES: ReadonlySet<string> = new Set([
  'coding',
  'research',
  'vision',
]);
const PROGRAM_ROLE_SET: ReadonlySet<string> = new Set(PROGRAM_ROLES);

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function isSpecialistCapability(value: string): value is SpecialistCapability {
  return SPECIALIST_CAPABILITIES.has(value);
}

function copyEvidence(evidence: IntentClauseReference): IntentClauseReference {
  return Object.freeze({
    intentId: evidence.intentId,
    ordinal: evidence.ordinal,
    startOffset: evidence.startOffset,
    endOffset: evidence.endOffset,
  });
}

function isValidEvidence(evidence: IntentClauseReference): boolean {
  return isNonEmpty(evidence.intentId)
    && Number.isSafeInteger(evidence.ordinal)
    && evidence.ordinal >= 0
    && evidence.ordinal < MAX_EXPLICIT_INTENTS
    && Number.isSafeInteger(evidence.startOffset)
    && Number.isSafeInteger(evidence.endOffset)
    && evidence.startOffset >= 0
    && evidence.endOffset > evidence.startOffset;
}

function evidenceMatches(
  left: IntentClauseReference,
  right: IntentClauseReference,
): boolean {
  return left.intentId === right.intentId
    && left.ordinal === right.ordinal
    && left.startOffset === right.startOffset
    && left.endOffset === right.endOffset;
}

function copyProvenance(provenance: ActionProvenance): ActionProvenance {
  const evidenceScope = provenance.evidenceScope.kind === 'clause'
    ? Object.freeze({
      kind: provenance.evidenceScope.kind,
      intentId: provenance.evidenceScope.intentId,
      ordinal: provenance.evidenceScope.ordinal,
      startOffset: provenance.evidenceScope.startOffset,
      endOffset: provenance.evidenceScope.endOffset,
    })
    : Object.freeze({ kind: provenance.evidenceScope.kind });
  const interactionContext = provenance.interactionContext
    ? Object.freeze({
      kind: provenance.interactionContext.kind,
      contextTurnId: provenance.interactionContext.contextTurnId,
    })
    : undefined;
  const parameterResolution = provenance.parameterResolution
    ? Object.freeze({
      kind: provenance.parameterResolution.kind,
      role: provenance.parameterResolution.role,
      programName: provenance.parameterResolution.programName,
    })
    : undefined;
  const base = {
    sourceTurnId: provenance.sourceTurnId,
    decisionSource: provenance.decisionSource,
    validation: provenance.validation,
    evidenceScope,
    ...(interactionContext ? { interactionContext } : {}),
    ...(parameterResolution ? { parameterResolution } : {}),
  } as const;
  return Object.freeze(provenance.evidenceSource === 'custom_command_expansion'
    ? {
      ...base,
      evidenceSource: provenance.evidenceSource,
      customCommand: provenance.customCommand,
    }
    : { ...base, evidenceSource: provenance.evidenceSource });
}

function copyActionIntent(intent: ActionIntent): ActionIntent {
  return Object.freeze({
    action: intent.action,
    param: intent.param,
    provenance: copyProvenance(intent.provenance),
  });
}

function freezeStep(step: IntentPlanStep): IntentPlanStep {
  const dependsOn = Object.freeze([...step.dependsOn]);
  const evidence = copyEvidence(step.evidence);
  if (step.kind === 'action') {
    return Object.freeze({
      ...step,
      dependsOn,
      evidence,
      intent: copyActionIntent(step.intent),
    });
  }
  return Object.freeze({ ...step, dependsOn, evidence });
}

function canonicalProvenance(provenance: ActionProvenance): object {
  return {
    sourceTurnId: provenance.sourceTurnId,
    decisionSource: provenance.decisionSource,
    validation: provenance.validation,
    evidenceScope: provenance.evidenceScope.kind === 'clause'
      ? {
        kind: provenance.evidenceScope.kind,
        intentId: provenance.evidenceScope.intentId,
        ordinal: provenance.evidenceScope.ordinal,
        startOffset: provenance.evidenceScope.startOffset,
        endOffset: provenance.evidenceScope.endOffset,
      }
      : { kind: provenance.evidenceScope.kind },
    evidenceSource: provenance.evidenceSource,
    ...(provenance.evidenceSource === 'custom_command_expansion'
      ? { customCommand: provenance.customCommand }
      : {}),
    ...(provenance.interactionContext ? {
      interactionContext: {
        kind: provenance.interactionContext.kind,
        contextTurnId: provenance.interactionContext.contextTurnId,
      },
    } : {}),
    ...(provenance.parameterResolution ? {
      parameterResolution: {
        kind: provenance.parameterResolution.kind,
        role: provenance.parameterResolution.role,
        programName: provenance.parameterResolution.programName,
      },
    } : {}),
  };
}

function canonicalStep(step: IntentPlanStep): object {
  const base = {
    stepId: step.stepId,
    intentId: step.intentId,
    kind: step.kind,
    evidence: {
      intentId: step.evidence.intentId,
      ordinal: step.evidence.ordinal,
      startOffset: step.evidence.startOffset,
      endOffset: step.evidence.endOffset,
    },
    dependsOn: [...step.dependsOn].sort(),
  };
  if (step.kind === 'action') {
    return {
      ...base,
      action: step.intent.action,
      param: step.intent.param,
      provenance: canonicalProvenance(step.intent.provenance),
    };
  }
  if (step.kind === 'answer') return { ...base, text: step.text };
  return {
    ...base,
    capability: step.capability,
    task: step.task,
  };
}

function fingerprintPlan(
  planId: string,
  revision: number,
  sourceTurnId: TurnId,
  privateContext: boolean,
  originMode: TurnMode,
  steps: readonly IntentPlanStep[],
): string {
  const canonical = JSON.stringify({
    planId,
    revision,
    sourceTurnId,
    privateContext,
    originMode,
    steps: steps.map(canonicalStep),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function hasValidActionIntent(intent: ActionIntent, sourceTurnId: TurnId): boolean {
  if (!isValidActionIntent(intent) || intent.provenance.sourceTurnId !== sourceTurnId) return false;
  const parsedParam = ACTION_SCHEMAS[intent.action].safeParse(intent.param);
  if (!parsedParam.success || String(parsedParam.data) !== intent.param) return false;
  if (intent.provenance.validation !== 'semantic_grounding') return false;
  if (intent.provenance.evidenceScope.kind !== 'clause') return false;
  if (!isValidEvidence(intent.provenance.evidenceScope)) return false;
  if (intent.provenance.evidenceSource === 'custom_command_expansion'
    && !isNonEmpty(intent.provenance.customCommand)) return false;
  if (intent.provenance.interactionContext
    && (!isNonEmpty(intent.provenance.interactionContext.contextTurnId)
      || !isNonEmpty(intent.provenance.interactionContext.kind))) return false;
  if (intent.provenance.parameterResolution && (
    intent.action !== 'open_program'
    || intent.provenance.parameterResolution.programName.length > 100
    || intent.provenance.parameterResolution.kind !== 'program_role'
    || !PROGRAM_ROLE_SET.has(intent.provenance.parameterResolution.role)
    || !isNonEmpty(intent.provenance.parameterResolution.programName)
    || intent.param !== intent.provenance.parameterResolution.programName
  )) return false;
  if (
    intent.action === 'open_program'
    && !intent.provenance.parameterResolution
    && /^role:/u.test(intent.param)
  ) return false;
  return true;
}

function validateDependencies(steps: readonly IntentPlanStep[]): boolean {
  const stepIds = new Set(steps.map((step) => step.stepId));
  if (stepIds.size !== steps.length) return false;
  if (steps.some((step) => (
    !isNonEmpty(step.stepId)
    || !isNonEmpty(step.intentId)
    || step.intentId !== step.evidence.intentId
    || !isValidEvidence(step.evidence)
    || new Set(step.dependsOn).size !== step.dependsOn.length
    || step.dependsOn.some((dependency) => dependency === step.stepId || !stepIds.has(dependency))
  ))) return false;

  const completed = new Set<string>();
  let progressed = true;
  while (progressed && completed.size < steps.length) {
    progressed = false;
    for (const step of steps) {
      if (completed.has(step.stepId)) continue;
      if (step.dependsOn.every((dependency) => completed.has(dependency))) {
        completed.add(step.stepId);
        progressed = true;
      }
    }
  }
  return completed.size === steps.length;
}

function validateIntentGroups(steps: readonly IntentPlanStep[], sourceTurnId: TurnId): boolean {
  const byIntent = new Map<string, IntentPlanStep[]>();
  for (const step of steps) {
    const group = byIntent.get(step.intentId) ?? [];
    group.push(step);
    byIntent.set(step.intentId, group);
  }
  if (byIntent.size < 1 || byIntent.size > MAX_EXPLICIT_INTENTS) return false;

  const orderedEvidence = [...byIntent.values()].map((group) => group[0]?.evidence);
  if (orderedEvidence.some((evidence) => evidence === undefined)) return false;
  for (let index = 0; index < orderedEvidence.length; index += 1) {
    const evidence = orderedEvidence[index];
    const previous = orderedEvidence[index - 1];
    if (!evidence || evidence.ordinal !== index) return false;
    if (previous && evidence.startOffset < previous.endOffset) return false;
  }

  let previousTerminalStepId: string | null = null;
  for (const group of byIntent.values()) {
    const [first] = group;
    if (!first) return false;
    if (group.some((step) => (
      !evidenceMatches(step.evidence, first.evidence)
    ))) return false;
    const externalDependencies = first.dependsOn.filter(
      (dependency) => !group.some((step) => step.stepId === dependency),
    );
    if (
      externalDependencies.length > 1
      || (externalDependencies.length === 1 && externalDependencies[0] !== previousTerminalStepId)
    ) return false;
    if (first.kind === 'action') {
      if (
        group.length !== 1
        || !hasValidActionIntent(first.intent, sourceTurnId)
        || first.intent.provenance.evidenceScope.kind !== 'clause'
        || !evidenceMatches(first.evidence, first.intent.provenance.evidenceScope)
      ) return false;
      previousTerminalStepId = first.stepId;
      continue;
    }
    if (first.kind === 'answer') {
      if (group.length !== 1 || !isNonEmpty(first.text)) return false;
      previousTerminalStepId = first.stepId;
      continue;
    }
    if (group.length !== 2) return false;
    const confirmation = group.find(
      (step): step is HandoffConfirmationPlanStep => step.kind === 'handoff_confirmation',
    );
    const handoff = group.find(
      (step): step is SpecialistHandoffPlanStep => step.kind === 'specialist_handoff',
    );
    if (!confirmation || !handoff) return false;
    if (
      !isSpecialistCapability(confirmation.capability)
      || confirmation.capability !== handoff.capability
      || !isNonEmpty(confirmation.task)
      || confirmation.task !== handoff.task
      || handoff.dependsOn.length !== 1
      || handoff.dependsOn[0] !== confirmation.stepId
    ) return false;
    previousTerminalStepId = handoff.stepId;
  }
  return true;
}

function isDeeplyFrozenPlan(plan: IntentPlan): boolean {
  if (!Object.isFrozen(plan) || !Object.isFrozen(plan.steps)) return false;
  return plan.steps.every((step) => {
    if (!Object.isFrozen(step) || !Object.isFrozen(step.dependsOn) || !Object.isFrozen(step.evidence)) {
      return false;
    }
    if (step.kind !== 'action') return true;
    return Object.isFrozen(step.intent)
      && Object.isFrozen(step.intent.provenance)
      && Object.isFrozen(step.intent.provenance.evidenceScope)
      && (!step.intent.provenance.interactionContext
        || Object.isFrozen(step.intent.provenance.interactionContext))
      && (!step.intent.provenance.parameterResolution
        || Object.isFrozen(step.intent.provenance.parameterResolution));
  });
}

/**
 * Builds an immutable plan from already validated explicit intents.
 *
 * - Retains app-owned clause intent IDs and generates plan and step IDs.
 * - Expands every specialist handoff into confirmation then handoff.
 * - Rejects invalid sizes or source-turn provenance before returning a plan.
 *
 * @returns Frozen plan with a SHA-256 integrity fingerprint.
 *
 * @category Business Logic Validation
 */
export function createIntentPlan(input: CreateIntentPlanInput): IntentPlan {
  const revision = input.revision ?? 1;
  if (!isNonEmpty(input.sourceTurnId)) throw new Error('Intent plan requires a source turn');
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Intent plan revision must be a positive safe integer');
  }
  if (input.intents.length < 1 || input.intents.length > MAX_EXPLICIT_INTENTS) {
    throw new Error(`Intent plan requires 1..${MAX_EXPLICIT_INTENTS} explicit intents`);
  }

  const explicitEvidence = input.intents.map((explicit): IntentClauseReference => {
    if (explicit.kind !== 'action') return explicit.evidence;
    if (explicit.intent.provenance.evidenceScope.kind !== 'clause') {
      throw new Error('Action intent requires clause evidence');
    }
    return explicit.intent.provenance.evidenceScope;
  });
  const intentIds = new Set<string>();
  for (let index = 0; index < explicitEvidence.length; index += 1) {
    const evidence = explicitEvidence[index];
    const previous = explicitEvidence[index - 1];
    if (!evidence || !isValidEvidence(evidence) || evidence.ordinal !== index) {
      throw new Error('Intent clause evidence is invalid or out of order');
    }
    if (intentIds.has(evidence.intentId)) throw new Error('Intent clause IDs must be unique');
    if (previous && evidence.startOffset < previous.endOffset) {
      throw new Error('Intent clause evidence must not overlap');
    }
    intentIds.add(evidence.intentId);
  }

  const steps: IntentPlanStep[] = [];
  let previousTerminalStepId: string | null = null;
  for (let index = 0; index < input.intents.length; index += 1) {
    const explicit = input.intents[index];
    const sourceEvidence = explicitEvidence[index];
    if (!explicit || !sourceEvidence) throw new Error('Intent plan evidence is incomplete');
    const evidence = copyEvidence(sourceEvidence);
    const intentId = evidence.intentId;
    if (explicit.order !== 'independent' && explicit.order !== 'after_previous') {
      throw new Error('Intent order is invalid');
    }
    if (index === 0 && explicit.order !== 'independent') {
      throw new Error('The first intent cannot depend on a previous intent');
    }
    const explicitDependencies = explicit.order === 'after_previous'
      ? previousTerminalStepId ? [previousTerminalStepId] : []
      : [];
    if (explicit.kind === 'action') {
      if (!hasValidActionIntent(explicit.intent, input.sourceTurnId)) {
        throw new Error('Action intent is not validated for the source turn');
      }
      steps.push({
        stepId: randomUUID(),
        intentId,
        kind: 'action',
        evidence,
        dependsOn: explicitDependencies,
        intent: copyActionIntent(explicit.intent),
      });
      previousTerminalStepId = steps[steps.length - 1]?.stepId ?? null;
      continue;
    }
    if (explicit.kind === 'answer') {
      if (!isNonEmpty(explicit.text)) throw new Error('Answer intent requires text');
      steps.push({
        stepId: randomUUID(),
        intentId,
        kind: 'answer',
        evidence,
        dependsOn: explicitDependencies,
        text: explicit.text,
      });
      previousTerminalStepId = steps[steps.length - 1]?.stepId ?? null;
      continue;
    }
    if (!isSpecialistCapability(explicit.capability) || !isNonEmpty(explicit.task)) {
      throw new Error('Handoff intent requires a supported capability and task');
    }
    const confirmationStepId = randomUUID();
    steps.push({
      stepId: confirmationStepId,
      intentId,
      kind: 'handoff_confirmation',
      evidence,
      dependsOn: explicitDependencies,
      capability: explicit.capability,
      task: explicit.task,
    }, {
      stepId: randomUUID(),
      intentId,
      kind: 'specialist_handoff',
      evidence,
      dependsOn: [confirmationStepId],
      capability: explicit.capability,
      task: explicit.task,
    });
    previousTerminalStepId = steps[steps.length - 1]?.stepId ?? null;
  }
  if (steps.length < 1 || steps.length > MAX_PLAN_STEPS) {
    throw new Error(`Intent plan requires 1..${MAX_PLAN_STEPS} derived steps`);
  }

  const planId = randomUUID();
  const privateContext = input.privateContext ?? false;
  const originMode = input.originMode ?? 'chat';
  if (originMode !== 'chat' && originMode !== 'voice') {
    throw new Error('Intent plan origin mode is unsupported');
  }
  const frozenSteps = Object.freeze(steps.map(freezeStep));
  const fingerprint = fingerprintPlan(
    planId,
    revision,
    input.sourceTurnId,
    privateContext,
    originMode,
    frozenSteps,
  );
  const plan = Object.freeze({
    planId,
    revision,
    sourceTurnId: input.sourceTurnId,
    privateContext,
    originMode,
    steps: frozenSteps,
    fingerprint,
  });
  if (!validateIntentPlan(plan)) throw new Error('Application produced an invalid intent plan');
  return plan;
}

/** Validates plan bounds, graph integrity, handoff confirmation, and fingerprint. */
export function validateIntentPlan(plan: IntentPlan): boolean {
  if (
    !isDeeplyFrozenPlan(plan)
    || !isNonEmpty(plan.planId)
    || !isNonEmpty(plan.sourceTurnId)
    || !Number.isSafeInteger(plan.revision)
    || plan.revision < 1
    || typeof plan.privateContext !== 'boolean'
    || (plan.originMode !== 'chat' && plan.originMode !== 'voice')
    || plan.steps.length < 1
    || plan.steps.length > MAX_PLAN_STEPS
    || !/^[a-f0-9]{64}$/u.test(plan.fingerprint)
  ) return false;
  if (!validateDependencies(plan.steps) || !validateIntentGroups(plan.steps, plan.sourceTurnId)) {
    return false;
  }
  return plan.fingerprint === fingerprintPlan(
    plan.planId,
    plan.revision,
    plan.sourceTurnId,
    plan.privateContext,
    plan.originMode,
    plan.steps,
  );
}
