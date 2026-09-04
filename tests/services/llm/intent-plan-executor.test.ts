import { describe, expect, it, vi } from 'vitest';
import type { ActionIntent } from '../../../src/core/action-intent.js';
import {
  createIntentPlan,
  type IntentClauseReference,
  type IntentPlan,
  type ValidatedExplicitIntent,
} from '../../../src/core/intent-plan.js';
import {
  IntentPlanExecutor,
  type IntentPlanAdapterResult,
  type IntentPlanExecutorAdapters,
} from '../../../src/services/llm/intent-plan-executor.js';

const SOURCE_TURN_ID = '11111111-1111-4111-8111-111111111111';

function evidence(
  intentId: string,
  ordinal: 0 | 1 | 2,
  startOffset: number,
  endOffset: number,
): IntentClauseReference {
  return { intentId, ordinal, startOffset, endOffset };
}

function timerIntent(clause: IntentClauseReference): ActionIntent {
  return {
    action: 'set_timer',
    param: '10m',
    provenance: {
      sourceTurnId: SOURCE_TURN_ID,
      decisionSource: 'router_model',
      validation: 'semantic_grounding',
      evidenceScope: { kind: 'clause', ...clause },
      evidenceSource: 'user_text',
    },
  };
}

function answer(
  intentId: string,
  ordinal: 0 | 1 | 2,
  order: ValidatedExplicitIntent['order'],
  text: string,
): ValidatedExplicitIntent {
  const startOffset = ordinal * 30;
  return {
    kind: 'answer',
    order,
    evidence: evidence(intentId, ordinal, startOffset, startOffset + 20),
    text,
  };
}

function adapters(
  overrides: Partial<IntentPlanExecutorAdapters> = {},
): IntentPlanExecutorAdapters {
  const succeeded = async (): Promise<IntentPlanAdapterResult> => ({ status: 'succeeded' });
  return {
    executeAction: succeeded,
    executeAnswer: succeeded,
    requestHandoffConfirmation: succeeded,
    executeSpecialistHandoff: succeeded,
    ...overrides,
  };
}

function statuses(plan: IntentPlan, state: Awaited<ReturnType<IntentPlanExecutor['execute']>>) {
  return plan.steps.map((step) => ({
    kind: step.kind,
    ...state.steps.find((candidate) => candidate.stepId === step.stepId),
  }));
}

