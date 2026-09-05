import { z } from 'zod';

export const AI_PROVIDER_IDS = ['openai', 'anthropic', 'perplexity'] as const;
export const AI_AUTH_KINDS = ['api_key', 'codex_managed_chatgpt'] as const;
export const AI_MAX_CONNECTIONS = 4;
export const AiStoredSecretAuthKindSchema = z.literal('api_key');
export const AI_PROVIDER_ROLES = ['text', 'coding', 'research'] as const;
export const AI_PROVIDER_OPERATION_IDS = [
  'openai_responses_text',
  'openai_deep_research',
  'openai_codex',
  'anthropic_messages_text',
  'anthropic_claude_agent',
  'perplexity_agent_research',
] as const;
export const AI_CONNECTION_HEALTH_STATES = [
  'not_configured',
  'credential_saved_unverified',
  'checking',
  'healthy',
  'invalid_credentials',
  'temporarily_unavailable',
  'storage_degraded',
] as const;

export const AiProviderIdSchema = z.enum(AI_PROVIDER_IDS);
export const AiAuthKindSchema = z.enum(AI_AUTH_KINDS);
export const AiProviderRoleSchema = z.enum(AI_PROVIDER_ROLES);
export const AiProviderOperationIdSchema = z.enum(AI_PROVIDER_OPERATION_IDS);
export const AiConnectionHealthStateSchema = z.enum(AI_CONNECTION_HEALTH_STATES);

export type AiProviderId = z.infer<typeof AiProviderIdSchema>;
export type AiAuthKind = z.infer<typeof AiAuthKindSchema>;
export type AiProviderRole = z.infer<typeof AiProviderRoleSchema>;
export type AiProviderOperationId = z.infer<typeof AiProviderOperationIdSchema>;
export type AiConnectionHealthState = z.infer<typeof AiConnectionHealthStateSchema>;

const BOUNDED_ID = z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/u);
const WARNING_VERSION = z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const SAFE_MESSAGE = z.string().trim().min(1).max(500);
const ISO_TIMESTAMP = z.iso.datetime({ offset: true });
const HTTPS_URL = z.url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS required');

export const AiProviderOperationSchema = z.discriminatedUnion('id', [
  z.object({
    id: z.literal('openai_responses_text'),
    providerId: z.literal('openai'),
    role: z.literal('text'),
  }).strict().readonly(),
  z.object({
    id: z.literal('openai_deep_research'),
    providerId: z.literal('openai'),
    role: z.literal('research'),
  }).strict().readonly(),
  z.object({
    id: z.literal('openai_codex'),
    providerId: z.literal('openai'),
    role: z.literal('coding'),
  }).strict().readonly(),
  z.object({
    id: z.literal('anthropic_messages_text'),
    providerId: z.literal('anthropic'),
    role: z.literal('text'),
  }).strict().readonly(),
  z.object({
    id: z.literal('anthropic_claude_agent'),
    providerId: z.literal('anthropic'),
    role: z.literal('coding'),
  }).strict().readonly(),
  z.object({
    id: z.literal('perplexity_agent_research'),
    providerId: z.literal('perplexity'),
    role: z.literal('research'),
  }).strict().readonly(),
]);

export const AiCostWarningSchema = z.object({
  version: WARNING_VERSION,
  title: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(2_000),
}).strict().readonly();

export const AiCostAcknowledgementSchema = z.object({
  generalWarningVersion: WARNING_VERSION,
  providerWarningVersion: WARNING_VERSION.optional(),
}).strict().readonly();

