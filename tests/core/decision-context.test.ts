import { describe, expect, it } from 'vitest';
import {
  MAX_DECISION_PROGRAM_NAME_LENGTH,
  MAX_DECISION_SOURCE_DESCRIPTION_LENGTH,
  MAX_DECISION_SOURCE_HINTS,
  createDecisionCapabilitySnapshot,
  createDecisionContext,
  type DecisionCapability,
  type DecisionCapabilityReason,
  type DecisionCapabilitySnapshot,
  type DecisionCapabilityState,
  type DecisionContext,
  type DecisionProgramRole,
  type DecisionSourceHint,
} from '../../src/core/decision-context.js';

const AVAILABLE: DecisionCapability = { state: 'available', reason: 'ready' };
const UNAVAILABLE: DecisionCapability = { state: 'unavailable', reason: 'service_unavailable' };
const NO_ADAPTER: DecisionCapability = { state: 'unavailable', reason: 'no_adapter' };

function capabilitySnapshot(): DecisionCapabilitySnapshot {
  return {
    lifecycleGeneration: 4,
    modelExecutionMode: 'exclusive',
    router: AVAILABLE,
    localAnswer: AVAILABLE,
    actions: AVAILABLE,
    webSearch: UNAVAILABLE,
    visibleBrowserResult: { state: 'unavailable', reason: 'no_visible_result' },
    reminders: AVAILABLE,
    media: { state: 'unknown', reason: 'no_readiness_source' },
    specialists: {
      coding: NO_ADAPTER,
      research: NO_ADAPTER,
      vision: NO_ADAPTER,
    },
  };
}

function decisionContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    version: 1,
    turn: {
      turnId: '11111111-1111-4111-8111-111111111111',
      mode: 'chat',
      privateContext: false,
      inputOrigin: { kind: 'user_text' },
    },
    programRoles: [{ role: 'code_editor', programName: 'Visual Studio Code' }],
    preferredSourceHints: [{ id: 'source-1', description: 'Offizielle Dokumentation' }],
    capabilities: capabilitySnapshot(),
    ...overrides,
  };
}

describe('DecisionContext core contract', () => {
  it('creates a deeply immutable defensive context projection', () => {
    const programRoles: DecisionProgramRole[] = [
      { role: 'code_editor', programName: ' Visual Studio Code ' },
    ];
    const preferredSourceHints: DecisionSourceHint[] = [
      { id: ' source-1 ', description: ' Offizielle Dokumentation ' },
    ];
    const created = createDecisionContext(decisionContext({
      programRoles,
      preferredSourceHints,
    }));

    programRoles[0].programName = 'Manipulated';
    preferredSourceHints[0].description = 'Manipulated';
    programRoles.push({ role: 'browser', programName: 'Firefox' });

    expect(created.programRoles).toEqual([
      { role: 'code_editor', programName: 'Visual Studio Code' },
    ]);
    expect(created.preferredSourceHints).toEqual([
      { id: 'source-1', description: 'Offizielle Dokumentation' },
    ]);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.turn)).toBe(true);
    expect(Object.isFrozen(created.turn.inputOrigin)).toBe(true);
    expect(Object.isFrozen(created.programRoles)).toBe(true);
    expect(Object.isFrozen(created.programRoles[0])).toBe(true);
    expect(Object.isFrozen(created.preferredSourceHints)).toBe(true);
    expect(Object.isFrozen(created.preferredSourceHints[0])).toBe(true);
    expect(Object.isFrozen(created.capabilities)).toBe(true);
    expect(Object.isFrozen(created.capabilities.specialists)).toBe(true);
    expect(Object.isFrozen(created.capabilities.router)).toBe(true);
  });

  it('retains only a bounded custom-command name and no raw text', () => {
    const created = createDecisionContext(decisionContext({
      turn: {
        turnId: 'private-turn',
        mode: 'voice',
        privateContext: true,
        inputOrigin: {
          kind: 'custom_command_expansion',
          customCommand: ' /daily_brief ',
        },
      },
    }));

    expect(created.turn).toEqual({
      turnId: 'private-turn',
      mode: 'voice',
      privateContext: true,
      inputOrigin: {
        kind: 'custom_command_expansion',
        customCommand: '/daily_brief',
      },
    });
    expect(created).not.toHaveProperty('originalText');
    expect(created).not.toHaveProperty('effectiveText');
  });

  it('drops out-of-contract local paths, URLs and runtime messages', () => {
    const input = {
      ...decisionContext(),
      programRoles: [{
        role: 'code_editor' as const,
        programName: 'Visual Studio Code',
        path: 'C:\\secret\\Code.exe',
      }],
      preferredSourceHints: [{
        id: 'source-1',
        description: 'Dokumentation',
        url: 'https://private.example.test/token',
      }],
      capabilities: {
        ...capabilitySnapshot(),
        router: { ...AVAILABLE, message: 'provider secret' },
      },
    };

    const serialized = JSON.stringify(createDecisionContext(input));

    expect(serialized).not.toContain('C:\\secret');
    expect(serialized).not.toContain('private.example.test');
    expect(serialized).not.toContain('provider secret');
  });

  it.each([
    {
      state: 'available' as DecisionCapabilityState,
      reason: 'model_unavailable' as DecisionCapabilityReason,
    },
    {
      state: 'unknown' as DecisionCapabilityState,
      reason: 'ready' as DecisionCapabilityReason,
    },
    {
      state: 'unavailable' as DecisionCapabilityState,
      reason: 'no_readiness_source' as DecisionCapabilityReason,
    },
  ])('rejects contradictory capability state %#', (router) => {
    expect(() => createDecisionCapabilitySnapshot({
      ...capabilitySnapshot(),
      router,
    })).toThrow();
  });

  it('rejects invalid lifecycle generations', () => {
    expect(() => createDecisionCapabilitySnapshot({
      ...capabilitySnapshot(),
      lifecycleGeneration: -1,
    })).toThrow();
  });

  it('rejects duplicate or excessive preference projections', () => {
    expect(() => createDecisionContext(decisionContext({
      programRoles: [
        { role: 'browser', programName: 'Firefox' },
        { role: 'browser', programName: 'Chrome' },
      ],
    }))).toThrow();

    expect(() => createDecisionContext(decisionContext({
      preferredSourceHints: Array.from(
        { length: MAX_DECISION_SOURCE_HINTS + 1 },
        (_, index) => ({ id: `source-${index}`, description: `Source ${index}` }),
      ),
    }))).toThrow();
  });

  it.each([
    decisionContext({
      programRoles: [{ role: 'browser', programName: 'x'.repeat(MAX_DECISION_PROGRAM_NAME_LENGTH + 1) }],
    }),
    decisionContext({
      preferredSourceHints: [{
        id: 'source-1',
        description: 'x'.repeat(MAX_DECISION_SOURCE_DESCRIPTION_LENGTH + 1),
      }],
    }),
    decisionContext({
      turn: {
        turnId: 'turn',
        mode: 'chat',
        privateContext: false,
        inputOrigin: { kind: 'custom_command_expansion', customCommand: 'not-a-command' },
      },
    }),
  ])('rejects out-of-contract bounded input %#', (input) => {
    expect(() => createDecisionContext(input)).toThrow();
  });
});
