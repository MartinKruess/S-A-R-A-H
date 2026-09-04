import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '../../src/core/action-intent.js';
import {
  applyPlanStepOutcome,
  cancelPlanExecution,
  createPlanExecutionState,
  getReadyPlanStepIds,
  startPlanSteps,
} from '../../src/core/plan-execution-state.js';
import {
  createIntentPlan,
  type ExplicitIntentOrder,
  type IntentClauseReference,
  type IntentPlan,
  type ValidatedExplicitIntent,
} from '../../src/core/intent-plan.js';

const TURN_ID = '11111111-1111-4111-8111-111111111111';

function evidence(ordinal: 0 | 1 | 2): IntentClauseReference {
  return {
    intentId: `intent-${ordinal}`,
    ordinal,
    startOffset: ordinal * 10,
    endOffset: ordinal * 10 + 5,
  };
}

function actionIntent(
  ordinal: 0 | 1 | 2,
  order: ExplicitIntentOrder,
): ValidatedExplicitIntent {
  const scope = evidence(ordinal);
  const intent: ActionIntent<'set_timer'> = {
    action: 'set_timer',
    param: '10m',
    provenance: {
      sourceTurnId: TURN_ID,
      decisionSource: 'router_model',
      validation: 'semantic_grounding',
      evidenceScope: { kind: 'clause', ...scope },
      evidenceSource: 'user_text',
    },
  };
  return { kind: 'action', order, intent };
}

function plan(orders: readonly ExplicitIntentOrder[]): IntentPlan {
  return createIntentPlan({
    sourceTurnId: TURN_ID,
    intents: orders.map((order, index) => actionIntent(index as 0 | 1 | 2, order)),
  });
}

describe('plan execution state', () => {
  it('binds an immutable initial state to the exact plan snapshot', () => {
    const source = plan(['independent', 'independent']);
    const state = createPlanExecutionState(source);

    expect(state).toMatchObject({
      planId: source.planId,
      revision: source.revision,
      fingerprint: source.fingerprint,
      sourceTurnId: source.sourceTurnId,
      status: 'running',
    });
    expect(state.steps.map((step) => step.stepId)).toEqual(source.steps.map((step) => step.stepId));
    expect(state.steps.every((step) => step.status === 'pending' && step.attempts === 0)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.steps)).toBe(true);
    expect(state.steps.every(Object.isFrozen)).toBe(true);
  });

  it('returns independent ready steps in stable plan order', () => {
    const source = plan(['independent', 'independent', 'independent']);
    const state = createPlanExecutionState(source);

    expect(getReadyPlanStepIds(source, state)).toEqual(source.steps.map((step) => step.stepId));
  });

  it('unlocks an after-previous step only after its dependency succeeded', () => {
    const source = plan(['independent', 'after_previous']);
    let state = createPlanExecutionState(source);
    const firstId = source.steps[0]!.stepId;
    const secondId = source.steps[1]!.stepId;

    expect(getReadyPlanStepIds(source, state)).toEqual([firstId]);
    state = startPlanSteps(source, state, [firstId]);
    expect(getReadyPlanStepIds(source, state)).toEqual([]);
    state = applyPlanStepOutcome(source, state, { stepId: firstId, status: 'succeeded' });
    expect(getReadyPlanStepIds(source, state)).toEqual([secondId]);
  });

  it('skips transitive failed dependencies while preserving an independent branch', () => {
    const source = plan(['independent', 'after_previous', 'independent']);
    let state = createPlanExecutionState(source);
    const firstId = source.steps[0]!.stepId;
    const secondId = source.steps[1]!.stepId;
    const independentId = source.steps[2]!.stepId;

    state = startPlanSteps(source, state, [firstId, independentId]);
    state = applyPlanStepOutcome(source, state, {
      stepId: firstId,
      status: 'failed',
      reason: 'action_failed',
    });

    expect(state.steps.find((step) => step.stepId === secondId)).toMatchObject({
      status: 'skipped',
      attempts: 0,
      failureReason: 'dependency_failed',
    });
    expect(state.steps.find((step) => step.stepId === independentId)?.status).toBe('running');
    state = applyPlanStepOutcome(source, state, { stepId: independentId, status: 'succeeded' });
    expect(state.status).toBe('partially_completed');
  });

  it('completes only after every step succeeded', () => {
    const source = plan(['independent', 'independent']);
    let state = createPlanExecutionState(source);
    const ids = source.steps.map((step) => step.stepId);

    state = startPlanSteps(source, state, ids);
    state = applyPlanStepOutcome(source, state, { stepId: ids[0]!, status: 'succeeded' });
    expect(state.status).toBe('running');
    state = applyPlanStepOutcome(source, state, { stepId: ids[1]!, status: 'succeeded' });
    expect(state.status).toBe('completed');
  });

  it('fails when no step succeeded and no work remains', () => {
    const source = plan(['independent', 'after_previous']);
    const firstId = source.steps[0]!.stepId;
    let state = startPlanSteps(source, createPlanExecutionState(source), [firstId]);

    state = applyPlanStepOutcome(source, state, {
      stepId: firstId,
      status: 'failed',
      reason: 'timeout',
    });

    expect(state.status).toBe('failed');
    expect(state.steps.map((step) => step.status)).toEqual(['failed', 'skipped']);
  });

  it('enforces one attempt and refuses duplicate, foreign, or premature results', () => {
    const source = plan(['independent']);
    const stepId = source.steps[0]!.stepId;
    const initial = createPlanExecutionState(source);

    expect(() => applyPlanStepOutcome(source, initial, { stepId, status: 'succeeded' }))
      .toThrow('does not match one running step');
    const running = startPlanSteps(source, initial, [stepId]);
    expect(() => startPlanSteps(source, running, [stepId])).toThrow('only ready steps');
    expect(() => applyPlanStepOutcome(source, running, {
      stepId: 'foreign-step',
      status: 'succeeded',
    })).toThrow('does not match one running step');
    const completed = applyPlanStepOutcome(source, running, { stepId, status: 'succeeded' });
    expect(() => applyPlanStepOutcome(source, completed, { stepId, status: 'succeeded' }))
      .toThrow('terminal plan');
  });

  it('rejects execution state against a different plan snapshot', () => {
    const first = plan(['independent']);
    const second = plan(['independent']);
    const state = createPlanExecutionState(first);

    expect(() => getReadyPlanStepIds(second, state)).toThrow('does not match');
  });

  it('cancels unfinished work without undoing successful steps', () => {
    const source = plan(['independent', 'independent', 'independent']);
    const ids = source.steps.map((step) => step.stepId);
    let state = startPlanSteps(source, createPlanExecutionState(source), ids);
    state = applyPlanStepOutcome(source, state, { stepId: ids[0]!, status: 'succeeded' });
    state = cancelPlanExecution(source, state, 'user_canceled');

    expect(state.status).toBe('canceled');
    expect(state.cancellationReason).toBe('user_canceled');
    expect(state.steps.map((step) => step.status)).toEqual(['succeeded', 'canceled', 'canceled']);
    expect(cancelPlanExecution(source, state, 'user_canceled')).toBe(state);
  });
});
