import { describe, expect, it } from 'vitest';
import {
  createDecisionContext,
  type DecisionCapabilitySnapshot,
} from '../../../src/core/decision-context.js';
import type { TurnEnvelope } from '../../../src/core/turn-contract.js';
import type { ReminderClock } from '../../../src/services/actions/reminder-contract.js';
import {
  compileRouterPlanProposal,
  validateRouterPlanProposal,
} from '../../../src/services/llm/router-plan-validator.js';

const reminderClock: ReminderClock = {
  nowMs: () => Date.UTC(2026, 8, 3, 12, 0),
  toLocal: (epochMs) => new Date(epochMs).toISOString().slice(0, 16),
};

const availableCapabilities: DecisionCapabilitySnapshot = {
  lifecycleGeneration: 1,
  modelExecutionMode: 'exclusive',
  router: { state: 'available', reason: 'ready' },
  localAnswer: { state: 'available', reason: 'ready' },
  actions: { state: 'available', reason: 'ready' },
  webSearch: { state: 'available', reason: 'ready' },
  visibleBrowserResult: { state: 'available', reason: 'ready' },
  reminders: { state: 'available', reason: 'ready' },
  media: { state: 'available', reason: 'ready' },
  specialists: {
    coding: { state: 'available', reason: 'ready' },
    research: { state: 'available', reason: 'ready' },
    vision: { state: 'available', reason: 'ready' },
  },
};

interface DependencyOptions {
  readonly turnId?: string;
  readonly privateContext?: boolean;
  readonly customCommand?: string;
  readonly createIntentId?: () => string;
  readonly capabilities?: DecisionCapabilitySnapshot;
  readonly programRoles?: readonly {
    readonly role: 'browser' | 'code_editor' | 'music_player';
    readonly programName: string;
  }[];
}

function dependencies(options: DependencyOptions = {}) {
  return {
    reminderClock,
    ...(options.createIntentId ? { createIntentId: options.createIntentId } : {}),
    decisionContext: createDecisionContext({
      version: 1,
      turn: {
        turnId: options.turnId ?? 'source-turn',
        mode: 'chat',
        privateContext: options.privateContext ?? false,
        inputOrigin: options.customCommand
          ? { kind: 'custom_command_expansion', customCommand: options.customCommand }
          : { kind: 'user_text' },
      },
      programRoles: options.programRoles ?? [],
      preferredSourceHints: [],
      capabilities: options.capabilities ?? availableCapabilities,
    }),
  };
}

function envelope(effectiveText: string, customCommand?: string): TurnEnvelope {
  return {
    turnId: 'source-turn',
    source: 'chat',
    mode: 'chat',
    originalText: effectiveText,
    normalizedText: effectiveText,
    effectiveText,
    createdAt: '2026-09-03T12:00:00.000Z',
    command: customCommand
      ? {
        kind: 'custom',
        command: customCommand,
        arguments: '',
        expandedText: effectiveText,
      }
      : { kind: 'none' },
  };
}

function output(intents: readonly object[]): string {
  return `SARAH_PROPOSAL_V1 ${JSON.stringify({ intents })}`;
}

