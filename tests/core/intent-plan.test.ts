import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '../../src/core/action-intent.js';
import {
  MAX_EXPLICIT_INTENTS,
  MAX_PLAN_STEPS,
  createIntentPlan,
  validateIntentPlan,
  type IntentPlan,
  type IntentPlanStep,
  type IntentClauseReference,
  type SpecialistCapability,
  type ValidatedExplicitIntent,
} from '../../src/core/intent-plan.js';

const SOURCE_TURN_ID = '11111111-1111-4111-8111-111111111111';

function evidence(
  intentId: string,
  ordinal: 0 | 1 | 2,
  startOffset: number,
  endOffset: number,
): IntentClauseReference {
  return { intentId, ordinal, startOffset, endOffset };
}

function actionIntent(
  sourceTurnId = SOURCE_TURN_ID,
  clause = evidence('action-intent', 0, 0, 14),
): ActionIntent {
  return {
    action: 'open_program',
    param: 'spotify',
    provenance: {
      sourceTurnId,
      decisionSource: 'router_model',
      validation: 'semantic_grounding',
      evidenceScope: { kind: 'clause', ...clause },
      evidenceSource: 'user_text',
      parameterResolution: {
        kind: 'program_role',
        role: 'music_player',
        programName: 'spotify',
      },
    },
  };
}

function replaceSteps(plan: IntentPlan, steps: readonly IntentPlanStep[]): IntentPlan {
  return { ...plan, steps };
}

