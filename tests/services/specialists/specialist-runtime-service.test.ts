import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SpecialistAdapterEvent,
  SpecialistBindingResolver,
  SpecialistTaskAdapter,
} from '../../../src/services/specialists/specialist-task-adapter.js';
import { SpecialistRuntimeService } from '../../../src/services/specialists/specialist-runtime-service.js';
import { SpecialistTaskStore } from '../../../src/services/specialists/specialist-task-store.js';
import { MAX_SPECIALIST_EVENT_IDS } from '../../../src/core/specialist-task.js';

const dirs: string[] = [];
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const BINDING_ID = '33333333-3333-4333-8333-333333333333';

function request() {
  return {
    taskId: TASK_ID,
    role: 'coding' as const,
    goal: 'Implementiere TTS.',
    sourceTurnId: 'turn-1',
    planId: '22222222-2222-4222-8222-222222222222',
    planRevision: 1,
    planFingerprint: 'a'.repeat(64),
    stepId: 'step-1',
    providerId: 'openai' as const,
    operationId: 'openai_codex' as const,
    connectionId: '44444444-4444-4444-8444-444444444444',
    bindingId: BINDING_ID,
    bindingRevision: 2,
    privateContext: false as const,
    originMode: 'chat' as const,
    dataEgress: ['goal'] as const,
    accessMode: 'none' as const,
    budget: { maxTurns: 10, timeoutMs: 60_000 },
  };
}

