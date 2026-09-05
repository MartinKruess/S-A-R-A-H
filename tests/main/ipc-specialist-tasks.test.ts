import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { SpecialistTaskSnapshot } from '../../src/core/specialist-task.js';
import { registerSpecialistTaskHandlers } from '../../src/main/ipc-specialist-tasks.js';
import type { SpecialistRuntimeService } from '../../src/services/specialists/specialist-runtime-service.js';

type Handler = (event: object | null, input?: unknown) => unknown;

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT: SpecialistTaskSnapshot = {
  taskId: TASK_ID,
  role: 'coding',
  status: 'waiting_for_user',
  sequence: 2,
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:01:00.000Z',
  inputRequest: { requestId: 'question-1', prompt: 'Welche Datei soll ich ändern?' },
};

function setup(overrides: Partial<SpecialistRuntimeService> = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  } as unknown as IpcMain;
  const runtime = {
    snapshots: vi.fn(() => [SNAPSHOT]),
    snapshot: vi.fn(() => SNAPSHOT),
    isAcceptingControls: vi.fn(() => true),
    provideInput: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
    resume: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
    cancel: vi.fn(async () => ({
      ok: true,
      snapshot: { ...SNAPSHOT, status: 'cancel_requested', inputRequest: undefined },
    })),
    ...overrides,
  } as unknown as SpecialistRuntimeService;
  registerSpecialistTaskHandlers(ipcMain, { getRuntime: () => runtime });
  return { handlers, runtime };
}

describe('registerSpecialistTaskHandlers', () => {
  it('registers the fixed provider-neutral task channels and validates list output', () => {
    const { handlers } = setup();

    expect([...handlers.keys()]).toEqual([
      'specialist-tasks-list',
      'specialist-task-provide-input',
      'specialist-task-resume',
      'specialist-task-cancel',
    ]);
    expect(handlers.get('specialist-tasks-list')!(null)).toEqual([SNAPSHOT]);
  });

  it('binds provided input to the current exact request before delegating', async () => {
    const { handlers, runtime } = setup();
    const input = {
      taskId: TASK_ID,
      requestId: 'question-1',
      expectedSequence: 2,
      input: '  src/main.ts  ',
    };

    await expect(handlers.get('specialist-task-provide-input')!(null, input)).resolves.toEqual({
      ok: true,
      snapshot: SNAPSHOT,
    });
    expect(runtime.provideInput).toHaveBeenCalledWith(TASK_ID, 'src/main.ts', 'question-1', 2);
  });

  it('rejects stale or forged input requests without delegating', async () => {
    const { handlers, runtime } = setup();

    expect(handlers.get('specialist-task-provide-input')!(null, {
      taskId: TASK_ID,
      requestId: 'old-question',
      expectedSequence: 2,
      input: 'Antwort',
    })).toMatchObject({ ok: false, code: 'stale_input_request' });
    expect(handlers.get('specialist-task-provide-input')!(null, {
      taskId: TASK_ID,
      requestId: 'question-1',
      expectedSequence: 2,
      input: 'Antwort',
      providerId: 'openai',
    })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(runtime.provideInput).not.toHaveBeenCalled();
  });

  it('delegates resume and cancel with validated task IDs', async () => {
    const { handlers, runtime } = setup();
    const input = { taskId: TASK_ID };
    const resumeInput = { taskId: TASK_ID, requestId: 'question-1', expectedSequence: 2 };

    await expect(handlers.get('specialist-task-resume')!(null, resumeInput)).resolves.toMatchObject({ ok: true });
    await expect(handlers.get('specialist-task-cancel')!(null, input)).resolves.toMatchObject({ ok: true });
    expect(runtime.resume).toHaveBeenCalledWith(TASK_ID, 'question-1', 2);
    expect(runtime.cancel).toHaveBeenCalledWith(TASK_ID);
  });

  it('maps invalid inputs, thrown errors and malformed results to stable safe failures', async () => {
    const secret = 'secret-provider-detail';
    const { handlers, runtime } = setup({
      resume: vi.fn(async () => { throw new Error(secret); }),
      cancel: vi.fn(async () => ({ ok: true, snapshot: { ...SNAPSHOT, providerId: secret } })),
    } as Partial<SpecialistRuntimeService>);

    expect(handlers.get('specialist-task-resume')!(null, { taskId: '../task' }))
      .toMatchObject({ ok: false, code: 'invalid_input' });
    const thrown = await handlers.get('specialist-task-resume')!(null, {
      taskId: TASK_ID,
      requestId: 'question-1',
      expectedSequence: 2,
    });
    const malformed = await handlers.get('specialist-task-cancel')!(null, { taskId: TASK_ID });
    expect(thrown).toMatchObject({ ok: false, code: 'operation_failed' });
    expect(malformed).toMatchObject({ ok: false, code: 'operation_failed' });
    expect(JSON.stringify([thrown, malformed])).not.toContain(secret);
    expect(runtime.resume).toHaveBeenCalledOnce();
  });

  it('rejects every external control as soon as application shutdown begins', async () => {
    const handlers = new Map<string, Handler>();
    const ipcMain = {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    } as unknown as IpcMain;
    const runtime = setup().runtime;
    registerSpecialistTaskHandlers(ipcMain, {
      getRuntime: () => runtime,
      isShuttingDown: () => true,
    });

    const reply = {
      taskId: TASK_ID,
      requestId: 'question-1',
      expectedSequence: 2,
      input: 'Antwort',
    };
    const resume = { taskId: TASK_ID, requestId: 'question-1', expectedSequence: 2 };
    expect(handlers.get('specialist-task-provide-input')!(null, reply))
      .toMatchObject({ ok: false, code: 'runtime_stopped' });
    expect(handlers.get('specialist-task-resume')!(null, resume))
      .toMatchObject({ ok: false, code: 'runtime_stopped' });
    expect(handlers.get('specialist-task-cancel')!(null, { taskId: TASK_ID }))
      .toMatchObject({ ok: false, code: 'runtime_stopped' });
    expect(runtime.provideInput).not.toHaveBeenCalled();
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it('rejects a list snapshot containing private provider details', () => {
    const { handlers } = setup({
      snapshots: vi.fn(() => [{ ...SNAPSHOT, providerId: 'openai' }]),
    } as Partial<SpecialistRuntimeService>);

    expect(() => handlers.get('specialist-tasks-list')!(null)).toThrow(
      'Die Spezialistenaufträge konnten nicht sicher geladen werden.',
    );
  });

  it('blocks every mutating control as soon as runtime shutdown begins', async () => {
    const { handlers, runtime } = setup({
      isAcceptingControls: vi.fn(() => false),
    } as Partial<SpecialistRuntimeService>);

    const inputResult = await handlers.get('specialist-task-provide-input')!(null, {
      taskId: TASK_ID,
      requestId: 'question-1',
      expectedSequence: 2,
      input: 'Antwort',
    });
    const resumeResult = await handlers.get('specialist-task-resume')!(null, {
      taskId: TASK_ID,
      requestId: 'question-1',
      expectedSequence: 2,
    });
    const cancelResult = await handlers.get('specialist-task-cancel')!(null, { taskId: TASK_ID });

    expect([inputResult, resumeResult, cancelResult]).toEqual([
      expect.objectContaining({ ok: false, code: 'runtime_stopped' }),
      expect.objectContaining({ ok: false, code: 'runtime_stopped' }),
      expect.objectContaining({ ok: false, code: 'runtime_stopped' }),
    ]);
    expect(runtime.provideInput).not.toHaveBeenCalled();
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
  });
});
