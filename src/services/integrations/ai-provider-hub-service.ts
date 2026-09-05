import { randomUUID } from 'crypto';
import {
  AcknowledgeAiWarningsInputSchema,
  AiProviderHubSnapshotSchema,
  CheckAiConnectionHealthInputSchema,
  DeleteAiConnectionInputSchema,
  ReplaceAiBindingsInputSchema,
  SaveAiApiKeyInputSchema,
  type AiHubErrorCode,
  type AiHubMutationResult,
  type AiProviderHubSnapshot,
  type AcknowledgeAiWarningsInput,
  type CheckAiConnectionHealthInput,
  type DeleteAiConnectionInput,
  type ReplaceAiBindingsInput,
  type SaveAiApiKeyInput,
  type AiRoleBinding,
  type AiProviderRole,
  type AiProviderId,
  type AiProviderOperationId,
  type AiConnectionHealth,
} from '../../core/ai-provider-contract.js';
import { CODEX_MANAGED_CHATGPT_NOTICE, resolveAiAuthPolicy } from './ai-auth-policy.js';
import {
  AiCredentialStore,
  type AiCredentialIdentity,
} from './ai-credential-store.js';
import {
  AI_GENERAL_COST_WARNING,
  AI_PROVIDER_CATALOG,
  getAiProviderCatalogEntry,
} from './ai-provider-catalog.js';
import {
  AiProviderHubStore,
  AiProviderHubStoreDegradedError,
  AiProviderHubStoreOperationError,
  AiProviderHubStoreRevisionConflictError,
  AiProviderHubStoreValidationError,
  type AiProviderConnectionMetadata,
} from './ai-provider-hub-store.js';

const SAFE_MESSAGES: Readonly<Record<AiHubErrorCode, string>> = Object.freeze({
  invalid_input: 'Die Angaben für die KI-Verbindung sind ungültig.',
  unknown_provider: 'Dieser KI-Anbieter wird nicht unterstützt.',
  acknowledgement_required: 'Bitte bestätige zuerst die Hinweise zu den separaten API-Kosten.',
  stale_acknowledgement: 'Der Kostenhinweis wurde aktualisiert. Bitte lies und bestätige ihn erneut.',
  connection_not_found: 'Die ausgewählte KI-Verbindung wurde nicht gefunden.',
  revision_conflict: 'Die KI-Einstellungen wurden zwischenzeitlich geändert. Bitte lade sie neu.',
  health_adapter_unavailable: 'Die technische Prüfung folgt mit dem Anbieteradapter.',
  storage_degraded: 'Der Speicher für diese KI-Verbindung ist beschädigt und bleibt unverändert.',
  operation_failed: 'Die KI-Verbindung konnte nicht sicher geändert werden.',
});

export interface AiProviderHubServiceOptions {
  now?: () => number;
  createId?: () => string;
  healthCheck?: (connection: AiProviderConnectionMetadata, credential: string | null) => Promise<AiConnectionHealth>;
  isOperationReady?: (operationId: AiProviderOperationId) => boolean;
  isModelSupported?: (operationId: AiProviderOperationId, modelId: string) => boolean;
  beforeConnectionChange?: (connectionId: string, credentialGeneration: number) => Promise<boolean>;
  managedSessionAvailable?: (connectionId: string) => boolean;
}

export interface AiResolvedBinding extends AiRoleBinding {
  readonly providerId: AiProviderId;
  readonly authKind: 'api_key' | 'codex_managed_chatgpt';
  readonly credentialGeneration: number;
  readonly modelId: string;
}

/**
 * Coordinates the local, provider-neutral AI connection foundation.
 *
 * - Publishes credentials before matching non-secret metadata and rolls back failures.
 * - Serializes all mutations and validates warning/binding revisions at publication time.
 * - Exposes only sanitized snapshots and never performs a provider request in Slice 1.
 *
 * @category External Integration Service
 */
