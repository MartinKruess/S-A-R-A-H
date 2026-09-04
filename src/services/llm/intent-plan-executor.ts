import { validateIntentPlan, type IntentPlan, type IntentPlanStep } from '../../core/intent-plan.js';
import {
  applyPlanStepOutcome,
  cancelPlanExecution,
  createPlanExecutionState,
  getReadyPlanStepIds,
  startPlanSteps,
  type PlanCancellationReason,
  type PlanExecutionState,
  type PlanStepReportedFailureReason,
} from '../../core/plan-execution-state.js';

export type IntentPlanAdapterResult =
  | { readonly status: 'succeeded' }
  | {
    readonly status: 'failed';
    readonly reason: PlanStepReportedFailureReason;
  };

export interface IntentPlanExecutionContext {
  readonly planId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly sourceTurnId: string;
  readonly privateContext: boolean;
  readonly originMode: IntentPlan['originMode'];
}

type StepOfKind<Kind extends IntentPlanStep['kind']> = Extract<IntentPlanStep, { kind: Kind }>;

export interface IntentPlanExecutorAdapters {
  executeAction(
    step: StepOfKind<'action'>,
    context: IntentPlanExecutionContext,
    signal?: AbortSignal,
  ): Promise<IntentPlanAdapterResult>;
  executeAnswer(
    step: StepOfKind<'answer'>,
    context: IntentPlanExecutionContext,
    signal?: AbortSignal,
  ): Promise<IntentPlanAdapterResult>;
  requestHandoffConfirmation(
    step: StepOfKind<'handoff_confirmation'>,
    context: IntentPlanExecutionContext,
    signal?: AbortSignal,
  ): Promise<IntentPlanAdapterResult>;
  executeSpecialistHandoff(
    step: StepOfKind<'specialist_handoff'>,
    context: IntentPlanExecutionContext,
    signal?: AbortSignal,
  ): Promise<IntentPlanAdapterResult>;
}

function executionContext(plan: IntentPlan): IntentPlanExecutionContext {
  return Object.freeze({
    planId: plan.planId,
    revision: plan.revision,
    fingerprint: plan.fingerprint,
    sourceTurnId: plan.sourceTurnId,
    privateContext: plan.privateContext,
    originMode: plan.originMode,
  });
}

/** Executes an already trusted IntentPlan through narrow, injected step adapters. */
export class IntentPlanExecutor {
  constructor(private readonly adapters: IntentPlanExecutorAdapters) {}

  /**
   * Executes ready steps one at a time in their immutable plan order.
   *
   * - Revalidates the plan before start and before every step.
   * - Feeds only structured adapter outcomes into the immutable evaluator state.
   * - Never retries or replans; cancellation marks all unfinished work canceled.
   *
   * @returns Final immutable execution state.
   *
   * @category Service Business Logic
   */
  async execute(
    plan: IntentPlan,
    signal?: AbortSignal,
    cancellationReason: PlanCancellationReason = 'turn_canceled',
  ): Promise<PlanExecutionState> {
    if (!validateIntentPlan(plan)) throw new Error('Intent plan is invalid');
    let state = createPlanExecutionState(plan);
    const context = executionContext(plan);

    while (state.status === 'running') {
      if (signal?.aborted) return cancelPlanExecution(plan, state, cancellationReason);
      if (!validateIntentPlan(plan)) {
        throw new Error('Intent plan became invalid');
      }

      const readyStepIds = getReadyPlanStepIds(plan, state);
      const nextStep = plan.steps.find((step) => readyStepIds.includes(step.stepId));
      if (!nextStep) {
        throw new Error('Plan execution cannot make progress');
      }

      state = startPlanSteps(plan, state, [nextStep.stepId]);
      try {
        const result = await this.executeStep(nextStep, context, signal);
        state = applyPlanStepOutcome(plan, state, result.status === 'succeeded'
          ? { stepId: nextStep.stepId, status: 'succeeded' }
          : {
            stepId: nextStep.stepId,
            status: 'failed',
            reason: result.reason,
          });
        if (signal?.aborted && state.status === 'running') {
          return cancelPlanExecution(plan, state, cancellationReason);
        }
      } catch (error) {
        if (signal?.aborted) {
          return cancelPlanExecution(plan, state, cancellationReason);
        }
        state = applyPlanStepOutcome(plan, state, {
          stepId: nextStep.stepId,
          status: 'failed',
          reason: error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout'
            : 'executor_error',
        });
      }
    }

    return state;
  }

  private executeStep(
    step: IntentPlanStep,
    context: IntentPlanExecutionContext,
    signal?: AbortSignal,
  ): Promise<IntentPlanAdapterResult> {
    switch (step.kind) {
      case 'action':
        return this.adapters.executeAction(step, context, signal);
      case 'answer':
        return this.adapters.executeAnswer(step, context, signal);
      case 'handoff_confirmation':
        return this.adapters.requestHandoffConfirmation(step, context, signal);
      case 'specialist_handoff':
        return this.adapters.executeSpecialistHandoff(step, context, signal);
    }
  }
}