describe('IntentPlanExecutor', () => {
  it('dispatches every step kind serially in immutable plan order', async () => {
    const actionEvidence = evidence('action', 0, 0, 20);
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      privateContext: true,
      originMode: 'voice',
      intents: [
        { kind: 'action', order: 'independent', intent: timerIntent(actionEvidence) },
        answer('answer', 1, 'independent', 'Erkläre Fahrräder.'),
        {
          kind: 'handoff',
          order: 'independent',
          evidence: evidence('handoff', 2, 60, 82),
          capability: 'coding',
          task: 'Prüfe den Diff.',
        },
      ],
    });
    const calls: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const record = async (kind: string): Promise<IntentPlanAdapterResult> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(kind);
      await Promise.resolve();
      active -= 1;
      return { status: 'succeeded' };
    };
    const executeAction = vi.fn<IntentPlanExecutorAdapters['executeAction']>(
      async (_step, context) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(context).toMatchObject({
          planId: plan.planId,
          revision: plan.revision,
          fingerprint: plan.fingerprint,
          sourceTurnId: SOURCE_TURN_ID,
          privateContext: true,
          originMode: 'voice',
        });
        return record('action');
      },
    );
    const executor = new IntentPlanExecutor(adapters({
      executeAction,
      executeAnswer: async () => record('answer'),
      requestHandoffConfirmation: async () => record('handoff_confirmation'),
      executeSpecialistHandoff: async () => record('specialist_handoff'),
    }));

    const state = await executor.execute(plan);

    expect(calls).toEqual(['action', 'answer', 'handoff_confirmation', 'specialist_handoff']);
    expect(maximumActive).toBe(1);
    expect(state.status).toBe('completed');
    expect(state.steps.every((step) => step.status === 'succeeded' && step.attempts === 1)).toBe(true);
  });

  it('skips only failed dependents and continues an independent branch without retrying', async () => {
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [
        answer('first', 0, 'independent', 'Erste Antwort.'),
        answer('dependent', 1, 'after_previous', 'Abhängige Antwort.'),
        answer('independent', 2, 'independent', 'Unabhängige Antwort.'),
      ],
    });
    const executeAnswer = vi.fn<IntentPlanExecutorAdapters['executeAnswer']>(async (step) => (
      step.text === 'Erste Antwort.'
        ? { status: 'failed', reason: 'answer_failed' }
        : { status: 'succeeded' }
    ));

    const state = await new IntentPlanExecutor(adapters({ executeAnswer })).execute(plan);

    expect(executeAnswer.mock.calls.map(([step]) => step.text)).toEqual([
      'Erste Antwort.',
      'Unabhängige Antwort.',
    ]);
    expect(state.status).toBe('partially_completed');
    expect(statuses(plan, state)).toMatchObject([
      { status: 'failed', attempts: 1, failureReason: 'answer_failed' },
      { status: 'skipped', attempts: 0, failureReason: 'dependency_failed' },
      { status: 'succeeded', attempts: 1 },
    ]);
  });

  it('converts an unexpected adapter exception into one failed attempt', async () => {
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [answer('answer', 0, 'independent', 'Erkläre etwas.')],
    });
    const executeAnswer = vi.fn<IntentPlanExecutorAdapters['executeAnswer']>(async () => {
      throw new Error('private adapter detail');
    });

    const state = await new IntentPlanExecutor(adapters({ executeAnswer })).execute(plan);

    expect(executeAnswer).toHaveBeenCalledOnce();
    expect(state.status).toBe('failed');
    expect(state.steps[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureReason: 'executor_error',
    });
  });

  it('marks the running and remaining steps canceled when aborted', async () => {
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [
        answer('first', 0, 'independent', 'Erste Antwort.'),
        answer('second', 1, 'independent', 'Zweite Antwort.'),
      ],
    });
    const controller = new AbortController();
    const executeAnswer = vi.fn<IntentPlanExecutorAdapters['executeAnswer']>(async () => {
      controller.abort();
      return { status: 'succeeded' };
    });

    const state = await new IntentPlanExecutor(adapters({ executeAnswer })).execute(
      plan,
      controller.signal,
      'user_canceled',
    );

    expect(executeAnswer).toHaveBeenCalledOnce();
    expect(state.status).toBe('canceled');
    expect(state.cancellationReason).toBe('user_canceled');
    expect(state.steps.map((step) => [step.status, step.attempts])).toEqual([
      ['canceled', 1],
      ['canceled', 0],
    ]);
  });

  it('cancels without dispatching when the signal is already aborted', async () => {
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [answer('answer', 0, 'independent', 'Erkläre etwas.')],
    });
    const controller = new AbortController();
    controller.abort();
    const executeAnswer = vi.fn<IntentPlanExecutorAdapters['executeAnswer']>();

    const state = await new IntentPlanExecutor(adapters({ executeAnswer })).execute(
      plan,
      controller.signal,
      'lifecycle_stopping',
    );

    expect(executeAnswer).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      status: 'canceled',
      cancellationReason: 'lifecycle_stopping',
    });
    expect(state.steps[0]).toMatchObject({ status: 'canceled', attempts: 0 });
  });

  it('refuses a forged or mutable plan before invoking an adapter', async () => {
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [answer('answer', 0, 'independent', 'Erkläre etwas.')],
    });
    const invalidPlan = { ...plan };
    const executeAnswer = vi.fn<IntentPlanExecutorAdapters['executeAnswer']>();

    await expect(new IntentPlanExecutor(adapters({ executeAnswer })).execute(invalidPlan))
      .rejects.toThrow(/invalid/u);
    expect(executeAnswer).not.toHaveBeenCalled();
  });
});