describe('IntentPlan core contract', () => {
  it('publishes the strict explicit-intent and derived-step limits', () => {
    expect(MAX_EXPLICIT_INTENTS).toBe(3);
    expect(MAX_PLAN_STEPS).toBe(6);
  });

  it('creates an immutable app-owned plan for action, answer, and handoff intents', () => {
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [
        { kind: 'action', order: 'independent', intent: actionIntent() },
        {
          kind: 'answer',
          order: 'independent',
          evidence: evidence('answer-intent', 1, 15, 45),
          text: 'Erkläre den nächsten Schritt.',
        },
        {
          kind: 'handoff',
          order: 'independent',
          evidence: evidence('handoff-intent', 2, 46, 72),
          capability: 'coding',
          task: 'Prüfe den aktuellen Diff.',
        },
      ],
    });

    expect(plan.planId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(plan.revision).toBe(1);
    expect(plan.sourceTurnId).toBe(SOURCE_TURN_ID);
    expect(plan.privateContext).toBe(false);
    expect(plan.originMode).toBe('chat');
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'action',
      'answer',
      'handoff_confirmation',
      'specialist_handoff',
    ]);
    expect(new Set(plan.steps.map((step) => step.stepId)).size).toBe(4);
    expect(new Set(plan.steps.map((step) => step.intentId)).size).toBe(3);
    expect(plan.steps.map((step) => step.intentId)).toEqual([
      'action-intent',
      'answer-intent',
      'handoff-intent',
      'handoff-intent',
    ]);
    const confirmation = plan.steps[2];
    const handoff = plan.steps[3];
    expect(handoff.dependsOn).toEqual([confirmation.stepId]);
    expect(handoff).not.toHaveProperty('provider');
    expect(validateIntentPlan(plan)).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.steps)).toBe(true);
    expect(plan.steps.every((step) => Object.isFrozen(step) && Object.isFrozen(step.dependsOn))).toBe(true);
    const action = plan.steps[0];
    if (action.kind !== 'action') throw new Error('expected action step');
    expect(Object.isFrozen(action.intent)).toBe(true);
    expect(Object.isFrozen(action.intent.provenance)).toBe(true);
    expect(Object.isFrozen(action.intent.provenance.evidenceScope)).toBe(true);
    expect(plan.steps.every((step) => Object.isFrozen(step.evidence))).toBe(true);
  });

  it.each(['coding', 'research', 'vision'] as const)(
    'supports the %s specialist capability without naming a provider',
    (capability) => {
      const plan = createIntentPlan({
        sourceTurnId: SOURCE_TURN_ID,
        intents: [{
          kind: 'handoff',
          order: 'independent',
          evidence: evidence('handoff-intent', 0, 0, 22),
          capability,
          task: 'Bearbeite die Aufgabe.',
        }],
      });

      expect(plan.steps).toHaveLength(2);
      expect(plan.steps.every((step) => !('provider' in step))).toBe(true);
      expect(validateIntentPlan(plan)).toBe(true);
    },
  );

  it('expands three handoffs to the maximum of six valid steps', () => {
    const intents: ValidatedExplicitIntent[] = [
      { kind: 'handoff', order: 'independent', evidence: evidence('coding', 0, 0, 13), capability: 'coding', task: 'Implementiere.' },
      { kind: 'handoff', order: 'independent', evidence: evidence('research', 1, 14, 27), capability: 'research', task: 'Recherchiere.' },
      { kind: 'handoff', order: 'independent', evidence: evidence('vision', 2, 28, 43), capability: 'vision', task: 'Prüfe das Bild.' },
    ];
    const plan = createIntentPlan({ sourceTurnId: SOURCE_TURN_ID, intents });

    expect(plan.steps).toHaveLength(MAX_PLAN_STEPS);
    expect(validateIntentPlan(plan)).toBe(true);
  });

  it('links an explicitly sequential intent to the previous terminal step', () => {
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [
        {
          kind: 'answer',
          order: 'independent',
          evidence: evidence('answer', 0, 0, 8),
          text: 'Antwort.',
        },
        {
          kind: 'handoff',
          order: 'after_previous',
          evidence: evidence('handoff', 1, 9, 24),
          capability: 'coding',
          task: 'Prüfe den Diff.',
        },
      ],
    });

    expect(plan.steps[1]?.kind).toBe('handoff_confirmation');
    expect(plan.steps[1]?.dependsOn).toEqual([plan.steps[0]?.stepId]);
    expect(plan.steps[2]?.dependsOn).toEqual([plan.steps[1]?.stepId]);
  });

  it('rejects zero or more than three explicit intents', () => {
    expect(() => createIntentPlan({ sourceTurnId: SOURCE_TURN_ID, intents: [] })).toThrow(/1\.\.3/u);
    const answer = (intentId: string, ordinal: 0 | 1 | 2): ValidatedExplicitIntent => ({
      kind: 'answer',
      order: 'independent',
      evidence: evidence(intentId, ordinal, ordinal * 10, (ordinal * 10) + 8),
      text: 'Antwort.',
    });
    expect(() => createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [answer('a', 0), answer('b', 1), answer('c', 2), answer('d', 2)],
    })).toThrow(/1\.\.3/u);
  });

  it('rejects action provenance from another source turn', () => {
    expect(() => createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [{ kind: 'action', order: 'independent', intent: actionIntent('foreign-turn') }],
    })).toThrow(/source turn/u);
  });

  it.each([
    {
      ...actionIntent(),
      action: 'delete_everything',
    },
    {
      ...actionIntent(),
      provenance: { ...actionIntent().provenance, decisionSource: 'forged' },
    },
    {
      ...actionIntent(),
      provenance: {
        ...actionIntent().provenance,
        interactionContext: { kind: 'forged', contextTurnId: 'context-turn' },
      },
    },
  ] as ActionIntent[])('rejects a forged runtime action intent: %#', (forgedIntent) => {
    expect(() => createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [{ kind: 'action', order: 'independent', intent: forgedIntent }],
    })).toThrow(/source turn/u);
  });

  it('accepts an exact named program without pretending it came from a configured role', () => {
    const provenance = actionIntent().provenance;
    const unresolvedIntent: ActionIntent = {
      action: 'open_program',
      param: 'spotify',
      provenance: {
        sourceTurnId: provenance.sourceTurnId,
        decisionSource: provenance.decisionSource,
        validation: provenance.validation,
        evidenceScope: provenance.evidenceScope,
        evidenceSource: 'user_text',
      },
    };

    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [{ kind: 'action', order: 'independent', intent: unresolvedIntent }],
    });

    const action = plan.steps[0];
    expect(action?.kind).toBe('action');
    if (action?.kind !== 'action') return;
    expect(action.intent.param).toBe('spotify');
    expect(action.intent.provenance.parameterResolution).toBeUndefined();
  });

  it('rejects a non-canonical or schema-invalid action parameter', () => {
    const base = actionIntent().provenance;
    const invalidParamIntent: ActionIntent = {
      action: 'set_volume',
      param: '999',
      provenance: {
        sourceTurnId: base.sourceTurnId,
        decisionSource: base.decisionSource,
        validation: base.validation,
        evidenceScope: base.evidenceScope,
        evidenceSource: 'user_text',
      },
    };

    expect(() => createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [{ kind: 'action', order: 'independent', intent: invalidParamIntent }],
    })).toThrow(/source turn/u);
  });

  it('freezes program-role resolution and requires it to match the final parameter', () => {
    const resolvedIntent: ActionIntent = {
      ...actionIntent(),
      param: 'Visual Studio Code',
      provenance: {
        ...actionIntent().provenance,
        parameterResolution: {
          kind: 'program_role',
          role: 'code_editor',
          programName: 'Visual Studio Code',
        },
      },
    };
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [{ kind: 'action', order: 'independent', intent: resolvedIntent }],
    });
    const action = plan.steps[0];
    if (action.kind !== 'action') throw new Error('expected action step');

    expect(action.intent.provenance.parameterResolution).toEqual({
      kind: 'program_role',
      role: 'code_editor',
      programName: 'Visual Studio Code',
    });
    expect(Object.isFrozen(action.intent.provenance.parameterResolution)).toBe(true);

    expect(() => createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [{
        kind: 'action',
        order: 'independent',
        intent: {
          ...resolvedIntent,
          provenance: {
            ...resolvedIntent.provenance,
            parameterResolution: {
              kind: 'program_role',
              role: 'code_editor',
              programName: 'Cursor',
            },
          },
        },
      }],
    })).toThrow(/source turn/u);
  });

  it('rejects whole-turn action evidence and invalid clause grouping', () => {
    const wholeTurnIntent: ActionIntent = {
      ...actionIntent(),
      provenance: {
        ...actionIntent().provenance,
        evidenceScope: { kind: 'whole_turn' },
      },
    };
    expect(() => createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [{ kind: 'action', order: 'independent', intent: wholeTurnIntent }],
    })).toThrow(/clause evidence/u);

    expect(() => createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [
        { kind: 'answer', order: 'independent', evidence: evidence('first', 0, 0, 12), text: 'Erste Antwort.' },
        { kind: 'answer', order: 'independent', evidence: evidence('second', 1, 10, 20), text: 'Zweite Antwort.' },
      ],
    })).toThrow(/must not overlap/u);

    expect(() => createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [
        { kind: 'answer', order: 'independent', evidence: evidence('same', 0, 0, 8), text: 'Erste Antwort.' },
        { kind: 'answer', order: 'independent', evidence: evidence('same', 1, 9, 18), text: 'Zweite Antwort.' },
      ],
    })).toThrow(/must be unique/u);
  });

  it('detects fingerprint changes and invalid revisions', () => {
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      revision: 2,
      intents: [{ kind: 'answer', order: 'independent', evidence: evidence('answer', 0, 0, 8), text: 'Antwort.' }],
    });

    expect(validateIntentPlan({ ...plan })).toBe(false);
    expect(validateIntentPlan(Object.freeze({ ...plan, revision: 3 }))).toBe(false);
    expect(validateIntentPlan(Object.freeze({ ...plan, privateContext: true }))).toBe(false);
    expect(validateIntentPlan(Object.freeze({ ...plan, originMode: 'voice' }))).toBe(false);
    expect(validateIntentPlan(Object.freeze({ ...plan, fingerprint: '0'.repeat(64) }))).toBe(false);
    expect(() => createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      revision: 0,
      intents: [{ kind: 'answer', order: 'independent', evidence: evidence('answer', 0, 0, 8), text: 'Antwort.' }],
    })).toThrow(/revision/u);
  });

  it('rejects missing dependencies and cycles', () => {
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [{
        kind: 'handoff',
        order: 'independent',
        evidence: evidence('handoff', 0, 0, 15),
        capability: 'coding',
        task: 'Prüfe den Diff.',
      }],
    });
    const confirmation = plan.steps[0];
    const handoff = plan.steps[1];
    const missingDependency = {
      ...handoff,
      dependsOn: ['missing-step'],
    } as IntentPlanStep;
    expect(validateIntentPlan(replaceSteps(plan, [confirmation, missingDependency]))).toBe(false);

    const cyclicConfirmation = {
      ...confirmation,
      dependsOn: [handoff.stepId],
    } as IntentPlanStep;
    expect(validateIntentPlan(replaceSteps(plan, [cyclicConfirmation, handoff]))).toBe(false);
  });

  it('rejects handoffs without their exact matching confirmation dependency', () => {
    const plan = createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [{
        kind: 'handoff',
        order: 'independent',
        evidence: evidence('handoff', 0, 0, 15),
        capability: 'coding',
        task: 'Prüfe den Diff.',
      }],
    });
    const confirmation = plan.steps[0];
    const handoff = plan.steps[1];
    const unsupportedCapability = 'audio' as SpecialistCapability;
    const changedHandoff = {
      ...handoff,
      capability: unsupportedCapability,
      dependsOn: [],
    } as IntentPlanStep;

    expect(validateIntentPlan(replaceSteps(plan, [confirmation, changedHandoff]))).toBe(false);
    const changedTask = {
      ...handoff,
      task: 'Eine andere Aufgabe.',
    } as IntentPlanStep;
    expect(validateIntentPlan(replaceSteps(plan, [confirmation, changedTask]))).toBe(false);
    expect(() => createIntentPlan({
      sourceTurnId: SOURCE_TURN_ID,
      intents: [{
        kind: 'handoff',
        order: 'independent',
        evidence: evidence('handoff', 0, 0, 15),
        capability: unsupportedCapability,
        task: 'Prüfe den Diff.',
      }],
    })).toThrow(/supported capability/u);
  });
});
