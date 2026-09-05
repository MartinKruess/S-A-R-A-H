import { describe, expect, it } from 'vitest';
import { createIntentPlan } from '../../src/core/intent-plan.js';
import {
  createPlanExecutionState,
  type PlanExecutionState,
  startPlanSteps,
  suspendPlanStepForConfirmation,
} from '../../src/core/plan-execution-state.js';
import { PendingIntentPlanStore } from '../../src/core/pending-intent-plan-store.js';

const TURN_ID = '11111111-1111-4111-8111-111111111111';

function waitingPlan() {
  const plan = createIntentPlan({
    sourceTurnId: TURN_ID,
    intents: [{
      kind: 'handoff',
      order: 'independent',
      evidence: { intentId: 'handoff', ordinal: 0, startOffset: 0, endOffset: 20 },
      capability: 'coding',
      task: 'Prüfe den Diff.',
    }],
  });
  const stepId = plan.steps[0]!.stepId;
  const running = startPlanSteps(plan, createPlanExecutionState(plan), [stepId]);
  const state = suspendPlanStepForConfirmation(plan, running, stepId);
  return { plan, state };
}

describe('PendingIntentPlanStore', () => {
  it('stores only a valid suspended plan and returns it exactly once', () => {
    const { plan, state } = waitingPlan();
    const store = new PendingIntentPlanStore(() => 1_000);
    const { entry } = store.put('confirmation-1', plan, state, 2_000);

    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.plan).toBe(plan);
    expect(entry.state).toBe(state);
    expect(store.take('confirmation-1')).toBe(entry);
    expect(store.take('confirmation-1')).toBeNull();
  });

  it('expires, cancels, invalidates and clears pending plans', () => {
    let now = 1_000;
    const store = new PendingIntentPlanStore(() => now);
    const first = waitingPlan();
    store.put('first', first.plan, first.state, 1_100);
    now = 1_100;
    expect(store.take('first')).toBeNull();

    const second = waitingPlan();
    store.put('second', second.plan, second.state, 2_000);
    expect(store.cancel('second')?.confirmationId).toBe('second');
    expect(store.take('second')).toBeNull();

    const third = waitingPlan();
    store.put('third', third.plan, third.state, 2_000);
    expect(store.invalidateSourceTurn(TURN_ID)).toHaveLength(1);

    const fourth = waitingPlan();
    store.put('fourth', fourth.plan, fourth.state, 2_000);
    expect(store.clear()).toHaveLength(1);
    expect(store.take('fourth')).toBeNull();
  });

  it('supersedes an older pending plan and rejects mismatched or non-waiting state', () => {
    const store = new PendingIntentPlanStore(() => 1_000);
    const first = waitingPlan();
    const second = waitingPlan();
    store.put('first', first.plan, first.state, 2_000);
    const result = store.put('second', second.plan, second.state, 2_000);

    expect(result.superseded.map((entry) => entry.confirmationId)).toEqual(['first']);
    expect(store.take('first')).toBeNull();
    expect(store.take('second')?.plan).toBe(second.plan);

    expect(() => store.put(
      'invalid',
      first.plan,
      createPlanExecutionState(first.plan),
      2_000,
    )).toThrow(/waiting/u);
    expect(() => store.put('mismatch', second.plan, first.state, 2_000)).toThrow(/match/u);
  });

  it('rejects a forged waiting state for a non-confirmation plan step', () => {
    const plan = createIntentPlan({
      sourceTurnId: TURN_ID,
      intents: [{
        kind: 'answer',
        order: 'independent',
        evidence: { intentId: 'answer', ordinal: 0, startOffset: 0, endOffset: 10 },
        text: 'Antworte kurz.',
      }],
    });
    const forged = Object.freeze({
      ...createPlanExecutionState(plan),
      status: 'waiting_confirmation',
      steps: Object.freeze([Object.freeze({
        stepId: plan.steps[0]!.stepId,
        status: 'waiting_confirmation',
        attempts: 1,
      })]),
    }) as PlanExecutionState;

    expect(() => new PendingIntentPlanStore(() => 1_000).put(
      'forged',
      plan,
      forged,
      2_000,
    )).toThrow(/confirmation/u);
  });
});
