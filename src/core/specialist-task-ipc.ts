import { z } from 'zod';
import {
  SpecialistTaskSnapshotSchema,
  type SpecialistTaskSnapshot,
} from './specialist-task.js';

const SAFE_REQUEST_ID = z.string().trim().min(1).max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/iu);
const SAFE_USER_INPUT = z.string().trim().min(1).max(4_000).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  'Control characters are not allowed',
);
const SAFE_MESSAGE = z.string().trim().min(1).max(500);

export const SpecialistTaskIdInputSchema = z.object({
  taskId: z.uuid(),
}).strict().readonly();

export const SpecialistTaskProvideInputSchema = z.object({
  taskId: z.uuid(),
  requestId: SAFE_REQUEST_ID,
  expectedSequence: z.number().int().min(0),
  input: SAFE_USER_INPUT,
}).strict().readonly();

export const SpecialistTaskResumeInputSchema = z.object({
  taskId: z.uuid(),
  requestId: SAFE_REQUEST_ID,
  expectedSequence: z.number().int().min(0),
}).strict().readonly();

export const SpecialistTaskListSchema = z.array(SpecialistTaskSnapshotSchema).max(100).readonly();

export const SPECIALIST_TASK_IPC_ERROR_CODES = [
  'invalid_input',
  'stale_input_request',
  'binding_unavailable',
  'adapter_unavailable',
  'capacity_unavailable',
  'preflight_failed',
  'task_not_found',
  'invalid_state',
  'task_record_failed',
  'adapter_failed',
  'runtime_stopped',
  'operation_failed',
] as const;

export const SpecialistTaskIpcErrorCodeSchema = z.enum(SPECIALIST_TASK_IPC_ERROR_CODES);

export const SpecialistTaskControlResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    snapshot: SpecialistTaskSnapshotSchema,
  }).strict().readonly(),
  z.object({
    ok: z.literal(false),
    code: SpecialistTaskIpcErrorCodeSchema,
    message: SAFE_MESSAGE,
  }).strict().readonly(),
]);

export type SpecialistTaskIdInput = z.infer<typeof SpecialistTaskIdInputSchema>;
export type SpecialistTaskProvideInput = z.infer<typeof SpecialistTaskProvideInputSchema>;
export type SpecialistTaskResumeInput = z.infer<typeof SpecialistTaskResumeInputSchema>;
export type SpecialistTaskControlResult = z.infer<typeof SpecialistTaskControlResultSchema>;
export type SpecialistTaskList = readonly SpecialistTaskSnapshot[];
