import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  AI_MAX_CONNECTIONS,
  AI_PROVIDER_ROLES,
  AiAuthKindSchema,
  AiCostAcknowledgementSchema,
  AiProviderIdSchema,
  AiRoleBindingSchema,
  isAiOperationCompatible,
  type AiProviderOperationId,
  type AiProviderRole,
  type AiRoleBinding,
} from '../../core/ai-provider-contract.js';
import { getAiProviderCatalogEntry } from './ai-provider-catalog.js';
import { CODEX_MANAGED_CHATGPT_NOTICE, resolveAiAuthPolicy } from './ai-auth-policy.js';

const STORE_FILE = 'ai-provider-hub.json';
const STORE_SCHEMA_VERSION = 1;
const ISO_TIMESTAMP = z.iso.datetime({ offset: true });
const MAX_BINDINGS = 30;

const StoredConnectionSchema = z.object({
  connectionId: z.uuid(),
  providerId: AiProviderIdSchema,
  authKind: AiAuthKindSchema,
  credentialGeneration: z.number().int().min(1).optional(),
  displayLabel: z.string().trim().min(1).max(100),
  acknowledgement: AiCostAcknowledgementSchema,
  createdAt: ISO_TIMESTAMP,
  updatedAt: ISO_TIMESTAMP,
}).strict().readonly();

const StoredSnapshotSchema = z.object({
  schemaVersion: z.literal(STORE_SCHEMA_VERSION),
  generation: z.number().int().min(1),
  commitId: z.uuid(),
  connections: z.array(StoredConnectionSchema).max(AI_MAX_CONNECTIONS).readonly(),
  bindings: z.array(AiRoleBindingSchema).max(MAX_BINDINGS).readonly(),
  bindingRevision: z.number().int().min(0),
}).strict().readonly();

export type AiProviderConnectionMetadata = z.infer<typeof StoredConnectionSchema>;

export interface AiRoleBindingDraft {
  readonly bindingId: string;
  readonly connectionId: string;
  readonly role: AiProviderRole;
  readonly operationId: AiProviderOperationId;
  readonly modelProfile: 'provider_default';
  readonly modelId?: string;
  readonly cloudTextOptIn?: boolean;
  readonly enabled: boolean;
  readonly position: number;
}

export interface AiProviderHubStoreSnapshot {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly commitId: string;
  readonly connections: readonly AiProviderConnectionMetadata[];
  readonly bindings: readonly AiRoleBinding[];
  readonly bindingRevision: number;
}

export type AiProviderHubStoreStatus =
  | { readonly state: 'ready' }
  | { readonly state: 'recovered'; readonly message: string }
  | { readonly state: 'degraded'; readonly message: string };

export type AiProviderHubStoreFaultPoint = 'after-backup-publish';

const DEGRADED_MESSAGE = 'Die KI-Anbieter-Konfiguration ist beschädigt und bleibt unverändert.';
const RECOVERED_MESSAGE = 'Die neueste gültige KI-Anbieter-Konfiguration wurde aus einer sicheren Kopie geladen.';
const INVALID_DATA_MESSAGE = 'Die KI-Anbieter-Konfiguration enthält ungültige Daten.';
const REVISION_CONFLICT_MESSAGE = 'Die KI-Anbieter-Konfiguration wurde zwischenzeitlich geändert.';
const OPERATION_FAILED_MESSAGE = 'Die KI-Anbieter-Konfiguration konnte nicht sicher gespeichert werden.';

export class AiProviderHubStoreDegradedError extends Error {
  constructor() {
    super(DEGRADED_MESSAGE);
    this.name = 'AiProviderHubStoreDegradedError';
  }
}

export class AiProviderHubStoreValidationError extends Error {
  constructor() {
    super(INVALID_DATA_MESSAGE);
    this.name = 'AiProviderHubStoreValidationError';
  }
}

export class AiProviderHubStoreRevisionConflictError extends Error {
  constructor() {
    super(REVISION_CONFLICT_MESSAGE);
    this.name = 'AiProviderHubStoreRevisionConflictError';
  }
}

export class AiProviderHubStoreOperationError extends Error {
  constructor() {
    super(OPERATION_FAILED_MESSAGE);
    this.name = 'AiProviderHubStoreOperationError';
  }
}

interface LoadResult {
  readonly snapshot: AiProviderHubStoreSnapshot;
  readonly status: AiProviderHubStoreStatus;
}

