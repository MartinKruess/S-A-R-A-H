import {
  AI_PROVIDER_ROLES,
  AiProviderIdSchema,
  AiProviderOperationIdSchema,
  isAiOperationCompatible,
  type AiCostWarning,
  type AiProviderId,
  type AiProviderOperationId,
} from '../../core/ai-provider-contract.js';
import {
  AI_GENERAL_COST_WARNING,
  ANTHROPIC_COST_WARNING,
} from './ai-provider-catalog.js';

export const CODEX_MANAGED_CHATGPT_NOTICE: AiCostWarning = Object.freeze({
  version: '2026-09-05.codex-managed-chatgpt.v1',
  title: 'Hinweis zur Codex-Anmeldung mit ChatGPT',
  text: 'Diese Verbindung verwendet die von Codex verwaltete ChatGPT-Anmeldung. Es gelten die Codex-Zugriffsrechte und Nutzungslimits deines ChatGPT-Plans. Sie gewährt keinen allgemeinen API-Zugang für Text oder Deep Research. Bitte bestätige diesen Hinweis vor der Verbindung. Sarah wechselt nicht automatisch auf eine separat kostenpflichtige API-Verbindung. Dafür ist eine gesonderte Auswahl und Bestätigung erforderlich.',
});

export type AiAuthPolicyKind = 'api_key' | 'codex_managed_chatgpt';

export interface AiAuthPolicy {
  readonly providerId: AiProviderId;
  readonly operationId: AiProviderOperationId;
  readonly authKind: AiAuthPolicyKind;
  readonly billing: 'api' | 'chatgpt_plan';
  readonly requiresAcknowledgement: true;
  readonly disclosures: readonly AiCostWarning[];
}

/**
 * @param providerId - Claimed fixed provider identifier; invalid values are rejected.
 * @param operationId - Claimed operation, checked against the existing compatibility contract.
 * @param authKind - Exact authentication mode; no implicit default or paid fallback.
 *
 * - Resolves an application-owned, immutable authentication and billing policy.
 * - Does not establish adapter readiness, credentials, consent, or execution permission.
 *
 * @returns Supported policy, or null for unsupported or malformed combinations.
 * @category Authorization
 */
export function resolveAiAuthPolicy(
  providerId: string,
  operationId: string,
  authKind: string,
): AiAuthPolicy | null {
  const provider = AiProviderIdSchema.safeParse(providerId);
  const operation = AiProviderOperationIdSchema.safeParse(operationId);
  if (!provider.success || !operation.success) return null;
  if (!AI_PROVIDER_ROLES.some((role) => (
    isAiOperationCompatible(provider.data, role, operation.data)
  ))) return null;

  if (authKind === 'api_key') {
    return Object.freeze({
      providerId: provider.data,
      operationId: operation.data,
      authKind,
      billing: 'api',
      requiresAcknowledgement: true,
      disclosures: Object.freeze(provider.data === 'anthropic'
        ? [AI_GENERAL_COST_WARNING, ANTHROPIC_COST_WARNING]
        : [AI_GENERAL_COST_WARNING]),
    });
  }

  if (authKind === 'codex_managed_chatgpt'
    && provider.data === 'openai'
    && operation.data === 'openai_codex') {
    return Object.freeze({
      providerId: provider.data,
      operationId: operation.data,
      authKind,
      billing: 'chatgpt_plan',
      requiresAcknowledgement: true,
      disclosures: Object.freeze([CODEX_MANAGED_CHATGPT_NOTICE]),
    });
  }

  return null;
}
