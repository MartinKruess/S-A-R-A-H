import { describe, expect, it } from 'vitest';
import {
  AI_AUTH_KINDS,
  AI_PROVIDER_IDS,
  AI_PROVIDER_OPERATION_IDS,
  AiCostWarningSchema,
} from '../../../src/core/ai-provider-contract.js';
import {
  AI_GENERAL_COST_WARNING,
  AI_PROVIDER_CATALOG,
  ANTHROPIC_COST_WARNING,
} from '../../../src/services/integrations/ai-provider-catalog.js';
import {
  CODEX_MANAGED_CHATGPT_NOTICE,
  resolveAiAuthPolicy,
} from '../../../src/services/integrations/ai-auth-policy.js';

const operationOwners = {
  openai_responses_text: 'openai',
  openai_deep_research: 'openai',
  openai_codex: 'openai',
  anthropic_messages_text: 'anthropic',
  anthropic_claude_agent: 'anthropic',
  perplexity_agent_research: 'perplexity',
} as const;

describe('AI authentication policy', () => {
  for (const providerId of AI_PROVIDER_IDS) {
    for (const operationId of AI_PROVIDER_OPERATION_IDS) {
      for (const authKind of ['api_key', 'codex_managed_chatgpt'] as const) {
        it(`checks ${providerId}/${operationId}/${authKind}`, () => {
          const policy = resolveAiAuthPolicy(providerId, operationId, authKind);
          const expectedSupported = operationOwners[operationId] === providerId
            && (authKind === 'api_key' || operationId === 'openai_codex');
          if (!expectedSupported) {
            expect(policy).toBeNull();
            return;
          }
          expect(policy).toEqual({
            providerId,
            operationId,
            authKind,
            billing: authKind === 'api_key' ? 'api' : 'chatgpt_plan',
            requiresAcknowledgement: true,
            disclosures: authKind === 'codex_managed_chatgpt'
              ? [CODEX_MANAGED_CHATGPT_NOTICE]
              : providerId === 'anthropic'
                ? [AI_GENERAL_COST_WARNING, ANTHROPIC_COST_WARNING]
                : [AI_GENERAL_COST_WARNING],
          });
          expect(Object.isFrozen(policy)).toBe(true);
          expect(Object.isFrozen(policy?.disclosures)).toBe(true);
          expect(policy?.disclosures.every(Object.isFrozen)).toBe(true);
        });
      }
    }
  }

  it.each(['', 'custom', 'OPENAI', 'openai ', '__proto__'])('rejects malformed provider %s', (value) => {
    expect(resolveAiAuthPolicy(value, 'openai_codex', 'api_key')).toBeNull();
  });

  it.each(['', 'custom', 'OPENAI_CODEX', 'openai_codex ', '__proto__'])('rejects malformed operation %s', (value) => {
    expect(resolveAiAuthPolicy('openai', value, 'api_key')).toBeNull();
  });

  it.each(['', 'oauth', 'chatgpt', 'claude_pro', 'perplexity_pro', 'API_KEY', 'api_key ', '__proto__'])('rejects unsupported auth %s', (value) => {
    expect(resolveAiAuthPolicy('openai', 'openai_codex', value)).toBeNull();
  });

  it('keeps API copy unchanged and managed-plan disclosure separate and versioned', () => {
    const api = resolveAiAuthPolicy('openai', 'openai_codex', 'api_key');
    expect(api?.disclosures[0]).toBe(AI_GENERAL_COST_WARNING);
    expect(AiCostWarningSchema.safeParse(CODEX_MANAGED_CHATGPT_NOTICE).success).toBe(true);
    expect(CODEX_MANAGED_CHATGPT_NOTICE.version).toBe('2026-09-05.codex-managed-chatgpt.v1');
    expect(CODEX_MANAGED_CHATGPT_NOTICE.text).toContain('Nutzungslimits');
    expect(CODEX_MANAGED_CHATGPT_NOTICE.text).toContain('keinen allgemeinen API-Zugang');
    expect(CODEX_MANAGED_CHATGPT_NOTICE.text).toContain('nicht automatisch');
    expect(CODEX_MANAGED_CHATGPT_NOTICE.text).toContain('gesonderte Auswahl und Bestätigung');
    expect(CODEX_MANAGED_CHATGPT_NOTICE.text).toContain('bestätige diesen Hinweis vor der Verbindung');
  });

  it('does not advertise or activate managed authentication in existing public contracts', () => {
    expect(AI_AUTH_KINDS).toEqual(['api_key']);
    expect(AI_PROVIDER_CATALOG.every((provider) => (
      provider.authKinds.length === 1 && provider.authKinds[0] === 'api_key'
    ))).toBe(true);
    const policy = resolveAiAuthPolicy('openai', 'openai_codex', 'codex_managed_chatgpt');
    expect(policy).not.toHaveProperty('ready');
    expect(policy).not.toHaveProperty('credential');
    expect(policy).not.toHaveProperty('enabled');
  });
});