/**
 * Persists non-secret AI connection metadata and role bindings independently.
 *
 * - Selects the newest valid atomic primary/backup commit.
 * - Validates warning acknowledgement shape and every provider/role/operation reference.
 * - Owns monotonic binding revisions and rejects stale optimistic mutations.
 *
 * @category Data Access Validation
 */
export class AiProviderHubStore {
  private cached: AiProviderHubStoreSnapshot | null = null;
  private currentStatus: AiProviderHubStoreStatus = { state: 'ready' };

  constructor(
    private readonly storageDir: string,
    private readonly faultInjector?: (point: AiProviderHubStoreFaultPoint) => void,
  ) {}

  snapshot(): AiProviderHubStoreSnapshot {
    return this.copySnapshot(this.load());
  }

  getStatus(): AiProviderHubStoreStatus {
    this.load();
    return { ...this.currentStatus };
  }

  upsertConnection(
    connection: AiProviderConnectionMetadata,
    expectedGeneration: number,
  ): AiProviderHubStoreSnapshot {
    const current = this.assertWritable(expectedGeneration);
    const parsedConnection = this.parseConnection(connection);
    const existing = current.connections.find(
      (candidate) => candidate.connectionId === parsedConnection.connectionId,
    );
    if (existing && (
      existing.providerId !== parsedConnection.providerId
      || existing.authKind !== parsedConnection.authKind
      || existing.createdAt !== parsedConnection.createdAt
      || (parsedConnection.credentialGeneration ?? 1) < (existing.credentialGeneration ?? 1)
      || Date.parse(parsedConnection.updatedAt) < Date.parse(existing.updatedAt)
    )) throw new AiProviderHubStoreValidationError();

    const connections = existing
      ? current.connections.map((candidate) => (
          candidate.connectionId === parsedConnection.connectionId ? parsedConnection : candidate
        ))
      : [...current.connections, parsedConnection];
    return this.persist({
      connections,
      bindings: current.bindings,
      bindingRevision: current.bindingRevision,
    }, current);
  }

  deleteConnection(
    connectionId: string,
    expectedGeneration: number,
  ): AiProviderHubStoreSnapshot {
    const current = this.assertWritable(expectedGeneration);
    const parsedId = this.parseUuid(connectionId);
    const connections = current.connections.filter(
      (connection) => connection.connectionId !== parsedId,
    );
    if (connections.length === current.connections.length) return this.copySnapshot(current);
    const retainedBindings = current.bindings.filter((binding) => binding.connectionId !== parsedId);
    const removedBindings = retainedBindings.length !== current.bindings.length;
    const bindingRevision = removedBindings ? current.bindingRevision + 1 : current.bindingRevision;
    const revisedBindings = removedBindings
      ? this.orderAndCompactBindings(retainedBindings).map((binding) => ({
          ...binding,
          revision: bindingRevision,
        }))
      : retainedBindings;
    return this.persist({ connections, bindings: revisedBindings, bindingRevision }, current);
  }