export const AiProviderCatalogEntrySchema = z.object({
  id: AiProviderIdSchema,
  displayName: z.string().trim().min(1).max(100),
  authKinds: z.array(AiAuthKindSchema).min(1).max(AI_AUTH_KINDS.length).readonly(),
  operations: z.array(AiProviderOperationSchema).min(1).max(AI_PROVIDER_OPERATION_IDS.length).readonly(),
  generalWarningVersion: WARNING_VERSION,
  providerWarning: AiCostWarningSchema.optional(),
  helpLinks: z.object({
    pricing: HTTPS_URL,
    spendingLimits: HTTPS_URL,
  }).strict().readonly(),
}).strict().superRefine((entry, context) => {
  if (entry.operations.some((operation) => operation.providerId !== entry.id)) {
    context.addIssue({
      code: 'custom',
      message: 'Catalog operations must belong to their provider',
      path: ['operations'],
    });
  }
  if (new Set(entry.authKinds).size !== entry.authKinds.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate auth kind', path: ['authKinds'] });
  }
  if (new Set(entry.operations.map((operation) => operation.id)).size !== entry.operations.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate operation', path: ['operations'] });
  }
}).readonly();

export const AiConnectionHealthSchema = z.object({
  state: AiConnectionHealthStateSchema,
  lastCheckedAt: ISO_TIMESTAMP.optional(),
  message: SAFE_MESSAGE.optional(),
}).strict().readonly();

export const AiHubStorageStatusSchema = z.object({
  state: z.enum(['ready', 'recovered', 'degraded']),
  message: SAFE_MESSAGE.optional(),
}).strict().readonly();

export const AiConnectionSnapshotSchema = z.object({
  connectionId: z.uuid(),
  providerId: AiProviderIdSchema,
  authKind: AiAuthKindSchema,
  credentialGeneration: z.number().int().min(1).optional(),
  displayLabel: z.string().trim().min(1).max(100),
  hasCredential: z.boolean(),
  acknowledgement: AiCostAcknowledgementSchema,
  health: AiConnectionHealthSchema,
  createdAt: ISO_TIMESTAMP,
  updatedAt: ISO_TIMESTAMP,
}).strict().readonly();

function operationMatchesRole(
  operationId: AiProviderOperationId,
  role: AiProviderRole,
): boolean {
  if (operationId === 'openai_responses_text' || operationId === 'anthropic_messages_text') {
    return role === 'text';
  }
  if (operationId === 'openai_codex' || operationId === 'anthropic_claude_agent') {
    return role === 'coding';
  }
  return role === 'research';
}

export const AiRoleBindingSchema = z.object({
  bindingId: z.uuid(),
  connectionId: z.uuid(),
  role: AiProviderRoleSchema,
  operationId: AiProviderOperationIdSchema,
  modelProfile: z.literal('provider_default'),
  modelId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u).optional(),
  cloudTextOptIn: z.boolean().optional(),
  enabled: z.boolean(),
  position: z.number().int().min(0).max(9),
  revision: z.number().int().min(1),
}).strict().superRefine((binding, context) => {
  if (!operationMatchesRole(binding.operationId, binding.role)) {
    context.addIssue({
      code: 'custom',
      message: 'Operation is incompatible with role',
      path: ['operationId'],
    });
  }
}).readonly();

export const AiProviderHubSnapshotSchema = z.object({
  generalWarning: AiCostWarningSchema,
  catalog: z.array(AiProviderCatalogEntrySchema).length(AI_PROVIDER_IDS.length).readonly(),
  connections: z.array(AiConnectionSnapshotSchema).max(AI_MAX_CONNECTIONS).readonly(),
  bindings: z.array(AiRoleBindingSchema).max(30).readonly(),
  bindingRevision: z.number().int().min(0),
  storage: AiHubStorageStatusSchema,
}).strict().readonly();

export const AI_HUB_ERROR_CODES = [
  'invalid_input',
  'unknown_provider',
  'acknowledgement_required',
  'stale_acknowledgement',
  'connection_not_found',
  'revision_conflict',
  'health_adapter_unavailable',
  'storage_degraded',
  'operation_failed',
] as const;
export const AiHubErrorCodeSchema = z.enum(AI_HUB_ERROR_CODES);

export const AiHubMutationResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: AiProviderHubSnapshotSchema }).strict().readonly(),
  z.object({
    ok: z.literal(false),
    code: AiHubErrorCodeSchema,
    message: SAFE_MESSAGE,
    snapshot: AiProviderHubSnapshotSchema.optional(),
  }).strict().readonly(),
]);

