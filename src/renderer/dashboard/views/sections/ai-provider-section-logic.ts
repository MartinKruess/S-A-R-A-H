import {
  AcknowledgeAiWarningsInputSchema,
  AI_PROVIDER_ROLES,
  ReplaceAiBindingsInputSchema,
  SaveAiApiKeyInputSchema,
  isAiOperationCompatible,
  type AiConnectionSnapshot,
  type AcknowledgeAiWarningsInput,
  type AiHubMutationResult,
  type AiProviderCatalogEntry,
  type AiProviderHubSnapshot,
  type AiProviderOperationId,
  type AiProviderRole,
  type AiRoleBinding,
  type ReplaceAiBindingsInput,
  type SaveAiApiKeyInput,
} from '../../../../core/ai-provider-contract.js';
import type { SarahAiProvidersApi } from '../../../../core/sarah-api.js';
import { resolveAiAuthPolicy } from '../../../../services/integrations/ai-auth-policy.js';

export type AiProviderBadgeState = 'connected' | 'disconnected' | 'pending' | 'error';

export interface AiProviderCardView {
  readonly providerId: AiProviderCatalogEntry['id'];
  readonly displayName: string;
  readonly badgeText: string;
  readonly badgeState: AiProviderBadgeState;
  readonly connection?: AiConnectionSnapshot;
  readonly mutationsDisabled: boolean;
  readonly statusMessage?: string;
}

export interface AiProviderWarningView {
  readonly version: string;
  readonly title: string;
  readonly text: string;
  readonly kind: 'general' | 'provider';
}

export interface AiBindingOption {
  readonly key: string;
  readonly connectionId: string;
  readonly operationId: AiProviderOperationId;
  readonly label: string;
}

export interface AiUiActionOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly snapshot?: AiProviderHubSnapshot;
}

export const AI_ROLE_LABELS: Readonly<Record<AiProviderRole, string>> = Object.freeze({
  text: 'Text',
  coding: 'Programmierung',
  research: 'Recherche',
});

const OPERATION_LABELS: Readonly<Record<AiProviderOperationId, string>> = Object.freeze({
  openai_responses_text: 'Responses',
  openai_deep_research: 'Deep Research',
  openai_codex: 'Codex',
  anthropic_messages_text: 'Messages',
  anthropic_claude_agent: 'Claude Agent',
  perplexity_agent_research: 'Research Agent',
});

const TRANSPORT_FAILURE = 'Die KI-Einstellungen konnten gerade nicht sicher geändert werden.';

/** Maps one provider to a truthful, credential-aware UI state. */
export function toAiProviderCardView(
  snapshot: AiProviderHubSnapshot,
  provider: AiProviderCatalogEntry,
): AiProviderCardView {
  const connection = snapshot.connections.find((candidate) => candidate.providerId === provider.id && candidate.authKind === 'api_key');
  if (snapshot.storage.state === 'degraded') {
    return {
      providerId: provider.id,
      displayName: provider.displayName,
      badgeText: 'Speicherfehler',
      badgeState: 'error',
      ...(connection ? { connection } : {}),
      mutationsDisabled: true,
      statusMessage: snapshot.storage.message
        ?? 'Der Speicher für KI-Anbieter ist nicht verfügbar.',
    };
  }
  if (!connection || !connection.hasCredential || connection.health.state === 'not_configured') {
    return {
      providerId: provider.id,
      displayName: provider.displayName,
      badgeText: 'Nicht verbunden',
      badgeState: 'disconnected',
      ...(connection ? { connection } : {}),
      mutationsDisabled: false,
      ...(connection?.health.message ? { statusMessage: connection.health.message } : {}),
    };
  }

  const status = {
    credential_saved_unverified: ['Gespeichert, ungeprüft', 'pending'],
    checking: ['Prüfung läuft …', 'pending'],
    healthy: ['Verifiziert', 'connected'],
    invalid_credentials: ['Zugangsdaten ungültig', 'error'],
    temporarily_unavailable: ['Vorübergehend nicht erreichbar', 'error'],
    storage_degraded: ['Speicherfehler', 'error'],
  } as const;
  const [badgeText, badgeState] = status[connection.health.state];
  return {
    providerId: provider.id,
    displayName: provider.displayName,
    badgeText,
    badgeState,
    connection,
    mutationsDisabled: connection.health.state === 'storage_degraded',
    ...(connection.health.message ? { statusMessage: connection.health.message } : {}),
  };
}

