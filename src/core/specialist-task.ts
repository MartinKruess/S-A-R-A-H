import { z } from 'zod';
import {
  AiProviderIdSchema,
  AiProviderOperationIdSchema,
  isAiOperationCompatible,
} from './ai-provider-contract.js';

export const SPECIALIST_TASK_ROLES = ['coding', 'research'] as const;
export const SPECIALIST_TASK_STATUSES = [
  'queued',
  'starting',
  'running',
  'waiting_for_user',
  'completed',
  'failed',
  'cancel_requested',
  'canceled',
  'incomplete',
] as const;

const SAFE_ID = z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._:-]*$/iu);
const SAFE_TEXT = z.string().trim().min(1).max(1_000).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  'Control characters are not allowed',
);
const ISO_TIMESTAMP = z.iso.datetime({ offset: true });
// Covers the maximum 100-turn task plus provider progress while keeping metadata bounded.
export const MAX_SPECIALIST_EVENT_IDS = 256;

export const SpecialistTaskRoleSchema = z.enum(SPECIALIST_TASK_ROLES);
export const SpecialistTaskStatusSchema = z.enum(SPECIALIST_TASK_STATUSES);

export const SpecialistTaskUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  reasoningTokens: z.number().int().min(0),
  toolCalls: z.number().int().min(0),
  providerReportedCost: z.object({
    amount: z.number().min(0),
    currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  }).strict().readonly().optional(),
}).strict().readonly();

export const SpecialistTaskRequestSchema = z.object({
  taskId: z.uuid(),
  role: SpecialistTaskRoleSchema,
  goal: SAFE_TEXT.max(4_000),
  sourceTurnId: SAFE_ID,
  planId: z.uuid(),
  planRevision: z.number().int().min(1),
  planFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  stepId: SAFE_ID,
  providerId: AiProviderIdSchema,
  operationId: AiProviderOperationIdSchema,
  connectionId: z.uuid(),
  bindingId: z.uuid(),
  bindingRevision: z.number().int().min(1),
  privateContext: z.literal(false),
  originMode: z.enum(['chat', 'voice']),
  dataEgress: z.array(z.enum(['goal', 'workspace_files', 'conversation_context']))
    .min(1).max(3).readonly(),
  workspaceReference: SAFE_ID.optional(),
  accessMode: z.enum(['none', 'read_only', 'workspace_write']),
  budget: z.object({
    maxTurns: z.number().int().min(1).max(100),
    timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60_000),
  }).strict().readonly(),
}).strict().superRefine((request, context) => {
  if (!isAiOperationCompatible(request.providerId, request.role, request.operationId)) {
    context.addIssue({
      code: 'custom',
      message: 'Provider, role and operation are incompatible',
      path: ['operationId'],
    });
  }
  if (request.accessMode !== 'none' && !request.workspaceReference) {
    context.addIssue({
      code: 'custom',
      message: 'Workspace access requires a workspace reference',
      path: ['workspaceReference'],
    });
  }
  if (request.dataEgress.includes('workspace_files') && !request.workspaceReference) {
    context.addIssue({
      code: 'custom',
      message: 'Workspace file egress requires a workspace reference',
      path: ['workspaceReference'],
    });
  }
  if (request.accessMode === 'none' && request.dataEgress.includes('workspace_files')) {
    context.addIssue({
      code: 'custom',
      message: 'Workspace file egress requires workspace access',
      path: ['dataEgress'],
    });
  }
  if (request.role === 'research' && request.accessMode !== 'none') {
    context.addIssue({
      code: 'custom',
      message: 'Research tasks cannot receive workspace access',
      path: ['accessMode'],
    });
  }
}).readonly();

export const SpecialistTaskSnapshotSchema = z.object({
  taskId: z.uuid(),
  role: SpecialistTaskRoleSchema,
  status: SpecialistTaskStatusSchema,
  sequence: z.number().int().min(0),
  createdAt: ISO_TIMESTAMP,
  updatedAt: ISO_TIMESTAMP,
  progressMessage: SAFE_TEXT.optional(),
  inputRequest: z.object({
    requestId: SAFE_ID,
    prompt: SAFE_TEXT,
  }).strict().readonly().optional(),
  terminal: z.object({
    code: SAFE_ID.optional(),
    summary: SAFE_TEXT.optional(),
    usage: SpecialistTaskUsageSchema.optional(),
  }).strict().readonly().optional(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.status === 'waiting_for_user' && !snapshot.inputRequest) {
    context.addIssue({
      code: 'custom',
      message: 'A waiting specialist task requires an input request',
      path: ['inputRequest'],
    });
  }
  if (snapshot.status !== 'waiting_for_user' && snapshot.inputRequest) {
    context.addIssue({
      code: 'custom',
      message: 'Only a waiting specialist task may expose an input request',
      path: ['inputRequest'],
    });
  }
}).readonly();