export const AiUsageRecordSchema = z.object({
  providerId: AiProviderIdSchema,
  role: AiProviderRoleSchema,
  operationId: AiProviderOperationIdSchema,
  model: z.string().trim().min(1).max(200),
  // Total input includes cache reads and writes; absent subcounts are not zero.
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0).optional(),
  cacheWriteInputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0),
  reasoningTokens: z.number().int().min(0).optional(),
  toolCalls: z.number().int().min(0).optional(),
  providerReportedCost: z.object({
    amount: z.number().min(0),
    currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  }).strict().readonly().optional(),
  recordedAt: ISO_TIMESTAMP,
}).strict().superRefine((usage, context) => {
  if (!isAiOperationCompatible(usage.providerId, usage.role, usage.operationId)) {
    context.addIssue({
      code: 'custom',
      message: 'Usage provider, role and operation are incompatible',
      path: ['operationId'],
    });
  }
}).readonly();

export const SaveAiApiKeyInputSchema = z.object({
  providerId: AiProviderIdSchema,
  apiKey: z.string().trim().min(8).max(4_096).refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    'API key contains control characters',
  ),
  acknowledgement: AiCostAcknowledgementSchema,
}).strict().readonly();

export const DeleteAiConnectionInputSchema = z.object({
  connectionId: z.uuid(),
}).strict().readonly();

export const AcknowledgeAiWarningsInputSchema = z.object({
  connectionId: z.uuid(),
  acknowledgement: AiCostAcknowledgementSchema,
}).strict().readonly();

export const ReplaceAiBindingsInputSchema = z.object({
  bindings: z.array(AiRoleBindingSchema).max(30).readonly(),
  expectedRevision: z.number().int().min(0),
}).strict().readonly();

export const CheckAiConnectionHealthInputSchema = z.object({
  connectionId: z.uuid(),
}).strict().readonly();

export type AiProviderOperation = z.infer<typeof AiProviderOperationSchema>;
export type AiCostWarning = z.infer<typeof AiCostWarningSchema>;
export type AiCostAcknowledgement = z.infer<typeof AiCostAcknowledgementSchema>;
export type AiProviderCatalogEntry = z.infer<typeof AiProviderCatalogEntrySchema>;
export type AiConnectionHealth = z.infer<typeof AiConnectionHealthSchema>;
export type AiHubStorageStatus = z.infer<typeof AiHubStorageStatusSchema>;
export type AiConnectionSnapshot = z.infer<typeof AiConnectionSnapshotSchema>;
export type AiRoleBinding = z.infer<typeof AiRoleBindingSchema>;
export type AiProviderHubSnapshot = z.infer<typeof AiProviderHubSnapshotSchema>;
export type AiHubMutationResult = z.infer<typeof AiHubMutationResultSchema>;
export type AiHubErrorCode = z.infer<typeof AiHubErrorCodeSchema>;
export type AiUsageRecord = z.infer<typeof AiUsageRecordSchema>;
export type SaveAiApiKeyInput = z.infer<typeof SaveAiApiKeyInputSchema>;
export type DeleteAiConnectionInput = z.infer<typeof DeleteAiConnectionInputSchema>;
export type AcknowledgeAiWarningsInput = z.infer<typeof AcknowledgeAiWarningsInputSchema>;
export type ReplaceAiBindingsInput = z.infer<typeof ReplaceAiBindingsInputSchema>;
export type CheckAiConnectionHealthInput = z.infer<typeof CheckAiConnectionHealthInputSchema>;

/** Validates the fixed provider/role/operation relationship. */
export function isAiOperationCompatible(
  providerId: AiProviderId,
  role: AiProviderRole,
  operationId: AiProviderOperationId,
): boolean {
  return AiProviderOperationSchema.safeParse({ id: operationId, providerId, role }).success;
}