describe('compileRouterPlanProposal', () => {
  it('creates an inert clause-bound plan for action, answer, and handoff', () => {
    const actionEvidence = 'Stelle einen Timer auf 10 Minuten';
    const text = `${actionEvidence}, erzähl mir etwas über Fahrräder und baue TTS in Sarah ein.`;
    let id = 0;
    const result = compileRouterPlanProposal(output([
      { kind: 'action', action: 'set_timer', param: '10m', evidence: actionEvidence },
      { kind: 'answer', evidence: 'erzähl mir etwas über Fahrräder' },
      { kind: 'handoff', specialist: 'coding', evidence: 'baue TTS in Sarah ein' },
    ]), envelope(text), dependencies({
      createIntentId: () => `intent-${++id}`,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.kind)).toEqual([
      'action',
      'answer',
      'handoff_confirmation',
      'specialist_handoff',
    ]);
    const action = result.plan.steps[0];
    if (action.kind !== 'action') throw new Error('expected action step');
    expect(action.intent.provenance.evidenceScope).toEqual({
      kind: 'clause',
      intentId: 'intent-1',
      ordinal: 0,
      startOffset: 0,
      endOffset: actionEvidence.length,
    });
    const confirmation = result.plan.steps[2];
    const handoff = result.plan.steps[3];
    expect(handoff.dependsOn).toEqual([confirmation.stepId]);
    expect(handoff).toMatchObject({
      kind: 'specialist_handoff',
      capability: 'coding',
      task: 'baue TTS in Sarah ein',
    });
    expect(result.plan.steps.every((step) => !('provider' in step))).toBe(true);
  });

  it('preserves custom-command expansion as the action evidence source', () => {
    const text = 'Stelle einen Timer auf 10 Minuten und erinnere mich in 20 Minuten an Tee';
    const result = compileRouterPlanProposal(output([
      { kind: 'action', action: 'set_timer', param: '10m', evidence: 'Stelle einen Timer auf 10 Minuten' },
      { kind: 'action', action: 'set_reminder', param: 'after=20m|text=Tee', evidence: 'erinnere mich in 20 Minuten an Tee' },
    ]), envelope(text, '/arbeitsplatz'), dependencies({ customCommand: '/arbeitsplatz' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const actions = result.plan.steps.filter((step) => step.kind === 'action');
    expect(actions.every((step) => (
      step.intent.provenance.evidenceSource === 'custom_command_expansion'
      && step.intent.provenance.customCommand === '/arbeitsplatz'
    ))).toBe(true);
  });

  it('binds anonymous or active incognito context into the immutable plan', () => {
    const text = 'Stelle einen Timer auf 10 Minuten und erzähl etwas über Fahrräder';
    const anonymousEnvelope = {
      ...envelope(text),
      command: { kind: 'anonymous', command: '/anonymous', arguments: text } as const,
    };
    const intents = [
      { kind: 'action', action: 'set_timer', param: '10m', evidence: 'Stelle einen Timer auf 10 Minuten' },
      { kind: 'answer', evidence: 'erzähl etwas über Fahrräder' },
    ];

    const anonymous = compileRouterPlanProposal(
      output(intents),
      anonymousEnvelope,
      dependencies({ privateContext: true }),
    );
    const incognito = compileRouterPlanProposal(
      output(intents),
      envelope(text),
      dependencies({ privateContext: true }),
    );

    expect(anonymous.ok && anonymous.plan.privateContext).toBe(true);
    expect(incognito.ok && incognito.plan.privateContext).toBe(true);
  });

  it('grounds an action only against its own evidence clause', () => {
    const text = 'Starte einen Timer in zehn Minuten und erinnere mich in fünf Minuten an Tee.';
    const result = compileRouterPlanProposal(output([
      {
        kind: 'action',
        action: 'set_timer',
        param: '5m',
        evidence: 'Starte einen Timer in zehn Minuten',
      },
      { kind: 'answer', evidence: 'erinnere mich in fünf Minuten an Tee' },
    ]), envelope(text), dependencies());

    expect(result).toEqual({ ok: false, reason: 'invalid_action' });
  });

  it('rejects allowlisted actions until their parameters have semantic grounding', () => {
    const text = 'Öffne Spotify und erzähl etwas über Fahrräder';
    const result = compileRouterPlanProposal(output([
      { kind: 'action', action: 'open_program', param: 'spotify', evidence: 'Öffne Spotify' },
      { kind: 'answer', evidence: 'erzähl etwas über Fahrräder' },
    ]), envelope(text), dependencies());

    expect(result).toEqual({ ok: false, reason: 'insufficient_action_grounding' });
  });

  it('resolves an explicit program role and binds the resolution into provenance', () => {
    const text = 'Öffne meinen Editor und erzähl etwas über Fahrräder';
    const result = compileRouterPlanProposal(output([
      { kind: 'action', action: 'open_program', param: 'role:code_editor', evidence: 'Öffne meinen Editor' },
      { kind: 'answer', evidence: 'erzähl etwas über Fahrräder' },
    ]), envelope(text), dependencies({
      programRoles: [{ role: 'code_editor', programName: 'Visual Studio Code' }],
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const action = result.plan.steps[0];
    if (action.kind !== 'action') throw new Error('expected action step');
    expect(action.intent).toMatchObject({
      action: 'open_program',
      param: 'Visual Studio Code',
      provenance: {
        validation: 'semantic_grounding',
        parameterResolution: {
          kind: 'program_role',
          role: 'code_editor',
          programName: 'Visual Studio Code',
        },
      },
    });
    expect(Object.isFrozen(action.intent.provenance.parameterResolution)).toBe(true);
  });

  it('rejects a role parameter when the role is missing or absent from its evidence clause', () => {
    const text = 'Öffne Spotify und erzähl etwas über Fahrräder';
    const proposal = output([
      { kind: 'action', action: 'open_program', param: 'role:code_editor', evidence: 'Öffne Spotify' },
      { kind: 'answer', evidence: 'erzähl etwas über Fahrräder' },
    ]);

    expect(compileRouterPlanProposal(proposal, envelope(text), dependencies({
      programRoles: [{ role: 'code_editor', programName: 'Visual Studio Code' }],
    }))).toEqual({ ok: false, reason: 'unresolved_program_role' });
    expect(compileRouterPlanProposal(
      output([
        { kind: 'action', action: 'open_program', param: 'role:code_editor', evidence: 'Öffne meinen Editor' },
        { kind: 'answer', evidence: 'erzähl etwas über Fahrräder' },
      ]),
      envelope('Öffne meinen Editor und erzähl etwas über Fahrräder'),
      dependencies(),
    )).toEqual({ ok: false, reason: 'unresolved_program_role' });
  });

  it('does not turn a declarative program-role mention into an open action', () => {
    const text = 'Mein Editor ist praktisch und erzähl etwas über Fahrräder';
    const result = compileRouterPlanProposal(output([
      { kind: 'action', action: 'open_program', param: 'role:code_editor', evidence: 'Mein Editor ist praktisch' },
      { kind: 'answer', evidence: 'erzähl etwas über Fahrräder' },
    ]), envelope(text), dependencies({
      programRoles: [{ role: 'code_editor', programName: 'Visual Studio Code' }],
    }));

    expect(result).toEqual({ ok: false, reason: 'unresolved_program_role' });
  });

  it('fails closed when the context belongs to another turn', () => {
    const text = 'Stelle einen Timer auf 10 Minuten und erzähl etwas über Fahrräder';
    const result = compileRouterPlanProposal(output([
      { kind: 'action', action: 'set_timer', param: '10m', evidence: 'Stelle einen Timer auf 10 Minuten' },
      { kind: 'answer', evidence: 'erzähl etwas über Fahrräder' },
    ]), envelope(text), dependencies({ turnId: 'another-turn' }));

    expect(result).toEqual({ ok: false, reason: 'decision_context_mismatch' });
  });

  it('rejects an intent when its current capability is not available', () => {
    const text = 'Pausiere die Musik und erzähl etwas über Fahrräder';
    const result = compileRouterPlanProposal(output([
      { kind: 'action', action: 'media_pause', param: '', evidence: 'Pausiere die Musik' },
      { kind: 'answer', evidence: 'erzähl etwas über Fahrräder' },
    ]), envelope(text), dependencies({
      capabilities: {
        ...availableCapabilities,
        media: { state: 'unknown', reason: 'no_readiness_source' },
      },
    }));

    expect(result).toEqual({ ok: false, reason: 'capability_unavailable' });
  });

  it('rejects evidence that omits meaningful clause text such as a negation', () => {
    const text = 'Erkläre mir das nicht und baue TTS in Sarah ein';
    const result = compileRouterPlanProposal(output([
      { kind: 'answer', evidence: 'Erkläre mir das' },
      { kind: 'handoff', specialist: 'coding', evidence: 'baue TTS in Sarah ein' },
    ]), envelope(text), dependencies());

    expect(result).toEqual({ ok: false, reason: 'incomplete_evidence' });
  });

  it('rejects alternatives instead of executing both branches', () => {
    const text = 'Erkläre Spotify oder baue TTS in Sarah ein';
    const result = compileRouterPlanProposal(output([
      { kind: 'answer', evidence: 'Erkläre Spotify' },
      { kind: 'handoff', specialist: 'coding', evidence: 'baue TTS in Sarah ein' },
    ]), envelope(text), dependencies());

    expect(result).toEqual({ ok: false, reason: 'incomplete_evidence' });
  });

  it('derives an explicit temporal dependency from the text between clauses', () => {
    const text = 'Stelle einen Timer auf 10 Minuten und danach erinnere mich in 20 Minuten an Tee';
    const result = compileRouterPlanProposal(output([
      { kind: 'action', action: 'set_timer', param: '10m', evidence: 'Stelle einen Timer auf 10 Minuten' },
      { kind: 'action', action: 'set_reminder', param: 'after=20m|text=Tee', evidence: 'erinnere mich in 20 Minuten an Tee' },
    ]), envelope(text), dependencies());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps[1]?.dependsOn).toEqual([result.plan.steps[0]?.stepId]);
  });

  it('fails closed instead of storing offsets against a normalized copy', () => {
    const decomposedText = 'Erkläre Cafe\u0301 und baue TTS in Sarah ein';
    const result = compileRouterPlanProposal(output([
      { kind: 'answer', evidence: 'Erkläre Café' },
      { kind: 'handoff', specialist: 'coding', evidence: 'baue TTS in Sarah ein' },
    ]), envelope(decomposedText, '/unicode'), dependencies({ customCommand: '/unicode' }));

    expect(result).toEqual({ ok: false, reason: 'missing_evidence' });
  });

  it.each([
    {
      name: 'missing',
      text: 'Öffne Spotify und erzähl etwas über Fahrräder',
      intents: [
        { kind: 'action', action: 'open_program', param: 'spotify', evidence: 'Öffne Photoshop' },
        { kind: 'answer', evidence: 'erzähl etwas über Fahrräder' },
      ],
      reason: 'missing_evidence',
    },
    {
      name: 'ambiguous',
      text: 'Öffne Spotify und Öffne Spotify',
      intents: [
        { kind: 'action', action: 'open_program', param: 'spotify', evidence: 'Öffne Spotify' },
        { kind: 'answer', evidence: 'Öffne Spotify' },
      ],
      reason: 'ambiguous_evidence',
    },
    {
      name: 'unordered',
      text: 'Öffne Spotify und erzähl etwas über Fahrräder',
      intents: [
        { kind: 'answer', evidence: 'Öffne Spotify' },
        { kind: 'answer', evidence: 'Spotify' },
      ],
      reason: 'unordered_evidence',
    },
    {
      name: 'unknown action',
      text: 'Sende Daten und erzähl etwas',
      intents: [
        { kind: 'action', action: 'send_all_data', param: 'all', evidence: 'Sende Daten' },
        { kind: 'answer', evidence: 'erzähl etwas' },
      ],
      reason: 'unknown_action',
    },
  ])('rejects $name evidence or action without returning a partial plan', ({ text, intents, reason }) => {
    expect(compileRouterPlanProposal(output(intents), envelope(text), dependencies())).toEqual({
      ok: false,
      reason,
    });
  });

  it('rejects malformed proposals without dispatching a partial plan', () => {
    expect(compileRouterPlanProposal(
      'SARAH_PROPOSAL_V1 {"intents":[',
      envelope('Öffne Spotify und erzähl etwas'),
      dependencies(),
    )).toEqual({ ok: false, reason: 'proposal_invalid_json' });
  });

  it('revalidates the runtime boundary when called with a forged typed proposal', () => {
    const forged = {
      intents: [{ kind: 'answer', evidence: 'nur eine Absicht' }],
    } as Parameters<typeof validateRouterPlanProposal>[0];

    expect(validateRouterPlanProposal(
      forged,
      envelope('nur eine Absicht'),
      dependencies(),
    )).toEqual({ ok: false, reason: 'proposal_invalid_schema' });
  });
});