  replaceBindings(
    bindings: readonly AiRoleBindingDraft[],
    expectedRevision: number,
    expectedGeneration: number,
  ): AiProviderHubStoreSnapshot {
    const current = this.assertWritable(expectedGeneration);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new AiProviderHubStoreValidationError();
    }
    if (expectedRevision !== current.bindingRevision) {
      throw new AiProviderHubStoreRevisionConflictError();
    }
    const nextRevision = current.bindingRevision + 1;
    const revisedBindings = bindings.map((binding): AiRoleBinding => ({
      ...binding,
      revision: nextRevision,
    }));
    return this.persist({
      connections: current.connections,
      bindings: revisedBindings,
      bindingRevision: nextRevision,
    }, current);
  }

  private load(): AiProviderHubStoreSnapshot {
    if (this.cached) return this.cached;
    const loaded = this.readCurrentDiskState();
    this.cached = loaded.snapshot;
    this.currentStatus = loaded.status;
    return this.cached;
  }

  private assertWritable(expectedGeneration: number): AiProviderHubStoreSnapshot {
    const current = this.load();
    if (this.currentStatus.state === 'degraded') throw new AiProviderHubStoreDegradedError();
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new AiProviderHubStoreValidationError();
    }
    if (expectedGeneration !== current.generation) {
      throw new AiProviderHubStoreRevisionConflictError();
    }

    const disk = this.readCurrentDiskState();
    if (disk.status.state === 'degraded') {
      this.cached = disk.snapshot;
      this.currentStatus = disk.status;
      throw new AiProviderHubStoreDegradedError();
    }
    if (
      disk.snapshot.generation !== current.generation
      || disk.snapshot.commitId !== current.commitId
    ) {
      this.cached = disk.snapshot;
      this.currentStatus = disk.status;
      throw new AiProviderHubStoreRevisionConflictError();
    }
    return current;
  }

  private persist(
    data: Pick<AiProviderHubStoreSnapshot, 'connections' | 'bindings' | 'bindingRevision'>,
    current: AiProviderHubStoreSnapshot,
  ): AiProviderHubStoreSnapshot {
    const candidate = {
      schemaVersion: STORE_SCHEMA_VERSION,
      generation: current.generation + 1,
      commitId: randomUUID(),
      connections: data.connections,
      bindings: data.bindings,
      bindingRevision: data.bindingRevision,
    } as const;
    const next = this.parseSnapshot(candidate);
    const paths = this.paths();
    const primaryTemp = path.join(
      this.storageDir,
      `.${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`,
    );
    const backupTemp = `${paths.backup}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(next);
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      this.writeDurably(primaryTemp, serialized);
      this.writeDurably(backupTemp, serialized);
      fs.renameSync(backupTemp, paths.backup);
      this.faultInjector?.('after-backup-publish');
      fs.renameSync(primaryTemp, paths.primary);
      this.cached = next;
      this.currentStatus = { state: 'ready' };
      return this.copySnapshot(next);
    } catch {
      this.cached = null;
      this.currentStatus = { state: 'ready' };
      throw new AiProviderHubStoreOperationError();
    } finally {
      this.removeTemp(primaryTemp);
      this.removeTemp(backupTemp);
    }
  }

  private readCurrentDiskState(): LoadResult {
    const paths = this.paths();
    let primaryExists: boolean;
    let backupExists: boolean;
    try {
      primaryExists = this.safeFileExists(paths.primary);
      backupExists = this.safeFileExists(paths.backup);
    } catch {
      return this.degradedState();
    }
    if (!primaryExists && !backupExists) {
      return { snapshot: this.emptySnapshot(), status: { state: 'ready' } };
    }

    const primary = primaryExists ? this.tryRead(paths.primary) : undefined;
    const backup = backupExists ? this.tryRead(paths.backup) : undefined;
    const selected = this.selectNewest(primary, backup);
    if (!selected) return this.degradedState();
    const copiesMatch = primary !== undefined
      && backup !== undefined
      && primary.generation === backup.generation
      && primary.commitId === backup.commitId;
    return {
      snapshot: selected,
      status: copiesMatch
        ? { state: 'ready' }
        : { state: 'recovered', message: RECOVERED_MESSAGE },
    };
  }

  private degradedState(): LoadResult {
    return {
      snapshot: this.emptySnapshot(),
      status: { state: 'degraded', message: DEGRADED_MESSAGE },
    };
  }

  private tryRead(filePath: string): AiProviderHubStoreSnapshot | undefined {
    try {
      return this.parseSnapshot(JSON.parse(fs.readFileSync(filePath, 'utf-8')) as object);
    } catch {
      return undefined;
    }
  }

  private parseSnapshot(value: object): AiProviderHubStoreSnapshot {
    const parsed = StoredSnapshotSchema.safeParse(value);
    if (!parsed.success || !this.hasValidInvariants(parsed.data)) {
      throw new AiProviderHubStoreValidationError();
    }
    return this.freezeSnapshot(parsed.data);
  }

  private parseConnection(value: AiProviderConnectionMetadata): AiProviderConnectionMetadata {
    const parsed = StoredConnectionSchema.safeParse(value);
    if (!parsed.success || !this.hasValidConnection(parsed.data)) {
      throw new AiProviderHubStoreValidationError();
    }
    return Object.freeze({
      ...parsed.data,
      acknowledgement: Object.freeze({ ...parsed.data.acknowledgement }),
    });
  }

  private hasValidInvariants(snapshot: z.infer<typeof StoredSnapshotSchema>): boolean {
    const connectionIds = new Set<string>();
    const providerAuth = new Set<string>();
    for (const connection of snapshot.connections) {
      if (!this.hasValidConnection(connection)) return false;
      if (connectionIds.has(connection.connectionId)) return false;
      connectionIds.add(connection.connectionId);
      const providerKey = `${connection.providerId}:${connection.authKind}`;
      if (providerAuth.has(providerKey)) return false;
      providerAuth.add(providerKey);
    }

    const bindingIds = new Set<string>();
    const positions = new Map<AiProviderRole, number[]>();
    for (const binding of snapshot.bindings) {
      if (bindingIds.has(binding.bindingId) || !connectionIds.has(binding.connectionId)) return false;
      bindingIds.add(binding.bindingId);
      const connection = snapshot.connections.find(
        (candidate) => candidate.connectionId === binding.connectionId,
      );
      if (!connection || !isAiOperationCompatible(
        connection.providerId,
        binding.role,
        binding.operationId,
      )) return false;
      if (!resolveAiAuthPolicy(connection.providerId, binding.operationId, connection.authKind)) {
        return false;
      }
      if (binding.revision !== snapshot.bindingRevision) return false;
      const rolePositions = positions.get(binding.role) ?? [];
      rolePositions.push(binding.position);
      positions.set(binding.role, rolePositions);
    }
    if (snapshot.bindings.length > 0 && snapshot.bindingRevision < 1) return false;
    return [...positions.values()].every((rolePositions) => (
      [...rolePositions].sort((left, right) => left - right)
        .every((position, index) => position === index)
    ));
  }

  private hasValidConnection(connection: AiProviderConnectionMetadata): boolean {
    const catalog = getAiProviderCatalogEntry(connection.providerId);
    const acknowledgement = connection.acknowledgement;
    return catalog.authKinds.includes(connection.authKind)
      && (connection.authKind === 'api_key' || connection.providerId === 'openai')
      && (connection.authKind !== 'codex_managed_chatgpt'
        || acknowledgement.generalWarningVersion === CODEX_MANAGED_CHATGPT_NOTICE.version)
      && (catalog.providerWarning
        ? acknowledgement.providerWarningVersion !== undefined
        : acknowledgement.providerWarningVersion === undefined)
      && Date.parse(connection.createdAt) <= Date.parse(connection.updatedAt);
  }

  private parseUuid(value: string): string {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new AiProviderHubStoreValidationError();
    return parsed.data;
  }

  private orderAndCompactBindings<T extends AiRoleBindingDraft>(
    bindings: readonly T[],
  ): readonly T[] {
    return AI_PROVIDER_ROLES.flatMap((role) => (
      bindings
        .filter((binding) => binding.role === role)
        .sort((left, right) => left.position - right.position)
        .map((binding, position) => ({ ...binding, position }))
    ));
  }

  private selectNewest(
    primary: AiProviderHubStoreSnapshot | undefined,
    backup: AiProviderHubStoreSnapshot | undefined,
  ): AiProviderHubStoreSnapshot | undefined {
    if (!primary) return backup;
    if (!backup) return primary;
    if (primary.generation !== backup.generation) {
      return primary.generation > backup.generation ? primary : backup;
    }
    return primary.commitId === backup.commitId ? primary : undefined;
  }

  private emptySnapshot(): AiProviderHubStoreSnapshot {
    return this.freezeSnapshot({
      schemaVersion: STORE_SCHEMA_VERSION,
      generation: 0,
      commitId: '00000000-0000-4000-8000-000000000000',
      connections: [],
      bindings: [],
      bindingRevision: 0,
    });
  }

  private freezeSnapshot(snapshot: AiProviderHubStoreSnapshot): AiProviderHubStoreSnapshot {
    return Object.freeze({
      schemaVersion: STORE_SCHEMA_VERSION,
      generation: snapshot.generation,
      commitId: snapshot.commitId,
      connections: Object.freeze(snapshot.connections.map((connection) => Object.freeze({
        ...connection,
        acknowledgement: Object.freeze({ ...connection.acknowledgement }),
      }))),
      bindings: Object.freeze(snapshot.bindings.map((binding) => Object.freeze({ ...binding }))),
      bindingRevision: snapshot.bindingRevision,
    });
  }

  private copySnapshot(snapshot: AiProviderHubStoreSnapshot): AiProviderHubStoreSnapshot {
    return this.freezeSnapshot(snapshot);
  }

  private paths(): { readonly primary: string; readonly backup: string } {
    const primary = path.resolve(this.storageDir, STORE_FILE);
    if (path.dirname(primary) !== path.resolve(this.storageDir)) {
      throw new AiProviderHubStoreValidationError();
    }
    return { primary, backup: `${primary}.bak` };
  }

  private safeFileExists(filePath: string): boolean {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe metadata file');
      return true;
    } catch (error) {
      if (this.errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private writeDurably(filePath: string, content: string): void {
    const handle = fs.openSync(filePath, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, content, 'utf-8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }

  private removeTemp(filePath: string): void {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Temporary files are never considered committed snapshots.
    }
  }

  private errorCode(error: unknown): string | null {
    if (error === null || typeof error !== 'object' || !('code' in error)) return null;
    const code = (error as { code?: string }).code;
    return typeof code === 'string' ? code : null;
  }
}
