import { describe, expect, it } from 'vitest';
import {
  AcknowledgeAiWarningsInputSchema,
  AiProviderCatalogEntrySchema,
  AiRoleBindingSchema,
  AiUsageRecordSchema,
  DeleteAiConnectionInputSchema,
  ReplaceAiBindingsInputSchema,
  SaveAiApiKeyInputSchema,
  isAiOperationCompatible,
} from '../../src/core/ai-provider-contract.js';

const UUID = 'db2f10d4-cc66-4c22-8611-43cc728682b6';

describe('AI provider contracts', () => {
  it.each([
    ['openai', 'text', 'openai_responses_text'],
    ['openai', 'research', 'openai_deep_research'],
    ['openai', 'coding', 'openai_codex'],
    ['anthropic', 'text', 'anthropic_messages_text'],
    ['anthropic', 'coding', 'anthropic_claude_agent'],
    ['perplexity', 'research', 'perplexity_agent_research'],
  ] as const)('accepts the fixed %s/%s/%s operation', (provider, role, operation) => {
    expect(isAiOperationCompatible(provider, role, operation)).toBe(true);
  });

  it('rejects crossed provider and role operation combinations', () => {
    expect(isAiOperationCompatible('openai', 'coding', 'anthropic_claude_agent')).toBe(false);
    expect(isAiOperationCompatible('perplexity', 'text', 'perplexity_agent_research')).toBe(false);
  });

  it('strictly validates save-key input and bounds secret length', () => {
    const valid = {
      providerId: 'openai',
      apiKey: 'test-api-key',
      acknowledgement: { generalWarningVersion: '2026-09-04.v1' },
    };
    expect(SaveAiApiKeyInputSchema.safeParse(valid).success).toBe(true);
    expect(SaveAiApiKeyInputSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(SaveAiApiKeyInputSchema.safeParse({ ...valid, apiKey: 'short' }).success).toBe(false);
    expect(SaveAiApiKeyInputSchema.safeParse({ ...valid, apiKey: 'x'.repeat(4_097) }).success).toBe(false);
    expect(SaveAiApiKeyInputSchema.safeParse({ ...valid, apiKey: 'valid-key\nleak' }).success).toBe(false);
    expect(SaveAiApiKeyInputSchema.safeParse({ ...valid, providerId: 'custom' }).success).toBe(false);
  });

  it('strictly validates warning acknowledgement input', () => {
    const valid = {
      connectionId: UUID,
      acknowledgement: { generalWarningVersion: '2026-09-04.v1' },
    };
    expect(AcknowledgeAiWarningsInputSchema.safeParse(valid).success).toBe(true);
    expect(AcknowledgeAiWarningsInputSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(AcknowledgeAiWarningsInputSchema.safeParse({
      ...valid,
      connectionId: 'not-a-uuid',
    }).success).toBe(false);
  });

  it('rejects malformed identifiers, extra fields and oversized binding lists', () => {
    expect(DeleteAiConnectionInputSchema.safeParse({ connectionId: '../spotify' }).success).toBe(false);
    expect(DeleteAiConnectionInputSchema.safeParse({ connectionId: UUID, extra: true }).success).toBe(false);
    expect(ReplaceAiBindingsInputSchema.safeParse({
      expectedRevision: 0,
      bindings: Array.from({ length: 31 }, () => ({
        bindingId: UUID,
        connectionId: UUID,
        role: 'text',
        operationId: 'openai_responses_text',
        modelProfile: 'provider_default',
        enabled: true,
        position: 0,
        revision: 1,
      })),
    }).success).toBe(false);
  });

  it('rejects a role binding whose operation has another role', () => {
    expect(AiRoleBindingSchema.safeParse({
      bindingId: UUID,
      connectionId: UUID,
      role: 'research',
      operationId: 'openai_codex',
      modelProfile: 'provider_default',
      enabled: true,
      position: 0,
      revision: 1,
    }).success).toBe(false);
  });

  it('rejects catalog operations assigned to another provider', () => {
    expect(AiProviderCatalogEntrySchema.safeParse({
      id: 'openai',
      displayName: 'OpenAI',
      authKinds: ['api_key'],
      operations: [{
        id: 'anthropic_messages_text',
        providerId: 'anthropic',
        role: 'text',
      }],
      generalWarningVersion: 'v1',
      helpLinks: { pricing: 'https://openai.com', spendingLimits: 'https://openai.com' },
    }).success).toBe(false);
  });

  it('validates normalized usage against the fixed operation tuple', () => {
    const usage = {
      providerId: 'openai',
      role: 'text',
      operationId: 'openai_responses_text',
      model: 'provider-default',
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningTokens: 0,
      toolCalls: 0,
      recordedAt: '2026-09-04T12:00:00.000Z',
    };
    expect(AiUsageRecordSchema.safeParse(usage).success).toBe(true);
    expect(AiUsageRecordSchema.safeParse({ ...usage, role: 'coding' }).success).toBe(false);
  });
});