/** Selects the exact versioned warnings that must be acknowledged for a provider. */
export function providerWarnings(
  snapshot: AiProviderHubSnapshot,
  provider: AiProviderCatalogEntry,
): readonly AiProviderWarningView[] {
  return [
    { ...snapshot.generalWarning, kind: 'general' },
    ...(provider.providerWarning
      ? [{ ...provider.providerWarning, kind: 'provider' as const }]
      : []),
  ];
}

/** Returns whether a stored connection must accept the currently displayed warnings again. */
export function requiresWarningAcknowledgement(
  provider: AiProviderCatalogEntry,
  connection: AiConnectionSnapshot | undefined,
): boolean {
  return connection !== undefined && (
    connection.acknowledgement.generalWarningVersion !== provider.generalWarningVersion
    || connection.acknowledgement.providerWarningVersion !== provider.providerWarning?.version
  );
}

/** Builds a credential-free acknowledgement update for an existing connection. */
export function buildAcknowledgeWarningsInput(
  snapshot: AiProviderHubSnapshot,
  provider: AiProviderCatalogEntry,
  generalAcknowledged: boolean,
  providerAcknowledged: boolean,
): AcknowledgeAiWarningsInput | null {
  const connection = snapshot.connections.find((candidate) => candidate.providerId === provider.id && candidate.authKind === 'api_key');
  if (
    !requiresWarningAcknowledgement(provider, connection)
    || snapshot.storage.state === 'degraded'
    || snapshot.generalWarning.version !== provider.generalWarningVersion
    || !generalAcknowledged
    || (provider.providerWarning !== undefined && !providerAcknowledged)
  ) return null;
  const parsed = AcknowledgeAiWarningsInputSchema.safeParse({
    connectionId: connection?.connectionId,
    acknowledgement: {
      generalWarningVersion: snapshot.generalWarning.version,
      ...(provider.providerWarning
        ? { providerWarningVersion: provider.providerWarning.version }
        : {}),
    },
  });
  return parsed.success ? parsed.data : null;
}

