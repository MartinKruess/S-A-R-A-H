import { describe, expect, it } from 'vitest';
import {
  AcceptedSpecialistTaskMetadataSchema,
  applySpecialistTaskEvent,
  createSpecialistTaskSnapshot,
  SpecialistTaskRequestSchema,
} from '../../src/core/specialist-task.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

describe('specialist task contracts', () => {
  it('accepts a bounded coding request with an exact provider lease and rejects mismatches', () => {
    const request = {
      taskId: TASK_ID,
      role: 'coding',
      goal: 'Implementiere TTS in Sarah.',
      sourceTurnId: 'turn-1',
      planId: '22222222-2222-4222-8222-222222222222',
      planRevision: 1,
      planFingerprint: 'a'.repeat(64),
      stepId: 'step-1',
      providerId: 'openai',
      operationId: 'openai_codex',
      connectionId: '44444444-4444-4444-8444-444444444444',
      bindingId: '33333333-3333-4333-8333-333333333333',
      bindingRevision: 4,
      privateContext: false,
      originMode: 'chat',
      dataEgress: ['goal'],
      accessMode: 'none',
      budget: { maxTurns: 10, timeoutMs: 60_000 },
    } as const;

    expect(SpecialistTaskRequestSchema.safeParse(request).success).toBe(true);
    expect(SpecialistTaskRequestSchema.safeParse({ ...request, privateContext: true }).success)
      .toBe(false);
    expect(SpecialistTaskRequestSchema.safeParse({ ...request, providerId: 'perplexity' }).success)
      .toBe(false);
  });

  it('enforces symmetric workspace-reference and workspace-egress invariants', () => {
    const request = {
      taskId: TASK_ID,
      role: 'coding' as const,
      goal: 'Implementiere TTS in Sarah.',
      sourceTurnId: 'turn-1',
      planId: '22222222-2222-4222-8222-222222222222',
      planRevision: 1,
      planFingerprint: 'a'.repeat(64),
      stepId: 'step-1',
      providerId: 'openai' as const,
      operationId: 'openai_codex' as const,
      connectionId: '44444444-4444-4444-8444-444444444444',
      bindingId: '33333333-3333-4333-8333-333333333333',
      bindingRevision: 4,
      privateContext: false as const,
      originMode: 'chat' as const,
      dataEgress: ['goal'] as readonly ('goal' | 'workspace_files')[],
      workspaceReference: 'workspace-sarah',
      accessMode: 'read_only' as const,
      budget: { maxTurns: 10, timeoutMs: 60_000 },
    };

    expect(SpecialistTaskRequestSchema.safeParse({
      ...request, workspaceReference: undefined,
    }).success).toBe(false);
    expect(SpecialistTaskRequestSchema.safeParse({
      ...request, workspaceReference: undefined, accessMode: 'none',
      dataEgress: ['goal', 'workspace_files'],
    }).success).toBe(false);
    expect(SpecialistTaskRequestSchema.safeParse({
      ...request, accessMode: 'none', dataEgress: ['goal', 'workspace_files'],
    }).success).toBe(false);
    expect(SpecialistTaskRequestSchema.safeParse({
      ...request, dataEgress: ['goal', 'workspace_files'],
    }).success).toBe(true);
  });

  it('enforces provider-confirmed transitions and monotonic application sequences', () => {
    let snapshot = createSpecialistTaskSnapshot({
      taskId: TASK_ID,
      role: 'research',
      status: 'running',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    });
    snapshot = applySpecialistTaskEvent(snapshot, {
      eventId: 'question-1',
      type: 'input_required',
      requestId: 'request-1',
      prompt: 'Soll nur in offiziellen Quellen gesucht werden?',
    }, '2026-09-05T10:01:00.000Z');
    expect(snapshot).toMatchObject({ status: 'waiting_for_user', sequence: 1 });

    snapshot = applySpecialistTaskEvent(snapshot, {
      eventId: 'running-1',
      type: 'running',
    }, '2026-09-05T10:02:00.000Z');
    expect(snapshot).toMatchObject({ status: 'running', sequence: 2 });

    snapshot = applySpecialistTaskEvent(snapshot, {
      eventId: 'done-1',
      type: 'completed',
      summary: 'Recherche abgeschlossen.',
    }, '2026-09-05T10:03:00.000Z');
    expect(snapshot).toMatchObject({ status: 'completed', sequence: 3 });
    expect(() => applySpecialistTaskEvent(snapshot, {
      eventId: 'late-1',
      type: 'progress',
      message: 'Zu spät.',
    }, '2026-09-05T10:04:00.000Z')).toThrow(/terminal/u);
  });

  it('keeps cancellation requested distinct from provider-confirmed cancellation', () => {
    const running = createSpecialistTaskSnapshot({
      taskId: TASK_ID,
      role: 'coding',
      status: 'running',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    });
    const requested = applySpecialistTaskEvent(running, {
      eventId: 'cancel-local',
      type: 'cancel_requested',
    }, '2026-09-05T10:01:00.000Z');
    expect(requested.status).toBe('cancel_requested');
    const canceled = applySpecialistTaskEvent(requested, {
      eventId: 'cancel-provider',
      type: 'canceled',
    }, '2026-09-05T10:02:00.000Z');
    expect(canceled.status).toBe('canceled');
  });

  it('requires an input request while waiting and preserves it across progress', () => {
    expect(() => createSpecialistTaskSnapshot({
      taskId: TASK_ID,
      role: 'coding',
      status: 'waiting_for_user',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    })).toThrow();
    const waiting = createSpecialistTaskSnapshot({
      taskId: TASK_ID,
      role: 'coding',
      status: 'waiting_for_user',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
      inputRequest: { requestId: 'request-1', prompt: 'Fortfahren?' },
    });
    expect(applySpecialistTaskEvent(waiting, {
      eventId: 'progress-waiting', type: 'progress', message: 'Warte auf Antwort.',
    }, '2026-09-05T10:01:00.000Z')).toMatchObject({
      status: 'waiting_for_user',
      inputRequest: { requestId: 'request-1', prompt: 'Fortfahren?' },
    });
  });

  it('accepts only bounded opaque remote references in durable metadata', () => {
    const metadata = {
      taskId: TASK_ID,
      role: 'coding',
      providerId: 'openai',
      operationId: 'openai_codex',
      connectionId: '44444444-4444-4444-8444-444444444444',
      bindingId: '33333333-3333-4333-8333-333333333333',
      bindingRevision: 1,
      remoteRef: 'thread_abc-123:run.4',
      status: 'running',
      sequence: 0,
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
      eventIds: [],
      maxTurns: 10,
      turnsUsed: 1,
    } as const;
    expect(AcceptedSpecialistTaskMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(AcceptedSpecialistTaskMetadataSchema.safeParse({
      ...metadata, remoteRef: 'https://provider.test/tasks/123',
    }).success).toBe(false);
    expect(AcceptedSpecialistTaskMetadataSchema.safeParse({
      ...metadata, remoteRef: 'remote task 123',
    }).success).toBe(false);
  });
});
