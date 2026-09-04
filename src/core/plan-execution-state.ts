import {
  MAX_EXPLICIT_INTENTS,
  type IntentPlan,
  validateIntentPlan,
} from './intent-plan.js';
import type { TurnId } from './turn-contract.js';

export type PlanStepExecutionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'canceled';

export type PlanExecutionStatus =
  | 'running'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'canceled';

export type PlanStepReportedFailureReason =
  | 'action_failed'
  | 'answer_failed'
  | 'confirmation_failed'
  | 'handoff_failed'
  | 'timeout'
  | 'executor_error';

export type PlanStepFailureReason = PlanStepReportedFailureReason | 'dependency_failed';

export type PlanCancellationReason =
  | 'user_canceled'
  | 'turn_canceled'
  | 'lifecycle_stopping'
  | 'superseded';

export interface PlanStepExecutionState {
  readonly stepId: string;
  readonly status: PlanStepExecutionStatus;
  readonly attempts: 0 | 1;
  readonly failureReason?: PlanStepFailureReason;
}

export interface PlanExecutionState {
  readonly planId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly sourceTurnId: TurnId;
  readonly status: PlanExecutionStatus;
  readonly steps: readonly PlanStepExecutionState[];
  readonly cancellationReason?: PlanCancellationReason;
}

export type PlanStepOutcome =
  | {
    readonly stepId: string;
    readonly status: 'succeeded';
  }
  | {
    readonly stepId: string;
    readonly status: 'failed';
    readonly reason: PlanStepReportedFailureReason;
  };

export const MAX_CONCURRENT_PLAN_STEPS = MAX_EXPLICIT_INTENTS;

const STEP_STATUSES: ReadonlySet<PlanStepExecutionStatus> = new Set([
  'pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled',
]);
const PLAN_STATUSES: ReadonlySet<PlanExecutionStatus> = new Set([
  'running', 'completed', 'partially_completed', 'failed', 'canceled',
]);
const REPORTED_FAILURE_REASONS: ReadonlySet<PlanStepReportedFailureReason> = new Set([
  'action_failed', 'answer_failed', 'confirmation_failed', 'handoff_failed', 'timeout', 'executor_error',
]);
const CANCELLATION_REASONS: ReadonlySet<PlanCancellationReason> = new Set([
  'user_canceled', 'turn_canceled', 'lifecycle_stopping', 'superseded',
]);

function freezeStep(step: PlanStepExecutionState): PlanStepExecutionState {
  return Object.freeze({
    stepId: step.stepId,
    status: step.status,
    attempts: step.attempts,
    ...(step.failureReason ? { failureReason: step.failureReason } : {}),
  });
}

function createState(
  plan: IntentPlan,
  steps: readonly PlanStepExecutionState[],
  status: PlanExecutionStatus,
  cancellationReason?: PlanCancellationReason,
): PlanExecutionState {
  return Object.freeze({
    planId: plan.planId,
    revision: plan.revision,
    fingerprint: plan.fingerprint,
    sourceTurnId: plan.sourceTurnId,
    status,
    steps: Object.freeze(steps.map(freezeStep)),
    ...(cancellationReason ? { cancellationReason } : {}),
  });
}

function assertStateMatchesPlan(plan: IntentPlan, state: PlanExecutionState): void {
  if (!validateIntentPlan(plan)) throw new Error('Plan execution requires a valid intent plan');
  if (
    !Object.isFrozen(state)
    || !Object.isFrozen(state.steps)
    || state.planId !== plan.planId
    || state.revision !== plan.revision
    || state.fingerprint !== plan.fingerprint
    || state.sourceTurnId !== plan.sourceTurnId
    || state.steps.length !== plan.steps.length
    || state.steps.some((step, index) => step.stepId !== plan.steps[index]?.stepId)
    || !isValidPlanExecutionState(state)
  ) {
    throw new Error('Plan execution state does not match the intent plan');
  }
}

function deriveStatus(steps: readonly PlanStepExecutionState[]): PlanExecutionStatus {
  if (steps.some((step) => step.status === 'pending' || step.status === 'running')) {
    return 'running';
  }
  const succeeded = steps.filter((step) => step.status === 'succeeded').length;
  if (succeeded === steps.length) return 'completed';
  return succeeded > 0 ? 'partially_completed' : 'failed';
}

/** Validates the immutable state shape and its single-attempt invariants. */
export function isValidPlanExecutionState(state: PlanExecutionState): boolean {
  if (
    !Object.isFrozen(state)
    || !Object.isFrozen(state.steps)
    || !PLAN_STATUSES.has(state.status)
    || state.steps.length < 1
    || state.steps.some((step) => !Object.isFrozen(step) || !STEP_STATUSES.has(step.status))
  ) return false;

  const stepIds = new Set(state.steps.map((step) => step.stepId));
  if (stepIds.size !== state.steps.length || state.steps.some((step) => !step.stepId.trim())) return false;
  for (const step of state.steps) {
    if (step.attempts !== 0 && step.attempts !== 1) return false;
    if ((step.status === 'pending' || step.status === 'skipped') && step.attempts !== 0) return false;
    if ((step.status === 'running' || step.status === 'succeeded' || step.status === 'failed')
      && step.attempts !== 1) return false;
    if (step.status === 'failed') {
      const reason = step.failureReason;
      if (!reason || reason === 'dependency_failed' || !REPORTED_FAILURE_REASONS.has(reason)) return false;
    }
    if (step.status === 'skipped' && step.failureReason !== 'dependency_failed') return false;
    if (step.status !== 'failed' && step.status !== 'skipped' && step.failureReason) return false;
  }

  if (state.status === 'canceled') {
    return state.cancellationReason !== undefined
      && CANCELLATION_REASONS.has(state.cancellationReason)
      && state.steps.every((step) => step.status !== 'pending' && step.status !== 'running');
  }
  return state.cancellationReason === undefined && state.status === deriveStatus(state.steps);
}

