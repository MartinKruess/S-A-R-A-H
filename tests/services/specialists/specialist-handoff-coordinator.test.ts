import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntentPlan } from '../../../src/core/intent-plan.js';
import { PendingIntentPlanStore } from '../../../src/core/pending-intent-plan-store.js';
import { SpecialistHandoffConfirmationGate } from '../../../src/core/specialist-handoff-confirmation.js';
import type { SpecialistTaskAdapter } from '../../../src/services/specialists/specialist-task-adapter.js';
import { SpecialistHandoffCoordinator } from '../../../src/services/specialists/specialist-handoff-coordinator.js';
import { SpecialistRuntimeService } from '../../../src/services/specialists/specialist-runtime-service.js';
import { SpecialistTaskStore } from '../../../src/services/specialists/specialist-task-store.js';
import { IntentPlanExecutor } from '../../../src/services/llm/intent-plan-executor.js';

const directories: string[] = [];
const BINDING_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';

async function suspendedPlan() {
  const plan = createIntentPlan({
    sourceTurnId: 'source-turn',
    intents: [{
      kind: 'handoff',
      order: 'independent',
      evidence: {
        intentId: 'coding-goal',
        ordinal: 0,
        startOffset: 0,
        endOffset: 23,
      },
      capability: 'coding',
      task: 'Baue TTS in Sarah ein.',
    }],
  });
  const executor = new IntentPlanExecutor({
    executeAction: async () => ({ status: 'failed', reason: 'action_failed' }),
    executeAnswer: async () => ({ status: 'failed', reason: 'answer_failed' }),
    requestHandoffConfirmation: async () => ({ status: 'waiting_confirmation' }),
    executeSpecialistHandoff: async () => ({ status: 'failed', reason: 'handoff_failed' }),
  });
  return { plan, state: await executor.execute(plan) };
}

function harness(runtimeConnectionId = CONNECTION_ID, providerName = 'OpenAI') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-handoff-coordinator-'));
  directories.push(directory);
  let bindingRevision = 4;
  const adapter: SpecialistTaskAdapter = {
    operationId: 'openai_codex',
    isReady: () => true,
    preflight: vi.fn(async () => ({ ok: true })),
    start: vi.fn(async () => ({ remoteRef: 'remote-task', status: 'running' })),
    resume: vi.fn(async () => undefined),
    provideInput: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
  const runtime = new SpecialistRuntimeService({
    store: new SpecialistTaskStore(directory),
    adapters: [adapter],
    resolveBinding: () => ({
      bindingId: BINDING_ID,
      bindingRevision,
      providerId: 'openai',
      operationId: 'openai_codex',
      connectionId: runtimeConnectionId,
    }),
    resolveCredential: () => 'test-secret',
    now: () => Date.parse('2026-09-05T12:00:00.000Z'),
  });
  const clock = () => Date.parse('2026-09-05T12:00:00.000Z');
  const coordinator = new SpecialistHandoffCoordinator(
    runtime,
    () => ({
      providerId: 'openai',
      operationId: 'openai_codex',
      connectionId: CONNECTION_ID,
      bindingId: BINDING_ID,
      bindingRevision,
      providerName,
      roleName: 'Programmierung',
      modelName: 'Anbieterstandard',
    }),
    new SpecialistHandoffConfirmationGate(60_000, clock, () => 'confirm-1'),
    new PendingIntentPlanStore(clock),
    () => '11111111-1111-4111-8111-111111111111',
  );
  return {
    adapter,
    coordinator,
    setBindingRevision: (revision: number) => { bindingRevision = revision; },
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SpecialistHandoffCoordinator', () => {
  it('derives the visible provider name from the fixed lease provider catalog', async () => {
    const { plan, state } = await suspendedPlan();
    const spoofed = harness(CONNECTION_ID, 'Untrusted Provider Name');

    const registration = spoofed.coordinator.register(plan, state);

    expect(registration).toMatchObject({ ok: true });
    if (!registration.ok) throw new Error('Expected registration');
    expect(registration.prompt).toContain('Anbieter: OpenAI');
    expect(registration.prompt).not.toContain('Untrusted Provider Name');
  });

  it('keeps the goal inert until confirmation and resumes the exact remaining step once', async () => {
    const { plan, state } = await suspendedPlan();
    const current = harness();

    const registration = current.coordinator.register(plan, state);
    expect(registration).toMatchObject({ ok: true, confirmationId: 'confirm-1' });
    expect(current.adapter.start).not.toHaveBeenCalled();
    if (!registration.ok) throw new Error('Expected registration');

    const resumed = await current.coordinator.confirm(
      registration.confirmationId,
      'confirmation-turn',
      false,
    );

    expect(resumed).toMatchObject({ ok: true, state: { status: 'completed' } });
    expect(current.adapter.start).toHaveBeenCalledOnce();
    expect(await current.coordinator.confirm(
      registration.confirmationId,
      'replay-turn',
      false,
    )).toEqual({ ok: false, code: 'not_found' });
  });

  it('fails closed when the binding revision or privacy state changes', async () => {
    const first = await suspendedPlan();
    const stale = harness();
    const staleRegistration = stale.coordinator.register(first.plan, first.state);
    if (!staleRegistration.ok) throw new Error('Expected registration');
    stale.setBindingRevision(5);

    expect(await stale.coordinator.confirm(
      staleRegistration.confirmationId,
      'confirmation-turn',
      false,
    )).toMatchObject({ ok: false, code: 'stale' });
    expect(stale.adapter.start).not.toHaveBeenCalled();

    const second = await suspendedPlan();
    const privateChange = harness();
    const privateRegistration = privateChange.coordinator.register(second.plan, second.state);
    if (!privateRegistration.ok) throw new Error('Expected registration');
    expect(await privateChange.coordinator.confirm(
      privateRegistration.confirmationId,
      'confirmation-turn',
      true,
    )).toMatchObject({ ok: false, code: 'private_context' });
    expect(privateChange.adapter.start).not.toHaveBeenCalled();
  });

  it('never starts after confirmation when runtime selection differs from the consented lease', async () => {
    const { plan, state } = await suspendedPlan();
    const changed = harness('55555555-5555-4555-8555-555555555555');
    const registration = changed.coordinator.register(plan, state);
    if (!registration.ok) throw new Error('Expected registration');

    expect(await changed.coordinator.confirm(
      registration.confirmationId,
      'confirmation-turn',
      false,
    )).toMatchObject({ ok: false, code: 'start_failed' });
    expect(changed.adapter.start).not.toHaveBeenCalled();
  });
});