export const SpecialistAdapterEventSchema = z.discriminatedUnion('type', [
  z.object({ eventId: SAFE_ID, type: z.literal('progress'), message: SAFE_TEXT }).strict().readonly(),
  z.object({
    eventId: SAFE_ID,
    type: z.literal('input_required'),
    requestId: SAFE_ID,
    prompt: SAFE_TEXT,
  }).strict().readonly(),
  z.object({ eventId: SAFE_ID, type: z.literal('running') }).strict().readonly(),
  z.object({ eventId: SAFE_ID, type: z.literal('cancel_requested') }).strict().readonly(),
  z.object({ eventId: SAFE_ID, type: z.literal('canceled') }).strict().readonly(),
  z.object({
    eventId: SAFE_ID,
    type: z.literal('completed'),
    summary: SAFE_TEXT.optional(),
    usage: SpecialistTaskUsageSchema.optional(),
  }).strict().readonly(),
  z.object({ eventId: SAFE_ID, type: z.literal('failed'), code: SAFE_ID }).strict().readonly(),
  z.object({ eventId: SAFE_ID, type: z.literal('incomplete'), code: SAFE_ID }).strict().readonly(),
]);

const ACCEPTED_STATUSES = [
  'queued', 'running', 'waiting_for_user', 'completed', 'failed',
  'cancel_requested', 'canceled', 'incomplete',
] as const;

export const AcceptedSpecialistTaskMetadataSchema = z.object({
  taskId: z.uuid(),
  role: SpecialistTaskRoleSchema,
  providerId: AiProviderIdSchema,
  operationId: AiProviderOperationIdSchema,
  connectionId: z.uuid(),
  bindingId: z.uuid(),
  bindingRevision: z.number().int().min(1),
  remoteRef: SAFE_ID,
  status: z.enum(ACCEPTED_STATUSES),
  sequence: z.number().int().min(0),
  createdAt: ISO_TIMESTAMP,
  updatedAt: ISO_TIMESTAMP,
  deadlineAt: ISO_TIMESTAMP.optional(),
  eventIds: z.array(SAFE_ID).max(MAX_SPECIALIST_EVENT_IDS)
    .refine((eventIds) => new Set(eventIds).size === eventIds.length, 'Duplicate event ids')
    .readonly(),
  maxTurns: z.number().int().min(1).max(100),
  turnsUsed: z.number().int().min(1).max(100),
  terminalCode: SAFE_ID.optional(),
}).strict().superRefine((task, context) => {
  if (task.turnsUsed > task.maxTurns) {
    context.addIssue({ code: 'custom', message: 'Turn budget exceeded', path: ['turnsUsed'] });
  }
  if (task.eventIds.length === MAX_SPECIALIST_EVENT_IDS
    && !['completed', 'failed', 'canceled', 'incomplete'].includes(task.status)) {
    context.addIssue({ code: 'custom', message: 'Event limit requires a terminal task', path: ['status'] });
  }
}).readonly();

export type SpecialistTaskRole = z.infer<typeof SpecialistTaskRoleSchema>;
export type SpecialistTaskStatus = z.infer<typeof SpecialistTaskStatusSchema>;
export type SpecialistTaskUsage = z.infer<typeof SpecialistTaskUsageSchema>;
export type SpecialistTaskRequest = z.infer<typeof SpecialistTaskRequestSchema>;
export type SpecialistTaskSnapshot = z.infer<typeof SpecialistTaskSnapshotSchema>;
export type SpecialistAdapterEvent = z.infer<typeof SpecialistAdapterEventSchema>;
export type AcceptedSpecialistTaskMetadata = z.infer<typeof AcceptedSpecialistTaskMetadataSchema>;