function setup(
  adapterOverrides: Partial<SpecialistTaskAdapter> = {},
  store?: SpecialistTaskStore,
  resolveBinding: SpecialistBindingResolver = () => ({
    bindingId: BINDING_ID,
    bindingRevision: 2,
    providerId: 'openai',
    operationId: 'openai_codex',
    connectionId: '44444444-4444-4444-8444-444444444444',
  }),
  runtimeOptions: {
    readonly providerOperationTimeoutMs?: number;
    readonly cleanupTimeoutMs?: number;
    readonly shutdownDrainMs?: number;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-specialist-runtime-'));
  dirs.push(dir);
  let emit: ((event: SpecialistAdapterEvent) => void) | undefined;
  const adapter: SpecialistTaskAdapter = {
    operationId: 'openai_codex',
    isReady: () => true,
    preflight: vi.fn(async () => ({ ok: true as const })),
    start: vi.fn(async (_request, context) => {
      emit = context.emit;
      return { remoteRef: 'remote-1', status: 'running' as const };
    }),
    retrieve: vi.fn(async () => ({ eventId: 'restart-running', type: 'running' as const })),
    resume: vi.fn(async () => undefined),
    provideInput: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    ...adapterOverrides,
  };
  const credentialResolver = vi.fn(() => 'secret-key');
  const runtime = new SpecialistRuntimeService({
    store: store ?? new SpecialistTaskStore(dir),
    adapters: [adapter],
    resolveBinding,
    resolveCredential: credentialResolver,
    now: () => Date.parse('2026-09-05T10:00:00.000Z'),
    shutdownDrainMs: 0,
    ...runtimeOptions,
  });
  return { adapter, credentialResolver, runtime, emit: () => emit, dir };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SpecialistRuntimeService', () => {
  it('preflights without exposing goal or credential and persists acceptance before publishing events', async () => {
    const seen: string[] = [];
    const harness = setup({
      start: vi.fn(async (_task, context) => {
        context.emit({ eventId: 'progress-early', type: 'progress', message: 'Gestartet.' });
        return { remoteRef: 'remote-1', status: 'running' as const };
      }),
    });
    harness.runtime.subscribe((snapshot) => seen.push(`${snapshot.sequence}:${snapshot.status}`));

    const preflight = await harness.runtime.preflight(request());
    expect(preflight.ok).toBe(true);
    expect(harness.credentialResolver).not.toHaveBeenCalled();
    expect(harness.adapter.preflight).toHaveBeenCalledWith(expect.objectContaining({
      bindingId: BINDING_ID,
    }), expect.anything());
    expect(JSON.stringify(vi.mocked(harness.adapter.preflight).mock.calls)).not.toContain('Implementiere');

    const started = await harness.runtime.start(request());
    expect(started.ok).toBe(true);
    expect(seen).toEqual(['0:running', '1:running']);
    expect(harness.runtime.snapshot(TASK_ID)?.sequence).toBe(1);
  });

  it('deduplicates events, ignores late terminal events, and pins interactive controls', async () => {
    const harness = setup();
    await harness.runtime.start(request());
    harness.emit()?.({
      eventId: 'question-1',
      type: 'input_required',
      requestId: 'input-1',
      prompt: 'Fortfahren?',
    });
    harness.emit()?.({
      eventId: 'question-1',
      type: 'input_required',
      requestId: 'input-1',
      prompt: 'Fortfahren?',
    });
    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({
      status: 'waiting_for_user', sequence: 1,
    });

    expect(await harness.runtime.provideInput(TASK_ID, 'Nein', 'stale-input', 1))
      .toMatchObject({ ok: false, code: 'stale_input_request' });
    expect(await harness.runtime.provideInput(TASK_ID, 'Nein', 'input-1', 0))
      .toMatchObject({ ok: false, code: 'stale_input_request' });
    expect(harness.adapter.provideInput).not.toHaveBeenCalled();
    expect((await harness.runtime.provideInput(TASK_ID, 'Ja', 'input-1', 1)).ok).toBe(true);
    expect(harness.adapter.provideInput).toHaveBeenCalledOnce();
    expect(await harness.runtime.provideInput(TASK_ID, 'Nochmal', 'input-1', 1))
      .toMatchObject({ ok: false, code: 'invalid_state' });
    expect(harness.adapter.provideInput).toHaveBeenCalledOnce();
    harness.emit()?.({ eventId: 'done-1', type: 'completed', summary: 'Fertig.' });
    harness.emit()?.({ eventId: 'late-1', type: 'failed', code: 'late_failure' });
    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({ status: 'completed', sequence: 3 });
  });

  it('reports cancel_requested until the adapter confirms cancellation', async () => {
    const harness = setup();
    await harness.runtime.start(request());
    expect((await harness.runtime.cancel(TASK_ID)).ok).toBe(true);
    expect(harness.runtime.snapshot(TASK_ID)?.status).toBe('cancel_requested');
    expect((await harness.runtime.cancel(TASK_ID)).ok).toBe(true);
    expect(harness.adapter.cancel).toHaveBeenCalledTimes(2);
    harness.emit()?.({ eventId: 'canceled-1', type: 'canceled' });
    expect(harness.runtime.snapshot(TASK_ID)?.status).toBe('canceled');
  });

  it('resumes only a waiting task and records provider failure as terminal', async () => {
    const harness = setup();
    await harness.runtime.start(request());
    harness.emit()?.({
      eventId: 'question-resume',
      type: 'input_required',
      requestId: 'input-resume',
      prompt: 'Freigabe erforderlich.',
    });
    expect((await harness.runtime.resume(TASK_ID, 'input-resume', 1)).ok).toBe(true);
    expect(harness.adapter.resume).toHaveBeenCalledOnce();
    harness.emit()?.({ eventId: 'running-resume', type: 'running' });
    harness.emit()?.({ eventId: 'failure-1', type: 'failed', code: 'provider_failed' });
    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({
      status: 'failed', sequence: 4, terminal: { code: 'provider_failed' },
    });
    expect((await harness.runtime.resume(TASK_ID, 'input-resume', 1)).ok).toBe(false);
  });

  it('rejects stale bindings and enforces per-provider capacity', async () => {
    const harness = setup();
    expect((await harness.runtime.start({ ...request(), bindingRevision: 1 })).ok).toBe(false);
    expect(harness.adapter.start).not.toHaveBeenCalled();
    expect((await harness.runtime.start(request())).ok).toBe(true);
    expect(await harness.runtime.preflight({
      ...request(),
      taskId: '55555555-5555-4555-8555-555555555555',
    })).toMatchObject({ ok: false, code: 'capacity_unavailable' });
  });

  it('rejects a second selection that differs from the consented provider lease', async () => {
    const mismatches: readonly ReturnType<SpecialistBindingResolver>[] = [
      {
        bindingId: BINDING_ID,
        bindingRevision: 2,
        providerId: 'anthropic',
        operationId: 'anthropic_claude_agent',
        connectionId: '44444444-4444-4444-8444-444444444444',
      },
      {
        bindingId: BINDING_ID,
        bindingRevision: 2,
        providerId: 'openai',
        operationId: 'openai_responses_text',
        connectionId: '44444444-4444-4444-8444-444444444444',
      },
      {
        bindingId: BINDING_ID,
        bindingRevision: 2,
        providerId: 'openai',
        operationId: 'openai_codex',
        connectionId: '55555555-5555-4555-8555-555555555555',
      },
    ];

    for (const mismatch of mismatches) {
      const harness = setup({}, undefined, () => mismatch);
      expect(await harness.runtime.start(request())).toMatchObject({
        ok: false, code: 'binding_unavailable',
      });
      expect(harness.adapter.start).not.toHaveBeenCalled();
    }
  });

  it('recognizes a backup-published acceptance instead of reporting an invisible failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-specialist-runtime-fault-'));
    dirs.push(dir);
    const faultedStore = new SpecialistTaskStore(dir, () => { throw new Error('disk'); });
    const harness = setup({}, faultedStore);
    const result = await harness.runtime.start(request());
    expect(result.ok).toBe(true);
    expect(harness.adapter.cancel).not.toHaveBeenCalled();
    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({ status: 'running' });
  });

  it('cancels a provider task that is accepted only after start already timed out', async () => {
    vi.useFakeTimers();
    let resolveAcceptance: ((value: { remoteRef: string; status: 'running' }) => void) | undefined;
    const start = vi.fn<SpecialistTaskAdapter['start']>(() => new Promise((resolve) => {
      resolveAcceptance = resolve;
    }));
    const harness = setup({ start }, undefined, undefined, {
      providerOperationTimeoutMs: 5,
      cleanupTimeoutMs: 5,
    });

    const started = harness.runtime.start(request());
    await vi.advanceTimersByTimeAsync(5);
    await expect(started).resolves.toMatchObject({ ok: false, code: 'adapter_failed' });

    resolveAcceptance?.({ remoteRef: 'late-remote', status: 'running' });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.adapter.cancel).toHaveBeenCalledOnce();
    expect(harness.adapter.cancel).toHaveBeenCalledWith(
      { remoteRef: 'late-remote', status: 'running' },
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('drains a late start acceptance and fully awaits its cancellation during shutdown', async () => {
    let resolveAcceptance: ((value: { remoteRef: string; status: 'running' }) => void) | undefined;
    let resolveCancel: (() => void) | undefined;
    const start = vi.fn<SpecialistTaskAdapter['start']>(() => new Promise((resolve) => {
      resolveAcceptance = resolve;
    }));
    const cancel = vi.fn<SpecialistTaskAdapter['cancel']>(() => new Promise((resolve) => {
      resolveCancel = resolve;
    }));
    const harness = setup({ start, cancel }, undefined, undefined, {
      providerOperationTimeoutMs: 5,
      cleanupTimeoutMs: 50,
      shutdownDrainMs: 50,
    });
    await expect(harness.runtime.start(request())).resolves.toMatchObject({
      ok: false,
      code: 'adapter_failed',
    });

    let shutdownFinished = false;
    const shutdown = harness.runtime.shutdown().then(() => { shutdownFinished = true; });
    resolveAcceptance?.({ remoteRef: 'late-during-shutdown', status: 'running' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(shutdownFinished).toBe(false);

    resolveCancel?.();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  it('rebases one normal store generation race after paid provider acceptance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-specialist-runtime-race-'));
    dirs.push(dir);
    const runtimeStore = new SpecialistTaskStore(dir);
    const competingStore = new SpecialistTaskStore(dir);
    const competingTaskId = '55555555-5555-4555-8555-555555555555';
    const harness = setup({
      start: vi.fn(async () => {
        const observed = competingStore.snapshot();
        competingStore.create({
          taskId: competingTaskId,
          role: 'coding',
          providerId: 'openai',
          operationId: 'openai_codex',
          connectionId: '44444444-4444-4444-8444-444444444444',
          bindingId: BINDING_ID,
          bindingRevision: 2,
          remoteRef: 'competing-remote',
          status: 'running',
          sequence: 0,
          createdAt: '2026-09-05T09:59:00.000Z',
          updatedAt: '2026-09-05T09:59:00.000Z',
          eventIds: [],
          maxTurns: 10,
          turnsUsed: 1,
        }, observed.generation);
        return { remoteRef: 'remote-1', status: 'running' as const };
      }),
    }, runtimeStore);

    expect(await harness.runtime.start(request())).toMatchObject({ ok: true });
    expect(harness.adapter.cancel).not.toHaveBeenCalled();
    expect(new SpecialistTaskStore(dir).snapshot().tasks.map((task) => task.taskId).sort())
      .toEqual([TASK_ID, competingTaskId].sort());
  });

  it('never starts an adapter when the metadata store is not safely writable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-specialist-runtime-degraded-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'specialist-tasks.json'), '{broken', 'utf8');
    fs.writeFileSync(path.join(dir, 'specialist-tasks.json.bak'), '{broken', 'utf8');
    const harness = setup({}, new SpecialistTaskStore(dir));
    expect(await harness.runtime.start(request())).toMatchObject({
      ok: false, code: 'task_record_failed',
    });
    expect(harness.adapter.start).not.toHaveBeenCalled();
  });

  it('awaits shutdown cancellation and persists unresolved active work as incomplete', async () => {
    const harness = setup();
    await harness.runtime.start(request());
    await harness.runtime.shutdown();
    expect(harness.adapter.cancel).toHaveBeenCalledOnce();
    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({
      status: 'incomplete', terminal: { code: 'shutdown_unconfirmed' },
    });
    expect(await harness.runtime.start({
      ...request(),
      taskId: '55555555-5555-4555-8555-555555555555',
    })).toMatchObject({ ok: false, code: 'runtime_stopped' });
    await expect(harness.runtime.destroy()).resolves.toBeUndefined();
  });

  it('keeps a provider-confirmed canceled state during shutdown drain', async () => {
    const harness = setup({
      cancel: vi.fn(async (_task, context) => {
        context.emit({ eventId: 'shutdown-canceled', type: 'canceled' });
      }),
    });
    await harness.runtime.start(request());
    await harness.runtime.shutdown();
    expect(harness.runtime.snapshot(TASK_ID)?.status).toBe('canceled');
  });

  it('consumes a failed input delivery once and records the uncertainty as terminal', async () => {
    const harness = setup({
      provideInput: vi.fn(async () => { throw new Error('ambiguous transport failure'); }),
    });
    await harness.runtime.start(request());
    harness.emit()?.({
      eventId: 'question-failure',
      type: 'input_required',
      requestId: 'input-failure',
      prompt: 'Antwort?',
    });

    expect(await harness.runtime.provideInput(TASK_ID, 'Antwort', 'input-failure', 1))
      .toMatchObject({ ok: false, code: 'adapter_failed' });
    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({
      status: 'incomplete', terminal: { code: 'control_delivery_unknown' },
    });
    expect(await harness.runtime.provideInput(TASK_ID, 'Antwort', 'input-failure', 1))
      .toMatchObject({ ok: false, code: 'invalid_state' });
    expect(harness.adapter.provideInput).toHaveBeenCalledOnce();
    expect(harness.adapter.cancel).toHaveBeenCalledOnce();
  });

  it('preserves provider-confirmed cancellation after a consumed resume fails', async () => {
    const harness = setup({
      resume: vi.fn(async () => { throw new Error('ambiguous resume failure'); }),
      cancel: vi.fn(async (_task, context) => {
        context.emit({ eventId: 'provider-canceled-after-resume', type: 'canceled' });
      }),
    });
    await harness.runtime.start(request());
    harness.emit()?.({
      eventId: 'question-resume-cancel',
      type: 'input_required',
      requestId: 'input-resume-cancel',
      prompt: 'Fortfahren?',
    });

    expect(await harness.runtime.resume(TASK_ID, 'input-resume-cancel', 1))
      .toMatchObject({ ok: false, code: 'adapter_failed' });
    expect(harness.adapter.cancel).toHaveBeenCalledOnce();
    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({ status: 'canceled' });
  });

  it('delivers consumed input when its local transition was backup-published ambiguously', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-specialist-control-fault-'));
    dirs.push(dir);
    let failPublish = false;
    const store = new SpecialistTaskStore(dir, () => {
      if (failPublish) throw new Error('simulated publish interruption');
    });
    const harness = setup({}, store);
    await harness.runtime.start(request());
    harness.emit()?.({
      eventId: 'question-atomic',
      type: 'input_required',
      requestId: 'input-atomic',
      prompt: 'Antwort?',
    });
    failPublish = true;

    expect(await harness.runtime.provideInput(TASK_ID, 'Ja', 'input-atomic', 1))
      .toMatchObject({ ok: true });
    expect(harness.adapter.provideInput).toHaveBeenCalledOnce();
    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({ status: 'running', sequence: 2 });
  });

  it('blocks controls synchronously once shutdown starts', async () => {
    const harness = setup();
    await harness.runtime.start(request());
    harness.emit()?.({
      eventId: 'question-shutdown',
      type: 'input_required',
      requestId: 'input-shutdown',
      prompt: 'Antwort?',
    });
    const shutdown = harness.runtime.shutdown();
    expect(harness.runtime.isAcceptingControls()).toBe(false);
    expect(await harness.runtime.resume(TASK_ID, 'input-shutdown', 1))
      .toMatchObject({ ok: false, code: 'runtime_stopped' });
    await shutdown;
  });

  it('aborts hanging preflight and start operations synchronously during shutdown', async () => {
    let preflightSignal: AbortSignal | undefined;
    const preflightHarness = setup({
      preflight: vi.fn((_binding, signal) => {
        preflightSignal = signal;
        return new Promise(() => undefined);
      }),
    });
    const preflight = preflightHarness.runtime.preflight(request());
    await vi.waitFor(() => expect(preflightSignal).toBeDefined());
    const preflightShutdown = preflightHarness.runtime.shutdown();
    expect(preflightSignal?.aborted).toBe(true);
    await expect(preflight).resolves.toMatchObject({ ok: false, code: 'preflight_failed' });
    await expect(preflightShutdown).resolves.toBeUndefined();

    let startSignal: AbortSignal | undefined;
    const startHarness = setup({
      start: vi.fn((_task, _context, signal) => {
        startSignal = signal;
        return new Promise(() => undefined);
      }),
    });
    const started = startHarness.runtime.start(request());
    await vi.waitFor(() => expect(startSignal).toBeDefined());
    const startShutdown = startHarness.runtime.shutdown();
    expect(startSignal?.aborted).toBe(true);
    await expect(started).resolves.toMatchObject({ ok: false, code: 'adapter_failed' });
    await expect(startShutdown).resolves.toBeUndefined();
  });

  it('releases hanging control and cancel calls so shutdown can finish', async () => {
    let controlSignal: AbortSignal | undefined;
    const controlHarness = setup({
      provideInput: vi.fn((_task, _input, _context, signal) => {
        controlSignal = signal;
        return new Promise(() => undefined);
      }),
    });
    await controlHarness.runtime.start(request());
    controlHarness.emit()?.({
      eventId: 'question-hanging-control',
      type: 'input_required',
      requestId: 'input-hanging-control',
      prompt: 'Antwort?',
    });
    const controlled = controlHarness.runtime.provideInput(
      TASK_ID,
      'Ja',
      'input-hanging-control',
      1,
    );
    await vi.waitFor(() => expect(controlSignal).toBeDefined());
    const controlShutdown = controlHarness.runtime.shutdown();
    expect(controlSignal?.aborted).toBe(true);
    await expect(controlled).resolves.toMatchObject({ ok: false, code: 'adapter_failed' });
    await expect(controlShutdown).resolves.toBeUndefined();

    let cancelSignal: AbortSignal | undefined;
    const cancelHarness = setup({
      cancel: vi.fn((_task, _context, signal) => {
        cancelSignal = signal;
        return new Promise(() => undefined);
      }),
    });
    await cancelHarness.runtime.start(request());
    const canceled = cancelHarness.runtime.cancel(TASK_ID);
    await vi.waitFor(() => expect(cancelSignal).toBeDefined());
    const cancelShutdown = cancelHarness.runtime.shutdown();
    expect(cancelSignal?.aborted).toBe(true);
    await expect(canceled).resolves.toMatchObject({ ok: false, code: 'adapter_failed' });
    await expect(cancelShutdown).resolves.toBeUndefined();
  });

  it('persists the confirmed deadline and terminates the task when it expires', async () => {
    vi.useFakeTimers();
    const harness = setup();
    expect(await harness.runtime.start({
      ...request(),
      budget: { maxTurns: 10, timeoutMs: 1_000 },
    })).toMatchObject({ ok: true });
    expect(new SpecialistTaskStore(harness.dir).snapshot().tasks[0]?.deadlineAt)
      .toBe('2026-09-05T10:00:01.000Z');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({
      status: 'incomplete',
      terminal: { code: 'task_deadline_exceeded' },
    });
    expect(harness.adapter.cancel).toHaveBeenCalledOnce();
  });

  it('uses an opaque local event id that never contains the provider request id', async () => {
    const harness = setup();
    await harness.runtime.start(request());
    harness.emit()?.({
      eventId: 'provider-question-event',
      type: 'input_required',
      requestId: 'provider-request-sensitive',
      prompt: 'Antwort?',
    });
    await harness.runtime.provideInput(TASK_ID, 'Ja', 'provider-request-sensitive', 1);

    const lastEventId = new SpecialistTaskStore(harness.dir).snapshot()
      .tasks[0]?.eventIds.at(-1);
    expect(lastEventId).toMatch(/^local-provideInput-[0-9a-f-]{36}$/u);
    expect(lastEventId).not.toContain('provider-request-sensitive');
  });

  it('counts the initial start and each consumed user continuation exactly once', async () => {
    const harness = setup();
    await harness.runtime.start({
      ...request(),
      budget: { maxTurns: 3, timeoutMs: 60_000 },
    });
    expect(new SpecialistTaskStore(harness.dir).snapshot().tasks[0]).toMatchObject({
      maxTurns: 3,
      turnsUsed: 1,
    });
    harness.emit()?.({
      eventId: 'question-turn-two',
      type: 'input_required',
      requestId: 'input-turn-two',
      prompt: 'Antwort?',
    });

    expect(await harness.runtime.provideInput(TASK_ID, 'Ja', 'input-turn-two', 1))
      .toMatchObject({ ok: true });
    expect(new SpecialistTaskStore(harness.dir).snapshot().tasks[0]?.turnsUsed).toBe(2);
  });

  it('fails closed without contacting the provider when the confirmed turn budget is exhausted', async () => {
    const harness = setup();
    await harness.runtime.start({
      ...request(),
      budget: { maxTurns: 1, timeoutMs: 60_000 },
    });
    harness.emit()?.({
      eventId: 'question-over-budget',
      type: 'input_required',
      requestId: 'input-over-budget',
      prompt: 'Noch ein Turn?',
    });

    expect(await harness.runtime.resume(TASK_ID, 'input-over-budget', 1))
      .toMatchObject({ ok: false, code: 'invalid_state' });
    expect(harness.adapter.resume).not.toHaveBeenCalled();
    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({
      status: 'incomplete',
      terminal: { code: 'turn_budget_exhausted' },
    });
    expect(new SpecialistTaskStore(harness.dir).snapshot().tasks[0]).toMatchObject({
      maxTurns: 1,
      turnsUsed: 1,
    });
  });

  it('passes the persisted turn budget to the adapter after restart', async () => {
    const first = setup();
    await first.runtime.start({
      ...request(),
      budget: { maxTurns: 3, timeoutMs: 60_000 },
    });
    first.emit()?.({
      eventId: 'question-before-restart',
      type: 'input_required',
      requestId: 'input-before-restart',
      prompt: 'Antwort?',
    });
    await first.runtime.resume(TASK_ID, 'input-before-restart', 1);

    const retrieve = vi.fn<NonNullable<SpecialistTaskAdapter['retrieve']>>(
      async () => ({ eventId: 'running-after-restart', type: 'running' }),
    );
    const second = setup({ retrieve }, new SpecialistTaskStore(first.dir));
    await second.runtime.reconcile();

    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 3, turnsUsed: 2 }),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(new SpecialistTaskStore(first.dir).snapshot().tasks[0]?.turnsUsed).toBe(2);
  });

  it('fails closed at the hard event limit without forgetting any earlier event id', async () => {
    const harness = setup();
    await harness.runtime.start(request());
    for (let index = 0; index < MAX_SPECIALIST_EVENT_IDS; index += 1) {
      harness.emit()?.({
        eventId: `provider-progress-${index}`,
        type: 'progress',
        message: `Fortschritt ${index}`,
      });
    }

    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({
      status: 'incomplete',
      terminal: { code: 'event_limit_exceeded' },
    });
    const eventIds = new SpecialistTaskStore(harness.dir).snapshot().tasks[0]?.eventIds;
    expect(eventIds).toHaveLength(MAX_SPECIALIST_EVENT_IDS);
    expect(eventIds).toContain('provider-progress-0');
    expect(eventIds).toContain(`provider-progress-${MAX_SPECIALIST_EVENT_IDS - 1}`);
  }, 15_000);

  it('uses a fresh bounded cleanup signal when an invalid acceptance must be canceled', async () => {
    const caller = new AbortController();
    const cancel = vi.fn<SpecialistTaskAdapter['cancel']>(async (_task, _context, signal) => {
      caller.abort();
      expect(signal?.aborted).toBe(false);
    });
    const harness = setup({
      start: vi.fn(async () => ({ remoteRef: 'not an opaque id', status: 'running' as const })),
      cancel,
    });

    expect(await harness.runtime.start(request(), caller.signal)).toMatchObject({
      ok: false, code: 'adapter_failed',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel.mock.calls[0]?.[2]).not.toBe(caller.signal);
  });

  it('removes pruned terminal tasks from both disk and the live snapshot map', async () => {
    const harness = setup();
    await harness.runtime.start(request());
    harness.emit()?.({ eventId: 'done-prune', type: 'completed' });
    const second = {
      ...request(),
      taskId: '55555555-5555-4555-8555-555555555555',
    };
    const pruningRuntime = new SpecialistRuntimeService({
      store: new SpecialistTaskStore(harness.dir),
      adapters: [harness.adapter],
      resolveBinding: () => ({
        bindingId: BINDING_ID,
        bindingRevision: 2,
        providerId: 'openai',
        operationId: 'openai_codex',
        connectionId: '44444444-4444-4444-8444-444444444444',
      }),
      resolveCredential: () => 'secret-key',
      now: () => Date.parse('2026-09-05T10:00:00.000Z'),
      terminalRetentionCount: 0,
      shutdownDrainMs: 0,
    });
    await pruningRuntime.reconcile();
    expect(pruningRuntime.snapshot(TASK_ID)?.status).toBe('completed');
    expect((await pruningRuntime.start(second)).ok).toBe(true);
    expect(pruningRuntime.snapshot(TASK_ID)).toBeNull();
    expect(new SpecialistTaskStore(harness.dir).snapshot().tasks.map((task) => task.taskId))
      .toEqual([second.taskId]);
  });

  it('reconciles only by retrieve and marks unavailable retrieval incomplete', async () => {
    const first = setup();
    await first.runtime.start(request());
    const persisted = new SpecialistTaskStore(first.dir);
    const second = setup({}, persisted);
    await second.runtime.reconcile();
    await second.runtime.reconcile();
    expect(second.adapter.retrieve).toHaveBeenCalledTimes(2);
    expect(second.adapter.start).not.toHaveBeenCalled();
    expect(second.adapter.resume).not.toHaveBeenCalled();
    expect(second.runtime.snapshot(TASK_ID)).toMatchObject({ status: 'running', sequence: 1 });

    const third = setup({ retrieve: undefined }, persisted);
    await third.runtime.reconcile();
    expect(third.adapter.start).not.toHaveBeenCalled();
    expect(third.adapter.resume).not.toHaveBeenCalled();
    expect(third.runtime.snapshot(TASK_ID)?.status).toBe('incomplete');
  });

  it('deduplicates a replayed provider event after runtime restart', async () => {
    const first = setup();
    await first.runtime.start(request());
    first.emit()?.({ eventId: 'provider-replay-event', type: 'progress', message: 'Einmal.' });
    expect(first.runtime.snapshot(TASK_ID)?.sequence).toBe(1);

    const persisted = new SpecialistTaskStore(first.dir);
    const second = setup({
      retrieve: vi.fn(async () => ({
        eventId: 'provider-replay-event',
        type: 'progress' as const,
        message: 'Doppelt.',
      })),
    }, persisted);
    await second.runtime.reconcile();

    expect(second.runtime.snapshot(TASK_ID)?.sequence).toBe(1);
    expect(second.runtime.snapshot(TASK_ID)?.progressMessage).toBeUndefined();
    expect(persisted.snapshot().tasks[0]?.eventIds).toEqual(['provider-replay-event']);
  });

  it('does not expose a restarted waiting task when retrieve cannot rebuild its input request', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-specialist-runtime-waiting-'));
    dirs.push(dir);
    const store = new SpecialistTaskStore(dir);
    store.create({
      taskId: TASK_ID,
      role: 'coding',
      providerId: 'openai',
      operationId: 'openai_codex',
      connectionId: '44444444-4444-4444-8444-444444444444',
      bindingId: BINDING_ID,
      bindingRevision: 2,
      remoteRef: 'remote-waiting',
      status: 'waiting_for_user',
      sequence: 4,
      createdAt: '2026-09-05T09:00:00.000Z',
      updatedAt: '2026-09-05T09:30:00.000Z',
      eventIds: [],
      maxTurns: 10,
      turnsUsed: 1,
    }, 0);
    const harness = setup({ retrieve: vi.fn(async () => null) }, new SpecialistTaskStore(dir));

    await harness.runtime.reconcile();

    expect(harness.runtime.snapshot(TASK_ID)).toMatchObject({
      status: 'incomplete',
      terminal: { code: 'input_request_unavailable' },
    });
  });
});
