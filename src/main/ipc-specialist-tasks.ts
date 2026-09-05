import type { IpcMain } from 'electron';
import {
  SpecialistTaskControlResultSchema,
  SpecialistTaskIdInputSchema,
  SpecialistTaskListSchema,
  SpecialistTaskProvideInputSchema,
  SpecialistTaskResumeInputSchema,
  type SpecialistTaskControlResult,
} from '../core/specialist-task-ipc.js';
import { SpecialistTaskSnapshotSchema } from '../core/specialist-task.js';
import type {
  SpecialistRuntimeErrorCode,
  SpecialistRuntimeResult,
  SpecialistRuntimeService,
} from '../services/specialists/specialist-runtime-service.js';

const ERROR_MESSAGES = Object.freeze({
  invalid_input: 'Die Angaben für den Spezialistenauftrag sind ungültig.',
  stale_input_request: 'Diese Rückfrage ist nicht mehr aktuell.',
  binding_unavailable: 'Für diesen Spezialisten ist keine aktuelle Verbindung verfügbar.',
  adapter_unavailable: 'Der benötigte Spezialistenadapter ist nicht verfügbar.',
  capacity_unavailable: 'Der Spezialist ist momentan ausgelastet.',
  preflight_failed: 'Der Spezialistenauftrag konnte nicht sicher vorbereitet werden.',
  task_not_found: 'Der Spezialistenauftrag wurde nicht gefunden.',
  invalid_state: 'Der Spezialistenauftrag kann in seinem aktuellen Zustand nicht geändert werden.',
  task_record_failed: 'Der Status des Spezialistenauftrags konnte nicht sicher gespeichert werden.',
  adapter_failed: 'Der Spezialist konnte den Auftrag nicht sicher ändern.',
  runtime_stopped: 'Die Spezialistenlaufzeit ist nicht verfügbar.',
  operation_failed: 'Der Spezialistenauftrag konnte nicht sicher geändert werden.',
} satisfies Readonly<Record<
  Exclude<SpecialistRuntimeErrorCode, 'invalid_request'>
  | 'invalid_input'
  | 'stale_input_request'
  | 'operation_failed',
  string
>>);

type SpecialistRuntimePort = Pick<
  SpecialistRuntimeService,
  'snapshot' | 'snapshots' | 'isAcceptingControls' | 'provideInput' | 'resume' | 'cancel'
>;

export interface SpecialistTaskHandlerDependencies {
  readonly getRuntime: () => SpecialistRuntimePort;
  readonly isShuttingDown?: () => boolean;
}

function controlsUnavailable(dependencies: SpecialistTaskHandlerDependencies): boolean {
  return dependencies.isShuttingDown?.() === true;
}

function failure(
  code: keyof typeof ERROR_MESSAGES,
): SpecialistTaskControlResult {
  return Object.freeze({ ok: false, code, message: ERROR_MESSAGES[code] });
}

function safeControlResult(
  result: SpecialistRuntimeResult,
  runtime: SpecialistRuntimePort,
  taskId: string,
): SpecialistTaskControlResult {
  if (!result.ok) {
    const code = result.code === 'invalid_request' ? 'invalid_input' : result.code;
    return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? failure(code)
      : failure('operation_failed');
  }
  const snapshot = result.snapshot ?? runtime.snapshot(taskId);
  const parsed = SpecialistTaskControlResultSchema.safeParse({ ok: true, snapshot });
  return parsed.success ? parsed.data : failure('operation_failed');
}

async function safelyControl(
  runtime: SpecialistRuntimePort,
  taskId: string,
  operation: () => Promise<SpecialistRuntimeResult>,
): Promise<SpecialistTaskControlResult> {
  try {
    return safeControlResult(await operation(), runtime, taskId);
  } catch {
    return failure('operation_failed');
  }
}

/** Registers the validated, provider-neutral specialist task renderer boundary. */
export function registerSpecialistTaskHandlers(
  ipcMain: IpcMain,
  dependencies: SpecialistTaskHandlerDependencies,
): void {
  ipcMain.handle('specialist-tasks-list', () => {
    try {
      return SpecialistTaskListSchema.parse(dependencies.getRuntime().snapshots());
    } catch {
      throw new Error('Die Spezialistenaufträge konnten nicht sicher geladen werden.');
    }
  });

  ipcMain.handle('specialist-task-provide-input', (_event, input: unknown) => {
    const parsed = SpecialistTaskProvideInputSchema.safeParse(input);
    if (!parsed.success) return failure('invalid_input');
    try {
      if (controlsUnavailable(dependencies)) return failure('runtime_stopped');
      const runtime = dependencies.getRuntime();
      if (!runtime.isAcceptingControls()) return failure('runtime_stopped');
      const current = SpecialistTaskSnapshotSchema.safeParse(runtime.snapshot(parsed.data.taskId));
      if (
        !current.success
        || current.data.status !== 'waiting_for_user'
        || current.data.inputRequest?.requestId !== parsed.data.requestId
      ) return failure('stale_input_request');
      return safelyControl(runtime, parsed.data.taskId, () => (
        runtime.provideInput(
          parsed.data.taskId,
          parsed.data.input,
          parsed.data.requestId,
          parsed.data.expectedSequence,
        )
      ));
    } catch {
      return failure('operation_failed');
    }
  });

  ipcMain.handle('specialist-task-resume', (_event, input: unknown) => {
    const parsed = SpecialistTaskResumeInputSchema.safeParse(input);
    if (!parsed.success) return failure('invalid_input');
    try {
      if (controlsUnavailable(dependencies)) return failure('runtime_stopped');
      const runtime = dependencies.getRuntime();
      if (!runtime.isAcceptingControls()) return failure('runtime_stopped');
      return safelyControl(runtime, parsed.data.taskId, () => runtime.resume(
        parsed.data.taskId,
        parsed.data.requestId,
        parsed.data.expectedSequence,
      ));
    } catch {
      return failure('operation_failed');
    }
  });

  ipcMain.handle('specialist-task-cancel', (_event, input: unknown) => {
    const parsed = SpecialistTaskIdInputSchema.safeParse(input);
    if (!parsed.success) return failure('invalid_input');
    try {
      if (controlsUnavailable(dependencies)) return failure('runtime_stopped');
      const runtime = dependencies.getRuntime();
      if (!runtime.isAcceptingControls()) return failure('runtime_stopped');
      return safelyControl(runtime, parsed.data.taskId, () => runtime.cancel(parsed.data.taskId));
    } catch {
      return failure('operation_failed');
    }
  });
}