const TERMINAL: ReadonlySet<SpecialistTaskStatus> = new Set([
  'completed', 'failed', 'canceled', 'incomplete',
]);

function freezeSnapshot(snapshot: SpecialistTaskSnapshot): SpecialistTaskSnapshot {
  return Object.freeze({
    ...snapshot,
    ...(snapshot.inputRequest ? { inputRequest: Object.freeze({ ...snapshot.inputRequest }) } : {}),
    ...(snapshot.terminal ? {
      terminal: Object.freeze({
        ...snapshot.terminal,
        ...(snapshot.terminal.usage ? { usage: Object.freeze({ ...snapshot.terminal.usage }) } : {}),
      }),
    } : {}),
  });
}

/** Creates one immutable, provider-neutral public task snapshot. */
export function createSpecialistTaskSnapshot(
  input: Omit<SpecialistTaskSnapshot, 'sequence'> & { readonly sequence?: number },
): SpecialistTaskSnapshot {
  return freezeSnapshot(SpecialistTaskSnapshotSchema.parse({ sequence: 0, ...input }));
}

/** Applies one normalized provider event through the closed task state machine. */
export function applySpecialistTaskEvent(
  current: SpecialistTaskSnapshot,
  event: SpecialistAdapterEvent,
  updatedAt: string,
): SpecialistTaskSnapshot {
  const snapshot = SpecialistTaskSnapshotSchema.parse(current);
  const parsedEvent = SpecialistAdapterEventSchema.parse(event);
  if (TERMINAL.has(snapshot.status)) throw new Error('A terminal specialist task rejects late events');

  let status: SpecialistTaskStatus = snapshot.status;
  if (parsedEvent.type === 'input_required') {
    if (snapshot.status !== 'running' && snapshot.status !== 'queued') {
      throw new Error('Input can be requested only by an active specialist task');
    }
    status = 'waiting_for_user';
  } else if (parsedEvent.type === 'running') {
    if (!['queued', 'running', 'waiting_for_user'].includes(snapshot.status)) {
      throw new Error('A specialist task cannot enter running from its current state');
    }
    status = 'running';
  } else if (parsedEvent.type === 'cancel_requested') {
    if (!['queued', 'running', 'waiting_for_user'].includes(snapshot.status)) {
      throw new Error('Cancellation cannot be requested from the current state');
    }
    status = 'cancel_requested';
  } else if (parsedEvent.type === 'canceled') {
    if (snapshot.status !== 'cancel_requested') {
      throw new Error('Only a provider-confirmed cancellation can finish cancellation');
    }
    status = 'canceled';
  } else if (parsedEvent.type === 'completed') {
    if (!['queued', 'running', 'waiting_for_user', 'cancel_requested'].includes(snapshot.status)) {
      throw new Error('A specialist task cannot complete from its current state');
    }
    status = 'completed';
  } else if (parsedEvent.type === 'failed') {
    status = 'failed';
  } else if (parsedEvent.type === 'incomplete') {
    status = 'incomplete';
  }

  const next: SpecialistTaskSnapshot = {
    taskId: snapshot.taskId,
    role: snapshot.role,
    status,
    sequence: snapshot.sequence + 1,
    createdAt: snapshot.createdAt,
    updatedAt,
    ...(parsedEvent.type === 'progress' ? { progressMessage: parsedEvent.message } : {}),
    ...(parsedEvent.type === 'progress' && snapshot.inputRequest
      ? { inputRequest: snapshot.inputRequest }
      : {}),
    ...(parsedEvent.type === 'input_required' ? {
      inputRequest: { requestId: parsedEvent.requestId, prompt: parsedEvent.prompt },
    } : {}),
    ...(parsedEvent.type === 'completed' ? {
      terminal: {
        ...(parsedEvent.summary ? { summary: parsedEvent.summary } : {}),
        ...(parsedEvent.usage ? { usage: parsedEvent.usage } : {}),
      },
    } : {}),
    ...(parsedEvent.type === 'failed' || parsedEvent.type === 'incomplete'
      ? { terminal: { code: parsedEvent.code } }
      : {}),
  };
  return freezeSnapshot(SpecialistTaskSnapshotSchema.parse(next));
}

export function isTerminalSpecialistTaskStatus(status: SpecialistTaskStatus): boolean {
  return TERMINAL.has(status);
}
