import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SpecialistTaskStore,
  SpecialistTaskStoreConflictError,
  SpecialistTaskStoreDegradedError,
} from '../../../src/services/specialists/specialist-task-store.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-specialist-store-'));
  dirs.push(dir);
  return dir;
}

function accepted(taskId = '11111111-1111-4111-8111-111111111111') {
  return {
    taskId,
    role: 'coding' as const,
    providerId: 'openai' as const,
    operationId: 'openai_codex' as const,
    connectionId: '22222222-2222-4222-8222-222222222222',
    bindingId: '33333333-3333-4333-8333-333333333333',
    bindingRevision: 2,
    remoteRef: 'remote-thread-1',
    status: 'running' as const,
    sequence: 0,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    eventIds: [],
    maxTurns: 10,
    turnsUsed: 1,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SpecialistTaskStore', () => {
  it('persists only accepted metadata and recovers the newest valid backup', () => {
    const dir = tempDir();
    const interrupted = new SpecialistTaskStore(dir, (point) => {
      if (point === 'after-backup-publish') throw new Error('simulated crash');
    });
    expect(() => interrupted.create(accepted(), 0)).toThrow();

    const recovered = new SpecialistTaskStore(dir);
    expect(recovered.snapshot().tasks).toEqual([accepted()]);
    expect(recovered.getStatus().state).toBe('recovered');
    expect(interrupted.publicationState(accepted())).toBe('published');
    const raw = fs.readFileSync(path.join(dir, 'specialist-tasks.json.bak'), 'utf8');
    expect(raw).not.toMatch(/Implementiere|prompt|answer|workspace|api.?key/iu);
  });

  it('prunes expired and excess terminal metadata without deleting active tasks', () => {
    const dir = tempDir();
    const store = new SpecialistTaskStore(dir);
    let snapshot = store.create({
      ...accepted('11111111-1111-4111-8111-111111111111'),
      status: 'completed',
      updatedAt: '2026-07-01T10:00:00.000Z',
    }, 0);
    snapshot = store.create({
      ...accepted('22222222-2222-4222-8222-222222222222'),
      status: 'completed',
      updatedAt: '2026-09-04T10:00:00.000Z',
    }, snapshot.generation);
    snapshot = store.create({
      ...accepted('33333333-3333-4333-8333-333333333333'),
      status: 'failed',
      updatedAt: '2026-09-03T10:00:00.000Z',
    }, snapshot.generation);
    snapshot = store.create({
      ...accepted('44444444-4444-4444-8444-444444444444'),
      status: 'running',
      updatedAt: '2026-07-01T10:00:00.000Z',
    }, snapshot.generation);

    const pruned = store.pruneTerminal('2026-08-01T00:00:00.000Z', 1, snapshot.generation);
    expect(pruned.tasks.map((task) => task.taskId)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '44444444-4444-4444-8444-444444444444',
    ]);
  });

  it('rejects stale generations and fails closed when both copies are corrupt', () => {
    const dir = tempDir();
    const store = new SpecialistTaskStore(dir);
    const first = store.create(accepted(), 0);
    expect(() => store.update({ ...accepted(), status: 'completed', sequence: 1 }, 0))
      .toThrow(SpecialistTaskStoreConflictError);

    fs.writeFileSync(path.join(dir, 'specialist-tasks.json'), '{broken', 'utf8');
    fs.writeFileSync(path.join(dir, 'specialist-tasks.json.bak'), '{broken', 'utf8');
    const degraded = new SpecialistTaskStore(dir);
    expect(degraded.getStatus().state).toBe('degraded');
    expect(() => degraded.update({ ...accepted(), status: 'completed', sequence: 1 }, first.generation))
      .toThrow(SpecialistTaskStoreDegradedError);
  });

  it('keeps maxTurns immutable and turnsUsed monotonic', () => {
    const store = new SpecialistTaskStore(tempDir());
    const created = store.create(accepted(), 0);
    const advanced = store.update({
      ...accepted(),
      sequence: 1,
      eventIds: ['event-1'],
      turnsUsed: 2,
    }, created.generation);

    expect(() => store.update({
      ...accepted(),
      sequence: 2,
      eventIds: ['event-1', 'event-2'],
      maxTurns: 11,
      turnsUsed: 2,
    }, advanced.generation)).toThrow();
    expect(() => store.update({
      ...accepted(),
      sequence: 2,
      eventIds: ['event-1', 'event-2'],
      turnsUsed: 1,
    }, advanced.generation)).toThrow();
  });
});
