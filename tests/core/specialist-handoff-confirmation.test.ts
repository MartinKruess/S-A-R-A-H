import { describe, expect, it } from 'vitest';
import {
  SpecialistHandoffConfirmationGate,
  type SpecialistHandoffConfirmationSubject,
} from '../../src/core/specialist-handoff-confirmation.js';

const SOURCE_TURN = '11111111-1111-4111-8111-111111111111';
const CONFIRMATION_TURN = '22222222-2222-4222-8222-222222222222';
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const BINDING_ID = '44444444-4444-4444-8444-444444444444';

function subject(
  overrides: Partial<SpecialistHandoffConfirmationSubject> = {},
): SpecialistHandoffConfirmationSubject {
  return {
    planId: 'plan-1',
    revision: 1,
    fingerprint: 'a'.repeat(64),
    sourceTurnId: SOURCE_TURN,
    stepId: 'confirmation-step',
    task: 'Prüfe den aktuellen Diff.',
    capability: 'coding',
    privateContext: false,
    originMode: 'chat',
    dataEgress: ['goal'],
    accessMode: 'none',
    budget: { maxTurns: 25, timeoutMs: 30 * 60_000 },
    bindingLease: {
      providerId: 'openai',
      operationId: 'openai_codex',
      connectionId: CONNECTION_ID,
      bindingId: BINDING_ID,
      revision: 4,
    },
    display: { providerName: 'OpenAI', roleName: 'Coding', modelName: 'Standard' },
    ...overrides,
  };
}

describe('SpecialistHandoffConfirmationGate', () => {
  it('binds a short-lived grant to the exact subject and consumes it once', () => {
    let now = 1_000;
    const gate = new SpecialistHandoffConfirmationGate(5_000, () => now, () => 'grant-1');
    const request = gate.request(subject());

    expect(request).toMatchObject({ confirmationId: 'grant-1', expiresAt: 6_000 });
    const grant = gate.approve('grant-1', CONFIRMATION_TURN);
    expect(grant).toMatchObject({
      grantId: 'grant-1',
      confirmationTurnId: CONFIRMATION_TURN,
      expiresAt: 6_000,
    });
    expect(Object.isFrozen(grant)).toBe(true);
    expect(gate.consume(grant!, subject())).toBe(true);
    expect(gate.consume(grant!, subject())).toBe(false);
    now += 1;
  });

  it('fails closed for stale binding, fingerprint, privacy, mode, task or confirmation turn', () => {
    const gate = new SpecialistHandoffConfirmationGate(5_000, () => 1_000, () => 'grant-1');
    gate.request(subject());
    const grant = gate.approve('grant-1', CONFIRMATION_TURN)!;

    expect(gate.consume(grant, subject({
      bindingLease: { ...subject().bindingLease, revision: 5 },
    })))
      .toBe(false);
    expect(gate.consume(grant, subject({ fingerprint: 'b'.repeat(64) }))).toBe(false);
    expect(gate.consume(grant, subject({ privateContext: true }))).toBe(false);
    expect(gate.consume(grant, subject({ originMode: 'voice' }))).toBe(false);
    expect(gate.consume(grant, subject({ task: 'Ein anderes Ziel.' }))).toBe(false);
    expect(gate.consume({ ...grant, confirmationTurnId: SOURCE_TURN }, subject())).toBe(false);
    expect(gate.consume(grant, subject())).toBe(true);
  });

  it('binds consent to the exact provider, operation and connection lease', () => {
    const variants: SpecialistHandoffConfirmationSubject['bindingLease'][] = [
      {
        ...subject().bindingLease,
        providerId: 'anthropic',
        operationId: 'anthropic_claude_agent',
      },
      { ...subject().bindingLease, operationId: 'openai_responses_text' },
      {
        ...subject().bindingLease,
        connectionId: '55555555-5555-4555-8555-555555555555',
      },
    ];

    for (const [index, bindingLease] of variants.entries()) {
      const gate = new SpecialistHandoffConfirmationGate(
        5_000,
        () => 1_000,
        () => `grant-${index}`,
      );
      gate.request(subject());
      const grant = gate.approve(`grant-${index}`, CONFIRMATION_TURN)!;
      expect(gate.consume(grant, subject({ bindingLease }))).toBe(false);
    }
  });

  it('rejects workspace access or file egress without an explicit workspace reference', () => {
    const gate = new SpecialistHandoffConfirmationGate();

    expect(gate.request(subject({ accessMode: 'read_only' }))).toBeNull();
    expect(gate.request(subject({ dataEgress: ['goal', 'workspace_files'] }))).toBeNull();
    expect(gate.request(subject({
      dataEgress: ['goal', 'workspace_files'],
      workspaceReference: 'workspace-sarah',
      accessMode: 'none',
    }))).toBeNull();
    expect(gate.request(subject({
      dataEgress: ['goal', 'workspace_files'],
      workspaceReference: 'workspace-sarah',
      accessMode: 'read_only',
    }))).not.toBeNull();
  });

  it('expires pending requests and approved grants without extending consent', () => {
    let now = 1_000;
    const gate = new SpecialistHandoffConfirmationGate(100, () => now, () => 'grant-1');
    gate.request(subject());
    now = 1_100;
    expect(gate.approve('grant-1', CONFIRMATION_TURN)).toBeNull();

    now = 2_000;
    gate.request(subject());
    const grant = gate.approve('grant-1', CONFIRMATION_TURN)!;
    now = 2_100;
    expect(gate.consume(grant, subject())).toBe(false);
  });

  it('supports explicit cancel, turn invalidation and clear', () => {
    let next = 0;
    const gate = new SpecialistHandoffConfirmationGate(5_000, () => 1_000, () => `grant-${++next}`);
    const first = gate.request(subject())!;
    expect(gate.cancel(first.confirmationId)).toBe(true);
    expect(gate.approve(first.confirmationId, CONFIRMATION_TURN)).toBeNull();

    const second = gate.request(subject())!;
    gate.invalidateSourceTurn(SOURCE_TURN);
    expect(gate.approve(second.confirmationId, CONFIRMATION_TURN)).toBeNull();

    const third = gate.request(subject())!;
    gate.clear();
    expect(gate.approve(third.confirmationId, CONFIRMATION_TURN)).toBeNull();
  });
});