export class AiProviderHubService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private mutationQueue: Promise<void> = Promise.resolve();
  private destroyed = false;
  private readonly health = new Map<string, AiConnectionHealth>();
  private readonly blocked = new Set<string>();

  constructor(
    private readonly metadataStore: AiProviderHubStore,
    private readonly credentialStore: AiCredentialStore,
    private readonly options: AiProviderHubServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? randomUUID;
  }

  snapshot(): AiProviderHubSnapshot {
    const stored = this.metadataStore.snapshot();
    const storageStatus = this.metadataStore.getStatus();
      const connections = stored.connections.map((connection) => {
      try {
        const identity = connection.authKind === 'api_key' ? this.identity(connection) : null;
        const credentialStatus = identity ? this.credentialStore.status(identity) : { state: 'ready' as const };
        const hasCredential = credentialStatus.state === 'degraded'
          ? false
          : identity ? this.credentialStore.has(identity)
          : this.options.managedSessionAvailable?.(connection.connectionId) === true;
        const acknowledgementIsCurrent = this.hasCurrentAcknowledgement(connection);
        return {
          ...connection,
          hasCredential,
          health: credentialStatus.state === 'degraded'
            ? {
                state: 'storage_degraded' as const,
                message: SAFE_MESSAGES.storage_degraded,
              }
            : {
                ...(hasCredential && acknowledgementIsCurrent && !this.blocked.has(connection.connectionId)
                  ? this.health.get(connection.connectionId) : undefined),
                state: hasCredential
                  ? (acknowledgementIsCurrent && !this.blocked.has(connection.connectionId)
                    ? this.health.get(connection.connectionId)?.state : undefined) ?? 'credential_saved_unverified' as const
                  : 'not_configured' as const,
                ...(!acknowledgementIsCurrent
                  ? { message: SAFE_MESSAGES.stale_acknowledgement }
                  : credentialStatus.state === 'recovered'
                  ? { message: credentialStatus.message }
                  : {}),
              },
        };
      } catch {
        return {
          ...connection,
          hasCredential: false,
          health: {
            state: 'storage_degraded' as const,
            message: SAFE_MESSAGES.storage_degraded,
          },
        };
      }
    });
    return AiProviderHubSnapshotSchema.parse({
      generalWarning: AI_GENERAL_COST_WARNING,
      catalog: AI_PROVIDER_CATALOG,
      connections,
      bindings: stored.bindings,
      bindingRevision: stored.bindingRevision,
      storage: storageStatus,
    });
  }

  saveApiKey(input: SaveAiApiKeyInput): Promise<AiHubMutationResult> {
    return this.enqueue(async () => {
      if (this.destroyed) return this.failure('operation_failed');
      const parsed = SaveAiApiKeyInputSchema.safeParse(input);
      if (!parsed.success) return this.failure('invalid_input');
      const catalog = getAiProviderCatalogEntry(parsed.data.providerId);
      const acknowledgement = parsed.data.acknowledgement;
      if (!acknowledgement.generalWarningVersion) {
        return this.failure('acknowledgement_required');
      }
      if (acknowledgement.generalWarningVersion !== catalog.generalWarningVersion) {
        return this.failure('stale_acknowledgement');
      }
      if (catalog.providerWarning) {
        if (!acknowledgement.providerWarningVersion) {
          return this.failure('acknowledgement_required');
        }
        if (acknowledgement.providerWarningVersion !== catalog.providerWarning.version) {
          return this.failure('stale_acknowledgement');
        }
      } else if (acknowledgement.providerWarningVersion !== undefined) {
        return this.failure('invalid_input');
      }

      const stored = this.metadataStore.snapshot();
      if (this.metadataStore.getStatus().state === 'degraded') {
        return this.failure('storage_degraded');
      }
      const existing = stored.connections.find((connection) => (
        connection.providerId === parsed.data.providerId && connection.authKind === 'api_key'
      ));
      const timestamp = new Date(this.now()).toISOString();
      const metadata: AiProviderConnectionMetadata = existing
        ? {
            ...existing,
            credentialGeneration: (existing.credentialGeneration ?? 1) + 1,
            acknowledgement,
            updatedAt: timestamp,
          }
        : {
            connectionId: this.createId(),
            providerId: parsed.data.providerId,
            authKind: 'api_key',
            credentialGeneration: 1,
            displayLabel: `${catalog.displayName} API`,
            acknowledgement,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
      const identity = this.identity(metadata);
      let previousKey: string | undefined;
      try {
        if (existing && !await this.prepareConnectionChange(existing)) return this.failure('operation_failed');
        const credentialStatus = this.credentialStore.status(identity);
        if (credentialStatus.state === 'degraded') return this.failure('storage_degraded');
        previousKey = this.credentialStore.read(identity);
        this.credentialStore.write(identity, parsed.data.apiKey);
        this.metadataStore.upsertConnection(metadata, stored.generation);
        this.blocked.delete(metadata.connectionId);
        return { ok: true, snapshot: this.snapshot() };
      } catch (error) {
        const published = this.connectionMatchesPublishedMetadata(metadata);
        if (published === true) return { ok: true, snapshot: this.snapshot() };
        try {
          if (previousKey) this.credentialStore.write(identity, previousKey);
          else this.credentialStore.delete(identity);
        } catch {
          return this.failure('storage_degraded');
        }
        return this.failure(this.mapStoreError(error));
      }
    });
  }

  acknowledgeWarnings(input: AcknowledgeAiWarningsInput): Promise<AiHubMutationResult> {
    return this.enqueue(async () => {
      if (this.destroyed) return this.failure('operation_failed');
      const parsed = AcknowledgeAiWarningsInputSchema.safeParse(input);
      if (!parsed.success) return this.failure('invalid_input');
      const stored = this.metadataStore.snapshot();
      if (this.metadataStore.getStatus().state === 'degraded') {
        return this.failure('storage_degraded');
      }
      const connection = stored.connections.find(
        (candidate) => candidate.connectionId === parsed.data.connectionId,
      );
      if (!connection) return this.failure('connection_not_found');
      const catalog = getAiProviderCatalogEntry(connection.providerId);
      const acknowledgement = parsed.data.acknowledgement;
      if (!acknowledgement.generalWarningVersion) {
        return this.failure('acknowledgement_required');
      }
      const requiredVersion = connection.authKind === 'codex_managed_chatgpt'
        ? CODEX_MANAGED_CHATGPT_NOTICE.version : catalog.generalWarningVersion;
      if (acknowledgement.generalWarningVersion !== requiredVersion) {
        return this.failure('stale_acknowledgement');
      }
      if (catalog.providerWarning) {
        if (!acknowledgement.providerWarningVersion) {
          return this.failure('acknowledgement_required');
        }
        if (acknowledgement.providerWarningVersion !== catalog.providerWarning.version) {
          return this.failure('stale_acknowledgement');
        }
      } else if (acknowledgement.providerWarningVersion !== undefined) {
        return this.failure('invalid_input');
      }
      const updated: AiProviderConnectionMetadata = {
        ...connection,
        acknowledgement,
        updatedAt: new Date(this.now()).toISOString(),
      };
      try {
        this.metadataStore.upsertConnection(updated, stored.generation);
        return { ok: true, snapshot: this.snapshot() };
      } catch (error) {
        if (this.connectionMatchesPublishedMetadata(updated) === true) {
          return { ok: true, snapshot: this.snapshot() };
        }
        return this.failure(this.mapStoreError(error));
      }
    });
  }

  deleteConnection(input: DeleteAiConnectionInput): Promise<AiHubMutationResult> {
    return this.enqueue(async () => {
      if (this.destroyed) return this.failure('operation_failed');
      const parsedId = this.parseConnectionId(input);
      if (!parsedId) return this.failure('invalid_input');
      const stored = this.metadataStore.snapshot();
      if (this.metadataStore.getStatus().state === 'degraded') {
        return this.failure('storage_degraded');
      }
      const connection = stored.connections.find((candidate) => candidate.connectionId === parsedId);
      if (!connection) return this.failure('connection_not_found');
      if (!await this.prepareConnectionChange(connection)) return this.failure('operation_failed');
      const identity = connection.authKind === 'api_key' ? this.identity(connection) : null;
      let previousKey: string | undefined;
      try {
        previousKey = identity ? this.credentialStore.read(identity) : undefined;
        if (identity) this.credentialStore.delete(identity);
        this.metadataStore.deleteConnection(connection.connectionId, stored.generation);
        return { ok: true, snapshot: this.snapshot() };
      } catch (error) {
        const connectionStillExists = this.connectionExistsInPublishedMetadata(
          connection.connectionId,
        );
        if (connectionStillExists === false) {
          return { ok: true, snapshot: this.snapshot() };
        }
      if (connectionStillExists === true && previousKey && identity) {
          // Revoked keys are never restored after an ambiguous metadata failure.
          return this.failure('storage_degraded');
        }
        return this.failure(this.mapStoreError(error));
      }
    });
  }

  replaceBindings(input: ReplaceAiBindingsInput): Promise<AiHubMutationResult> {
    return this.enqueue(async () => {
      if (this.destroyed) return this.failure('operation_failed');
      const parsed = ReplaceAiBindingsInputSchema.safeParse(input);
      if (!parsed.success) return this.failure('invalid_input');
      const stored = this.metadataStore.snapshot();
      if (this.metadataStore.getStatus().state === 'degraded') {
        return this.failure('storage_degraded');
      }
      try {
        if (parsed.data.bindings.some((binding) => binding.modelId
          && this.options.isModelSupported?.(binding.operationId, binding.modelId) === false)) {
          return this.failure('invalid_input');
        }
        const hasStaleAcknowledgement = parsed.data.bindings.some((binding) => {
          const connection = stored.connections.find(
            (candidate) => candidate.connectionId === binding.connectionId,
          );
          return connection !== undefined && !this.hasCurrentAcknowledgement(connection);
        });
        if (hasStaleAcknowledgement) return this.failure('stale_acknowledgement');
        this.metadataStore.replaceBindings(
          parsed.data.bindings.map(({ revision: _revision, ...binding }) => binding),
          parsed.data.expectedRevision,
          stored.generation,
        );
        return { ok: true, snapshot: this.snapshot() };
      } catch (error) {
        return this.failure(this.mapStoreError(error));
      }
    });
  }

  checkHealth(input: CheckAiConnectionHealthInput): Promise<AiHubMutationResult> {
    return this.enqueue(async () => {
      if (this.destroyed) return this.failure('operation_failed');
      const parsedId = this.parseConnectionId(input);
      if (!parsedId) return this.failure('invalid_input');
      const connection = this.metadataStore.snapshot().connections.find(
        (connection) => connection.connectionId === parsedId,
      );
      if (!connection) return this.failure('connection_not_found');
      if (!this.hasCurrentAcknowledgement(connection)) return this.failure('stale_acknowledgement');
      if (!this.options.healthCheck) return this.failure('health_adapter_unavailable');
      if (this.blocked.has(parsedId)) return this.failure('operation_failed');
      this.health.set(parsedId, { state: 'checking' });
      try {
        const credential = connection.authKind === 'api_key'
          ? this.credentialStore.read(this.identity(connection)) ?? null : null;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            this.options.healthCheck(connection, credential),
            new Promise<AiConnectionHealth>((resolve) => {
              timeout = setTimeout(() => resolve({ state: 'temporarily_unavailable' }), 10_000);
            }),
          ]);
          if (!this.destroyed && !this.blocked.has(parsedId)) {
            this.health.set(parsedId, { state: result.state, lastCheckedAt: new Date(this.now()).toISOString() });
          }
        } finally { if (timeout) clearTimeout(timeout); }
      } catch {
        this.health.set(parsedId, { state: 'temporarily_unavailable', lastCheckedAt: new Date(this.now()).toISOString() });
      }
      return { ok: true, snapshot: this.snapshot() };
    });
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Publishes metadata only after the owned Codex login confirms its session. */
  saveManagedConnection(input: { acknowledgement: AcknowledgeAiWarningsInput['acknowledgement'] }): Promise<AiHubMutationResult> {
    return this.enqueue(async () => {
      if (this.destroyed) return this.failure('operation_failed');
      if (input.acknowledgement.generalWarningVersion !== CODEX_MANAGED_CHATGPT_NOTICE.version
        || input.acknowledgement.providerWarningVersion !== undefined) return this.failure('stale_acknowledgement');
      const stored = this.metadataStore.snapshot();
      if (this.metadataStore.getStatus().state === 'degraded') return this.failure('storage_degraded');
      const existing = stored.connections.find((entry) => entry.authKind === 'codex_managed_chatgpt');
      if (existing && !await this.prepareConnectionChange(existing)) return this.failure('operation_failed');
      const timestamp = new Date(this.now()).toISOString();
      const connection: AiProviderConnectionMetadata = {
        connectionId: existing?.connectionId ?? this.createId(), providerId: 'openai',
        authKind: 'codex_managed_chatgpt', displayLabel: 'Codex – ChatGPT-Anmeldung',
        credentialGeneration: existing ? (existing.credentialGeneration ?? 1) + 1 : 1,
        acknowledgement: input.acknowledgement, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
      };
      try {
        this.metadataStore.upsertConnection(connection, stored.generation);
        this.blocked.delete(connection.connectionId);
        return { ok: true, snapshot: this.snapshot() };
      } catch (error) {
        return this.failure(this.mapStoreError(error));
      }
    });
  }

  /** Returns only an explicitly enabled, verified, configured operation lease. */
  resolveBinding(role: AiProviderRole): AiResolvedBinding | null {
    if (this.destroyed) return null;
    const snapshot = this.snapshot();
    if (snapshot.storage.state === 'degraded') return null;
    const candidates = snapshot.bindings.filter((binding) => binding.role === role)
      .sort((a, b) => a.position - b.position);
    // A disabled/unavailable primary may use the same billing mode, never switch paid paths.
    const primaryAuth = snapshot.connections.find((entry) => entry.connectionId === candidates[0]?.connectionId)?.authKind;
    for (const binding of candidates) {
      const connection = snapshot.connections.find((entry) => entry.connectionId === binding.connectionId);
      if (!binding.enabled || !binding.modelId || (role === 'text' && binding.cloudTextOptIn !== true)
        || !connection || connection.authKind !== primaryAuth || connection.health.state !== 'healthy'
        || !connection.hasCredential || this.blocked.has(connection.connectionId)
        || !this.hasCurrentAcknowledgement(connection)
        || !resolveAiAuthPolicy(connection.providerId, binding.operationId, connection.authKind)
        || this.options.isOperationReady?.(binding.operationId) !== true
        || this.options.isModelSupported?.(binding.operationId, binding.modelId) !== true) continue;
      return { ...binding, modelId: binding.modelId, providerId: connection.providerId,
        authKind: connection.authKind, credentialGeneration: connection.credentialGeneration ?? 1 };
    }
    return null;
  }

  /** Resolves API secrets only for the exact still-current connection generation. */
  resolveCredential(connectionId: string, providerId: AiProviderId, expectedGeneration?: number): string | null {
    if (this.destroyed || this.blocked.has(connectionId) || this.metadataStore.getStatus().state === 'degraded') return null;
    const connection = this.metadataStore.snapshot().connections.find((entry) => entry.connectionId === connectionId);
    if (!connection || connection.providerId !== providerId || connection.authKind !== 'api_key'
      || !this.hasCurrentAcknowledgement(connection)
      || (expectedGeneration !== undefined && expectedGeneration !== (connection.credentialGeneration ?? 1))
      || this.health.get(connectionId)?.state !== 'healthy') return null;
    try { return this.credentialStore.read(this.identity(connection)) ?? null; } catch { return null; }
  }

  /** Retrieves only an accepted job's original API identity after restart; never enables new work. */
  resolveRecoveryCredential(connectionId: string, providerId: AiProviderId, expectedGeneration?: number): string | null {
    if (expectedGeneration === undefined || this.destroyed || this.blocked.has(connectionId)
      || this.metadataStore.getStatus().state === 'degraded') return null;
    const connection = this.metadataStore.snapshot().connections.find((entry) => entry.connectionId === connectionId);
    if (!connection || connection.providerId !== providerId || connection.authKind !== 'api_key'
      || !this.hasCurrentAcknowledgement(connection)
      || expectedGeneration !== (connection.credentialGeneration ?? 1)) return null;
    try { return this.credentialStore.read(this.identity(connection)) ?? null; } catch { return null; }
  }

  /** Immediately prevents new selections; a subsequent health check cannot clear revocation. */
  invalidateConnection(connectionId: string): void {
    this.blocked.add(connectionId);
    this.health.delete(connectionId);
  }

  private async prepareConnectionChange(connection: AiProviderConnectionMetadata): Promise<boolean> {
    this.invalidateConnection(connection.connectionId);
    try {
      return await this.options.beforeConnectionChange?.(connection.connectionId, connection.credentialGeneration ?? 1) ?? true;
    } catch { return false; }
  }

  private parseConnectionId(
    input: DeleteAiConnectionInput | CheckAiConnectionHealthInput,
  ): string | null {
    const deleted = DeleteAiConnectionInputSchema.safeParse(input);
    if (deleted.success) return deleted.data.connectionId;
    const checked = CheckAiConnectionHealthInputSchema.safeParse(input);
    return checked.success ? checked.data.connectionId : null;
  }

  private identity(connection: AiProviderConnectionMetadata): AiCredentialIdentity {
    if (connection.authKind !== 'api_key') throw new Error('Not an API credential');
    return {
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authKind: connection.authKind,
    };
  }

  private hasCurrentAcknowledgement(connection: AiProviderConnectionMetadata): boolean {
    if (connection.authKind === 'codex_managed_chatgpt') {
      return connection.providerId === 'openai'
        && connection.acknowledgement.generalWarningVersion === CODEX_MANAGED_CHATGPT_NOTICE.version
        && connection.acknowledgement.providerWarningVersion === undefined;
    }
    const catalog = getAiProviderCatalogEntry(connection.providerId);
    return connection.acknowledgement.generalWarningVersion === catalog.generalWarningVersion
      && connection.acknowledgement.providerWarningVersion
        === catalog.providerWarning?.version;
  }

  private connectionMatchesPublishedMetadata(
    expected: AiProviderConnectionMetadata,
  ): boolean | null {
    try {
      const published = this.metadataStore.snapshot().connections.find(
        (connection) => connection.connectionId === expected.connectionId,
      );
      return published !== undefined
        && published.providerId === expected.providerId
        && published.authKind === expected.authKind
        && published.credentialGeneration === expected.credentialGeneration
        && published.updatedAt === expected.updatedAt
        && published.acknowledgement.generalWarningVersion
          === expected.acknowledgement.generalWarningVersion
        && published.acknowledgement.providerWarningVersion
          === expected.acknowledgement.providerWarningVersion;
    } catch {
      return null;
    }
  }

  private connectionExistsInPublishedMetadata(connectionId: string): boolean | null {
    try {
      return this.metadataStore.snapshot().connections.some(
        (connection) => connection.connectionId === connectionId,
      );
    } catch {
      return null;
    }
  }

  private failure(code: AiHubErrorCode): AiHubMutationResult {
    let snapshot: AiProviderHubSnapshot | undefined;
    try {
      snapshot = this.snapshot();
    } catch {
      // A safe stable error without a snapshot is preferable to leaking internals.
    }
    return {
      ok: false,
      code,
      message: SAFE_MESSAGES[code],
      ...(snapshot ? { snapshot } : {}),
    };
  }

  private mapStoreError(error: unknown): AiHubErrorCode {
    if (error instanceof AiProviderHubStoreRevisionConflictError) return 'revision_conflict';
    if (error instanceof AiProviderHubStoreDegradedError) return 'storage_degraded';
    if (error instanceof AiProviderHubStoreValidationError) return 'invalid_input';
    if (error instanceof AiProviderHubStoreOperationError) return 'operation_failed';
    return 'operation_failed';
  }

  private enqueue(operation: () => Promise<AiHubMutationResult>): Promise<AiHubMutationResult> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