function skipFailedDependents(
  plan: IntentPlan,
  steps: readonly PlanStepExecutionState[],
): readonly PlanStepExecutionState[] {
  const next = steps.map((step) => ({ ...step }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < plan.steps.length; index += 1) {
      const planStep = plan.steps[index];
      const executionStep = next[index];
      if (!planStep || !executionStep || executionStep.status !== 'pending') continue;
      const blocked = planStep.dependsOn.some((dependencyId) => {
        const dependency = next.find((candidate) => candidate.stepId === dependencyId);
        return dependency?.status === 'failed'
          || dependency?.status === 'skipped'
          || dependency?.status === 'canceled';
      });
      if (!blocked) continue;
      next[index] = {
        stepId: executionStep.stepId,
        status: 'skipped',
        attempts: 0,
        failureReason: 'dependency_failed',
      };
      changed = true;
    }
  }
  return next;
}

/** Creates the immutable runtime state for one already validated intent plan. */
export function createPlanExecutionState(plan: IntentPlan): PlanExecutionState {
  if (!validateIntentPlan(plan)) throw new Error('Plan execution requires a valid intent plan');
  return createState(
    plan,
    plan.steps.map((step) => ({
      stepId: step.stepId,
      status: 'pending',
      attempts: 0,
    })),
    'running',
  );
}

/** Returns pending steps whose dependencies all succeeded, in stable plan order. */
export function getReadyPlanStepIds(
  plan: IntentPlan,
  state: PlanExecutionState,
): readonly string[] {
  assertStateMatchesPlan(plan, state);
  if (state.status !== 'running') return Object.freeze([]);
  const runningCount = state.steps.filter((step) => step.status === 'running').length;
  const availableSlots = Math.max(0, MAX_CONCURRENT_PLAN_STEPS - runningCount);
  const byId = new Map(state.steps.map((step) => [step.stepId, step]));
  return Object.freeze(plan.steps
    .filter((step, index) => (
      state.steps[index]?.status === 'pending'
      && step.dependsOn.every((dependencyId) => byId.get(dependencyId)?.status === 'succeeded')
    ))
    .slice(0, availableSlots)
    .map((step) => step.stepId));
}

/** Starts a bounded set of currently ready steps and consumes their single attempt. */
export function startPlanSteps(
  plan: IntentPlan,
  state: PlanExecutionState,
  stepIds: readonly string[],
): PlanExecutionState {
  assertStateMatchesPlan(plan, state);
  if (state.status !== 'running') throw new Error('A terminal plan cannot start steps');
  if (stepIds.length < 1 || new Set(stepIds).size !== stepIds.length) {
    throw new Error('Plan execution requires unique step IDs');
  }
  const ready = new Set(getReadyPlanStepIds(plan, state));
  if (stepIds.some((stepId) => !ready.has(stepId))) {
    throw new Error('Plan execution can start only ready steps');
  }
  const selected = new Set(stepIds);
  const steps = state.steps.map((step): PlanStepExecutionState => (
    selected.has(step.stepId)
      ? { stepId: step.stepId, status: 'running', attempts: 1 }
      : step
  ));
  return createState(plan, steps, 'running');
}

/** Applies one correlated terminal result without retrying or changing the plan. */
export function applyPlanStepOutcome(
  plan: IntentPlan,
  state: PlanExecutionState,
  outcome: PlanStepOutcome,
): PlanExecutionState {
  assertStateMatchesPlan(plan, state);
  if (state.status !== 'running') throw new Error('A terminal plan cannot accept step results');
  const index = state.steps.findIndex((step) => step.stepId === outcome.stepId);
  const current = state.steps[index];
  if (!current || current.status !== 'running' || current.attempts !== 1) {
    throw new Error('Plan execution result does not match one running step');
  }
  const updated = state.steps.map((step, stepIndex): PlanStepExecutionState => {
    if (stepIndex !== index) return step;
    return outcome.status === 'succeeded'
      ? { stepId: step.stepId, status: 'succeeded', attempts: 1 }
      : {
        stepId: step.stepId,
        status: 'failed',
        attempts: 1,
        failureReason: outcome.reason,
      };
  });
  const steps = outcome.status === 'failed'
    ? skipFailedDependents(plan, updated)
    : updated;
  return createState(plan, steps, deriveStatus(steps));
}

/** Cancels all unfinished steps; successful side effects remain successful. */
export function cancelPlanExecution(
  plan: IntentPlan,
  state: PlanExecutionState,
  reason: PlanCancellationReason,
): PlanExecutionState {
  assertStateMatchesPlan(plan, state);
  if (state.status === 'canceled') return state;
  if (state.status !== 'running') throw new Error('A completed plan cannot be canceled');
  const steps = state.steps.map((step): PlanStepExecutionState => (
    step.status === 'succeeded' || step.status === 'failed' || step.status === 'skipped'
      ? step
      : { stepId: step.stepId, status: 'canceled', attempts: step.attempts }
  ));
  return createState(plan, steps, 'canceled', reason);
}