/** Builds the strict shared save payload, or fails closed while warnings are stale/unconfirmed. */
export function buildSaveApiKeyInput(
  snapshot: AiProviderHubSnapshot,
  provider: AiProviderCatalogEntry,
  apiKey: string,
  generalAcknowledged: boolean,
  providerAcknowledged: boolean,
): SaveAiApiKeyInput | null {
  if (
    snapshot.storage.state === 'degraded'
    || snapshot.generalWarning.version !== provider.generalWarningVersion
    || !generalAcknowledged
    || (provider.providerWarning !== undefined && !providerAcknowledged)
  ) return null;

  const candidate = {
    providerId: provider.id,
    apiKey,
    acknowledgement: {
      generalWarningVersion: snapshot.generalWarning.version,
      ...(provider.providerWarning
        ? { providerWarningVersion: provider.providerWarning.version }
        : {}),
    },
  };
  const parsed = SaveAiApiKeyInputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Submits one key and guarantees that the caller clears its sensitive field. */
export async function submitApiKey(
  api: SarahAiProvidersApi,
  input: SaveAiApiKeyInput,
  clearKey: () => void,
): Promise<AiUiActionOutcome> {
  try {
    return mutationOutcome(await api.saveApiKey(input), 'API-Schlüssel sicher gespeichert.');
  } catch {
    return { ok: false, message: TRANSPORT_FAILURE };
  } finally {
    clearKey();
  }
}

/** Updates warning consent without reading, replacing, or transmitting the stored credential. */
export async function submitWarningAcknowledgement(
  api: SarahAiProvidersApi,
  input: AcknowledgeAiWarningsInput,
): Promise<AiUiActionOutcome> {
  try {
    return mutationOutcome(
      await api.acknowledgeWarnings(input),
      'Kostenhinweise erneut bestätigt.',
    );
  } catch {
    return { ok: false, message: TRANSPORT_FAILURE };
  }
}

/** Deletes one confirmed connection without reflecting transport internals into the UI. */
export async function deleteAiConnection(
  api: SarahAiProvidersApi,
  connectionId: string,
): Promise<AiUiActionOutcome> {
  try {
    return mutationOutcome(
      await api.deleteConnection({ connectionId }),
      'KI-Verbindung gelöscht.',
    );
  } catch {
    return { ok: false, message: TRANSPORT_FAILURE };
  }
}

/** Returns catalog-compatible operations backed by a currently stored credential. */
export function compatibleBindingOptions(
  snapshot: AiProviderHubSnapshot,
  role: AiProviderRole,
): readonly AiBindingOption[] {
  return snapshot.catalog.flatMap((provider) => {
    const connections = snapshot.connections.filter((candidate) => (
      candidate.providerId === provider.id
      && candidate.hasCredential
      && candidate.health.state !== 'storage_degraded'
    ));
    return connections.flatMap((connection) => provider.operations
      .filter((operation) => (
        operation.role === role
        && isAiOperationCompatible(provider.id, role, operation.id)
        && hasPolicyAcknowledgement(connection, operation.id)
      ))
      .map((operation) => ({
        key: bindingOptionKey(connection.connectionId, operation.id),
        connectionId: connection.connectionId,
        operationId: operation.id,
        label: `${connection.displayLabel} — ${OPERATION_LABELS[operation.id]}`,
      })));
  });
}

export function bindingOptionKey(
  connectionId: string,
  operationId: AiProviderOperationId,
): string {
  return `${connectionId}:${operationId}`;
}

/** Compacts positions per role and keeps the fixed role/standard/fallback order deterministic. */
export function orderRoleBindings(
  bindings: readonly AiRoleBinding[],
): readonly AiRoleBinding[] {
  return AI_PROVIDER_ROLES.flatMap((role) => bindings
    .filter((binding) => binding.role === role)
    .sort((left, right) => left.position - right.position || left.bindingId.localeCompare(right.bindingId))
    .map((binding, position) => ({ ...binding, position })));
}

/** Moves one binding inside its role without allowing cross-role reordering. */
export function moveRoleBinding(
  bindings: readonly AiRoleBinding[],
  role: AiProviderRole,
  index: number,
  offset: -1 | 1,
): readonly AiRoleBinding[] {
  const roleBindings = bindings
    .filter((binding) => binding.role === role)
    .sort((left, right) => left.position - right.position);
  const target = index + offset;
  if (index < 0 || index >= roleBindings.length || target < 0 || target >= roleBindings.length) {
    return orderRoleBindings(bindings);
  }
  [roleBindings[index], roleBindings[target]] = [roleBindings[target], roleBindings[index]];
  const moved = roleBindings.map((binding, position) => ({ ...binding, position }));
  return orderRoleBindings([
    ...bindings.filter((binding) => binding.role !== role),
    ...moved,
  ]);
}

/** Builds a complete replacement payload only when every draft remains snapshot-compatible. */
export function buildReplaceBindingsInput(
  snapshot: AiProviderHubSnapshot,
  bindings: readonly AiRoleBinding[],
): ReplaceAiBindingsInput | null {
  const ordered = orderRoleBindings(bindings);
  const bindingIds = new Set<string>();
  const choices = new Set<string>();
  for (const binding of ordered) {
    const connection = snapshot.connections.find((candidate) => (
      candidate.connectionId === binding.connectionId
      && candidate.hasCredential
      && hasPolicyAcknowledgement(candidate, binding.operationId)
    ));
    const provider = connection
      ? snapshot.catalog.find((candidate) => candidate.id === connection.providerId)
      : undefined;
    const operationExists = provider?.operations.some((operation) => (
      operation.id === binding.operationId && operation.role === binding.role
    )) === true;
    const choice = `${binding.role}:${bindingOptionKey(binding.connectionId, binding.operationId)}`;
    if (
      !connection
      || !provider
      || !operationExists
      || !isAiOperationCompatible(provider.id, binding.role, binding.operationId)
      || bindingIds.has(binding.bindingId)
      || choices.has(choice)
    ) return null;
    bindingIds.add(binding.bindingId);
    choices.add(choice);
  }
  const parsed = ReplaceAiBindingsInputSchema.safeParse({
    bindings: ordered,
    expectedRevision: snapshot.bindingRevision,
  });
  return parsed.success ? parsed.data : null;
}

function hasPolicyAcknowledgement(connection: AiConnectionSnapshot, operationId: AiProviderOperationId): boolean {
  const policy = resolveAiAuthPolicy(connection.providerId, operationId, connection.authKind);
  return policy !== null
    && connection.acknowledgement.generalWarningVersion === policy.disclosures[0]?.version
    && connection.acknowledgement.providerWarningVersion === policy.disclosures[1]?.version;
}

/** Saves a complete, revision-bound binding replacement. */
export async function submitRoleBindings(
  api: SarahAiProvidersApi,
  input: ReplaceAiBindingsInput,
): Promise<AiUiActionOutcome> {
  try {
    return mutationOutcome(await api.replaceBindings(input), 'Rollenbindungen gespeichert.');
  } catch {
    return { ok: false, message: TRANSPORT_FAILURE };
  }
}

function mutationOutcome(
  result: AiHubMutationResult,
  successMessage: string,
): AiUiActionOutcome {
  return result.ok
    ? { ok: true, message: successMessage, snapshot: result.snapshot }
    : {
        ok: false,
        message: result.message,
        ...(result.snapshot ? { snapshot: result.snapshot } : {}),
      };
}
