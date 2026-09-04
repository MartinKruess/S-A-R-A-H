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
} from '../../core/ai-provider-contract.js';
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

  constructor(
    private readonly metadataStore: AiProviderHubStore,
    private readonly credentialStore: AiCredentialStore,
    options: AiProviderHubServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? randomUUID;
  }

  snapshot(): AiProviderHubSnapshot {
    const stored = this.metadataStore.snapshot();
    const storageStatus = this.metadataStore.getStatus();
      const connections = stored.connections.map((connection) => {
      const identity = this.identity(connection);
      try {
        const credentialStatus = this.credentialStore.status(identity);
        const hasCredential = credentialStatus.state === 'degraded'
          ? false
          : this.credentialStore.has(identity);
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
                state: hasCredential
                  ? 'credential_saved_unverified' as const
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
            acknowledgement,
            updatedAt: timestamp,
          }
        : {
            connectionId: this.createId(),
            providerId: parsed.data.providerId,
            authKind: 'api_key',
            displayLabel: `${catalog.displayName} API`,
            acknowledgement,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
      const identity = this.identity(metadata);
      let previousKey: string | undefined;
      try {
        const credentialStatus = this.credentialStore.status(identity);
        if (credentialStatus.state === 'degraded') return this.failure('storage_degraded');
        previousKey = this.credentialStore.read(identity);
        this.credentialStore.write(identity, parsed.data.apiKey);
        this.metadataStore.upsertConnection(metadata, stored.generation);
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
      const identity = this.identity(connection);
      let previousKey: string | undefined;
      try {
        previousKey = this.credentialStore.read(identity);
        this.credentialStore.delete(identity);
        this.metadataStore.deleteConnection(connection.connectionId, stored.generation);
        return { ok: true, snapshot: this.snapshot() };
      } catch (error) {
        const connectionStillExists = this.connectionExistsInPublishedMetadata(
          connection.connectionId,
        );
        if (connectionStillExists === false) {
          return { ok: true, snapshot: this.snapshot() };
        }
        if (connectionStillExists === true && previousKey) {
          try {
            this.credentialStore.write(identity, previousKey);
          } catch {
            return this.failure('storage_degraded');
          }
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
      const exists = this.metadataStore.snapshot().connections.some(
        (connection) => connection.connectionId === parsedId,
      );
      return exists
        ? this.failure('health_adapter_unavailable')
        : this.failure('connection_not_found');
    });
  }

  destroy(): void {
    this.destroyed = true;
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
    return {
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authKind: connection.authKind,
    };
  }

  private hasCurrentAcknowledgement(connection: AiProviderConnectionMetadata): boolean {
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
