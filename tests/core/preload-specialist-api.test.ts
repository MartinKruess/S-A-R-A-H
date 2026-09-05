import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SarahApi } from '../../src/core/sarah-api.js';

const electronMock = vi.hoisted(() => {
  const exposed: { value: object | null } = { value: null };
  return {
    exposed,
    invoke: vi.fn(async () => ({})),
    on: vi.fn(),
    removeListener: vi.fn(),
    exposeInMainWorld: vi.fn((_key: string, value: object) => { exposed.value = value; }),
  };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMock.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    once: vi.fn(),
    removeListener: electronMock.removeListener,
    send: vi.fn(),
  },
}));

describe('specialist preload API', () => {
  beforeAll(async () => {
    await import('../../src/preload.js');
  });

  it('exposes list and provider-neutral task controls unchanged', async () => {
    const api = electronMock.exposed.value as SarahApi;
    const task = { taskId: '11111111-1111-4111-8111-111111111111' };
    const answer = {
      ...task,
      requestId: 'question-1',
      expectedSequence: 2,
      input: 'src/main.ts',
    };
    const resume = { ...task, requestId: 'question-1', expectedSequence: 2 };

    electronMock.invoke.mockClear();
    await api.specialists.list();
    await api.specialists.provideInput(answer);
    await api.specialists.resume(resume);
    await api.specialists.cancel(task);

    expect(electronMock.invoke.mock.calls).toEqual([
      ['specialist-tasks-list'],
      ['specialist-task-provide-input', answer],
      ['specialist-task-resume', resume],
      ['specialist-task-cancel', task],
    ]);
  });

  it('exposes a removable specialist state listener', () => {
    const api = electronMock.exposed.value as SarahApi;
    const callback = vi.fn();
    const remove = api.specialists.onStateChange(callback);
    const handler = electronMock.on.mock.calls.find(([channel]) => channel === 'specialist:state')?.[1];
    const snapshot = {
      taskId: '11111111-1111-4111-8111-111111111111',
      role: 'coding',
      status: 'running',
      sequence: 1,
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:01:00.000Z',
    };

    handler?.({}, snapshot);
    expect(callback).toHaveBeenCalledWith(snapshot);
    remove();
    expect(electronMock.removeListener).toHaveBeenCalledWith('specialist:state', handler);
  });
});
