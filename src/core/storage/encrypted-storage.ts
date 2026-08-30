import type {
  CompleteMemoryStagingInput,
  StorageProvider,
  Filter,
  MessageRow,
  MessagesPageQuery,
  TurnMessageWrite,
  Layer2MemoryPurgeResult,
  LegacyDbRecoveryCandidate,
  LegacyDbRecoveryResult,
  LegacyDbRecoveryReview,
  LegacyDbRecoveryWrite,
  Layer2LegacyPolicyPurgeInput,
} from './storage.interface.js';
import {
  LEGACY_DB_RECOVERY_CONFIRMATION,
  LEGACY_DB_RECOVERY_LOCATIONS,
} from './storage.interface.js';
import { encrypt, decrypt } from '../crypto/crypto.js';

const ENCRYPTED_VALUE_PREFIX_V2 = 'sarah-enc:v2:';
const ENCRYPTED_VALUE_PREFIX_V1 = 'sarah-enc:v1:';

/** Columns that are structural and intentionally remain filterable. */
const PASSTHROUGH_COLUMNS = new Set([
  'id', 'category', 'session_id', 'conversation_id', 'mode', 'role',
  'source', 'confidence', 'created_at', 'updated_at', 'started_at',
  'ended_at', 'timestamp', 'turn_id', 'state', 'attempts', 'lease_started_at',
  'source_staging_id', 'kind', 'source_conversation_id', 'source_turn_id',
  'deleted_at', 'close_status', 'source_table', 'source_row_id', 'column_name', 'reason',
  'quarantined_at', 'source_kind', 'firing_at', 'delivered_at', 'cancelled_at',
]);

const SAFE_EMPTY_LEGACY_COLUMNS = new Set([
  'conversations.summary',
  'memory_staging.source_content',
  'memory_staging.policy_terms',
]);

export interface StorageIntegrityFailure {
  location: string;
  message: string;
}

export interface EncryptedStorageOptions {
  onIntegrityFailure?: (failure: StorageIntegrityFailure) => void;
}

export class StorageIntegrityError extends Error {
  constructor(
    readonly location: string,
    readonly reason: 'cipher_authentication_failed' | 'unbound_legacy_ciphertext',
    cause: object,
  ) {
    super(`Encrypted value at ${location} failed authentication and was isolated from reads.`, { cause });
    this.name = 'StorageIntegrityError';
  }
}

interface DecryptedValue {
  value: unknown;
  legacy: boolean;
}

/**
 * Transparent authenticated-encryption wrapper.
 *
 * - V2 binds every protected value to its config key or table/row/column identity.
 * - Unbound config V1 values require the explicit, key-validated migration path.
 * - Plaintext and object downgrades fail closed.
 *
 * @category Data Access Security
 */
export class EncryptedStorage implements StorageProvider {
  private integrityFailures: StorageIntegrityFailure[] = [];

  constructor(
    private inner: StorageProvider,
    private key: Buffer,
    private options: EncryptedStorageOptions = {},
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.inner.get(key);
    if (raw === undefined) return undefined;
    const aad = this.keyAad(key);
    try {
      const decrypted = this.decryptValue(raw, aad);
      return decrypted.value as T;
    } catch (error) {
      if (!(error instanceof StorageIntegrityError) || !this.inner.recoverLastValidSnapshot) throw error;
      const recovered = await this.inner.recoverLastValidSnapshot();
      if (!recovered) throw error;
      const backupRaw = await this.inner.get(key);
      if (backupRaw === undefined) throw error;
      const decrypted = this.decryptValue(backupRaw, aad);
      return decrypted.value as T;
    }
  }

  /**
   * @param key - Erwarteter Config-Schluessel des ungebundenen Altwerts.
   * @param validate - Schluesselspezifische Validierung vor der Positionsbindung.
   *
   * - Entschluesselt ausschliesslich V1- oder unversionierte Legacy-Ciphertexte.
   * - Persistiert erst nach erfolgreicher semantischer Validierung als AAD-gebundenes V2.
   * - Laesst normale `get`-Aufrufe ungebundene Werte weiterhin strikt ablehnen.
   *
   * @returns `true`, wenn ein Legacy-Wert explizit migriert wurde.
   *
   * @category Data Access Security
   */
  async migrateLegacyConfigValue<T>(
    key: string,
    validate: (value: unknown) => T,
  ): Promise<boolean> {
    const raw = await this.inner.get(key);
    if (typeof raw !== 'string') return false;

    let legacyCiphertext: string;
    if (raw.startsWith(ENCRYPTED_VALUE_PREFIX_V1)) {
      legacyCiphertext = raw.slice(ENCRYPTED_VALUE_PREFIX_V1.length);
    } else if (this.looksLikeLegacyCiphertext(raw)) {
      legacyCiphertext = raw;
    } else {
      return false;
    }

    const location = `legacy-config-review:${key}`;
    const value = this.decryptAuthenticated(legacyCiphertext, location);
    const validated = validate(value);
    await this.inner.set(key, this.encryptValue(validated, this.keyAad(key)));
    return true;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.inner.set(key, this.encryptValue(value, this.keyAad(key)));
  }

  async query<T = Record<string, unknown>>(table: string, filter?: Filter): Promise<T[]> {
    const rows = await this.inner.query<Record<string, unknown>>(table, filter);
    const readable: Record<string, unknown>[] = [];
    for (const row of rows) {
      try {
        const { row: decrypted, migrated } = this.decryptRow(row, table);
        readable.push(decrypted);
        if (Object.keys(migrated).length > 0 && typeof row.id === 'number') {
          await this.inner.update(table, { id: row.id }, migrated);
        }
      } catch (error) {
        if (!(error instanceof StorageIntegrityError)) throw error;
        await this.quarantineRow(table, row, error);
      }
    }
    return readable as T[];
  }

  async insert(table: string, data: Record<string, unknown>): Promise<number> {
    const protectedColumns = Object.keys(data).filter((column) =>
      !PASSTHROUGH_COLUMNS.has(column) && data[column] !== null && data[column] !== undefined,
    );
    if (protectedColumns.length === 0) return this.inner.insert(table, data);

    const suppliedId = data.id;
    const id = typeof suppliedId === 'number'
      ? suppliedId
      : (await this.inner.reserveRowIds(table, 1))[0];
    return this.inner.insert(table, this.encryptRow({ ...data, id }, table, id));
  }

  async reserveRowIds(table: string, count: number): Promise<number[]> {
    return this.inner.reserveRowIds(table, count);
  }

  async insertTurnMessages(
    conversationId: number,
    turnId: string,
    messages: readonly TurnMessageWrite[],
  ): Promise<void> {
    if (messages.length === 0) return;
    const ids = await this.inner.reserveRowIds('messages', messages.length);
    await this.inner.insertTurnMessages(
      conversationId,
      turnId,
      messages.map((message, index) => ({
        ...message,
        id: ids[index],
        content: this.encryptValue(message.content, this.rowAad('messages', ids[index], 'content')),
      })),
    );
  }

  async persistTurnWithMemoryStaging(
    conversationId: number,
    turnId: string,
    messages: readonly TurnMessageWrite[],
    stagingSource: string,
    policyTerms = '',
  ): Promise<number> {
    const messageIds = messages.length > 0
      ? await this.inner.reserveRowIds('messages', messages.length)
      : [];
    const stagingId = (await this.inner.reserveRowIds('memory_staging', 1))[0];
    return this.inner.persistTurnWithMemoryStaging(
      conversationId,
      turnId,
      messages.map((message, index) => ({
        ...message,
        id: messageIds[index],
        content: this.encryptValue(message.content, this.rowAad('messages', messageIds[index], 'content')),
      })),
      this.encryptValue(stagingSource, this.rowAad('memory_staging', stagingId, 'source_content')),
      this.encryptValue(policyTerms, this.rowAad('memory_staging', stagingId, 'policy_terms')),
      stagingId,
    );
  }

  async deleteTurnMessages(conversationId: number, turnId: string): Promise<number> {
    return this.inner.deleteTurnMessages(conversationId, turnId);
  }

  async completeMemoryStaging(input: CompleteMemoryStagingInput): Promise<void> {
    const id = (await this.inner.reserveRowIds('curated_memories', 1))[0];
    await this.inner.completeMemoryStaging({
      ...input,
      memory: {
        ...input.memory,
        id,
        content: this.encryptValue(input.memory.content, this.rowAad('curated_memories', id, 'content')),
      },
    });
  }

  async discardMemoryStaging(stagingId: number): Promise<void> {
    await this.inner.discardMemoryStaging(stagingId);
  }

  async failMemoryStaging(stagingId: number): Promise<void> {
    await this.inner.failMemoryStaging(stagingId);
  }

  async purgeAllLayer2Memory(): Promise<Layer2MemoryPurgeResult> {
    const conversations = await this.inner.query<{ id: number }>('conversations');
    return this.inner.purgeAllLayer2Memory(conversations.map(({ id }) => ({
      id,
      value: this.encryptValue('', this.rowAad('conversations', id, 'summary')),
    })));
  }

  async deleteAllCuratedMemories(expectedIds: readonly number[]): Promise<number> {
    if (!this.inner.deleteAllCuratedMemories) {
      throw new Error('Storage provider does not support atomic curated-memory deletion');
    }
    return this.inner.deleteAllCuratedMemories(expectedIds);
  }

  async purgeQuarantinedLayer2Memory(): Promise<Layer2MemoryPurgeResult> {
    return this.inner.purgeQuarantinedLayer2Memory();
  }

  async purgeLayer2LegacyMemory(input: Layer2LegacyPolicyPurgeInput): Promise<number> {
    return this.inner.purgeLayer2LegacyMemory(input);
  }

  async reviewLegacyDbRecovery(): Promise<LegacyDbRecoveryReview> {
    const candidates = await this.getLegacyRecoveryCandidates();
    return {
      candidates: candidates.map(({ legacyCiphertext, ...candidate }) => {
        const value = this.decryptLegacyForRecovery(legacyCiphertext, candidate);
        if (typeof value !== 'string') {
          throw new Error(`Legacy recovery candidate ${candidate.quarantineId} does not contain a string`);
        }
        return {
          ...candidate,
          preview: value.replace(/\s+/g, ' ').slice(0, 160),
        };
      }),
      warning: 'Diese Werte stammen aus alter, nicht an Tabelle und Zeile gebundener Verschlüsselung. Ihre ursprüngliche Position kann kryptographisch nicht bewiesen werden. Nur nach manueller Prüfung wiederherstellen.',
    };
  }

  async restoreLegacyDbRecovery(
    quarantineIds: readonly number[],
    confirmation: string,
  ): Promise<LegacyDbRecoveryResult> {
    if (confirmation !== LEGACY_DB_RECOVERY_CONFIRMATION) {
      throw new Error('Explicit legacy DB recovery confirmation is required');
    }
    if (!this.inner.restoreReviewedLegacyDbValues) {
      throw new Error('This storage provider does not support legacy DB recovery');
    }
    const selected = new Set(quarantineIds);
    if (selected.size === 0 || selected.size !== quarantineIds.length
      || [...selected].some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new Error('Legacy DB recovery requires unique positive quarantine IDs');
    }
    const candidates = await this.getLegacyRecoveryCandidates();
    const byId = new Map(candidates.map((candidate) => [candidate.quarantineId, candidate]));
    const writes: LegacyDbRecoveryWrite[] = [];
    for (const quarantineId of quarantineIds) {
      const candidate = byId.get(quarantineId);
      if (!candidate) throw new Error(`Legacy recovery candidate ${quarantineId} is not reviewable`);
      const value = this.decryptLegacyForRecovery(candidate.legacyCiphertext, candidate);
      if (typeof value !== 'string') {
        throw new Error(`Legacy recovery candidate ${quarantineId} does not contain a string`);
      }
      writes.push({
        ...candidate,
        encryptedValue: this.encryptValue(
          value,
          this.rowAad(candidate.table, candidate.rowId, candidate.column),
        ),
      });
    }
    return this.inner.restoreReviewedLegacyDbValues(confirmation, writes);
  }

  async update(table: string, filter: Filter, data: Record<string, unknown>): Promise<number> {
    const protectedColumns = Object.keys(data).filter((column) =>
      !PASSTHROUGH_COLUMNS.has(column) && data[column] !== null && data[column] !== undefined,
    );
    if (protectedColumns.length === 0) return this.inner.update(table, filter, data);

    const rows = await this.inner.query<Record<string, unknown>>(table, filter);
    let changed = 0;
    for (const row of rows) {
      if (typeof row.id !== 'number') throw new Error(`Protected update on ${table} requires a numeric row id`);
      changed += await this.inner.update(table, { id: row.id }, this.encryptRow(data, table, row.id));
    }
    return changed;
  }

  async delete(table: string, filter: Filter): Promise<number> {
    return this.inner.delete(table, filter);
  }

  async finalizePrivacyDeletion(): Promise<void> {
    await this.inner.finalizePrivacyDeletion?.();
  }

  async queryMessagesPage(query: MessagesPageQuery): Promise<MessageRow[]> {
    const rows = await this.inner.queryMessagesPage(query);
    const readable: MessageRow[] = [];
    for (const row of rows) {
      const aad = this.rowAad('messages', row.id, 'content');
      try {
        const decrypted = this.decryptValue(row.content, aad);
        readable.push({ ...row, content: decrypted.value as string });
        if (decrypted.legacy) {
          await this.inner.update('messages', { id: row.id }, {
            content: this.encryptValue(decrypted.value, aad),
          });
        }
      } catch (error) {
        if (!(error instanceof StorageIntegrityError)) throw error;
        await this.quarantineRow('messages', { ...row }, error);
      }
    }
    return readable;
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  getIntegrityFailures(): readonly StorageIntegrityFailure[] {
    return [...this.integrityFailures];
  }

  private encryptValue(value: unknown, aad: string): string {
    return `${ENCRYPTED_VALUE_PREFIX_V2}${encrypt(JSON.stringify(value), this.key, aad)}`;
  }

  private encryptRow(
    row: Record<string, unknown>,
    table: string,
    rowId: number,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      result[column] = PASSTHROUGH_COLUMNS.has(column) || value === null || value === undefined
        ? value
        : this.encryptValue(value, this.rowAad(table, rowId, column));
    }
    return result;
  }

  private decryptRow(
    row: Record<string, unknown>,
    table: string,
  ): { row: Record<string, unknown>; migrated: Record<string, unknown> } {
    if (typeof row.id !== 'number') throw new Error(`Protected read on ${table} requires a numeric row id`);
    const result: Record<string, unknown> = {};
    const migrated: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      if (PASSTHROUGH_COLUMNS.has(column) || value === null || value === undefined) {
        result[column] = value;
        continue;
      }
      const aad = this.rowAad(table, row.id, column);
      const decrypted = value === '' && SAFE_EMPTY_LEGACY_COLUMNS.has(`${table}.${column}`)
        ? { value: '', legacy: true }
        : this.decryptValue(value, aad);
      result[column] = decrypted.value;
      if (decrypted.legacy) migrated[column] = this.encryptValue(decrypted.value, aad);
    }
    return { row: result, migrated };
  }

  private decryptValue(value: unknown, aad: string, allowUnboundLegacy = false): DecryptedValue {
    if (typeof value !== 'string') {
      throw this.integrityError(aad, new Error('Protected storage value is not an encrypted string'));
    }
    if (value.startsWith(ENCRYPTED_VALUE_PREFIX_V2)) {
      return { value: this.decryptAuthenticated(value.slice(ENCRYPTED_VALUE_PREFIX_V2.length), aad, aad), legacy: false };
    }
    if (value.startsWith(ENCRYPTED_VALUE_PREFIX_V1)) {
      if (!allowUnboundLegacy) {
        throw this.integrityError(
          aad,
          new Error('Unbound V1 database ciphertext requires explicit reviewed recovery'),
          'unbound_legacy_ciphertext',
        );
      }
      return { value: this.decryptAuthenticated(value.slice(ENCRYPTED_VALUE_PREFIX_V1.length), aad), legacy: true };
    }
    if (this.looksLikeLegacyCiphertext(value)) {
      if (!allowUnboundLegacy) {
        throw this.integrityError(
          aad,
          new Error('Unbound legacy database ciphertext requires explicit reviewed recovery'),
          'unbound_legacy_ciphertext',
        );
      }
      return { value: this.decryptAuthenticated(value, aad), legacy: true };
    }
    throw this.integrityError(aad, new Error('Unversioned plaintext downgrade rejected'));
  }

  private decryptAuthenticated(ciphertext: string, location: string, aad?: string): unknown {
    try {
      return JSON.parse(decrypt(ciphertext, this.key, aad)) as unknown;
    } catch (error) {
      throw this.integrityError(
        location,
        error instanceof Error ? error : new Error('Unknown authentication failure'),
      );
    }
  }

  private integrityError(
    location: string,
    cause: Error,
    reason: 'cipher_authentication_failed' | 'unbound_legacy_ciphertext' = 'cipher_authentication_failed',
  ): StorageIntegrityError {
    const failure = { location, message: cause.message };
    this.integrityFailures.push(failure);
    this.options.onIntegrityFailure?.(failure);
    return new StorageIntegrityError(location, reason, cause);
  }

  private looksLikeLegacyCiphertext(value: string): boolean {
    if (value.length < 40 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    const decoded = Buffer.from(value, 'base64');
    return decoded.length >= 29 && decoded.toString('base64') === value;
  }

  private async quarantineRow(
    table: string,
    row: Record<string, unknown>,
    error: StorageIntegrityError,
  ): Promise<void> {
    const column = error.location.includes(':') ? error.location.slice(error.location.lastIndexOf(':') + 1) : 'value';
    const ciphertext = typeof row[column] === 'string' ? row[column] as string : '';
    try {
      const sourceRowId = typeof row.id === 'number' ? row.id : null;
      const existing = await this.inner.query('storage_quarantine', {
        source_table: table,
        source_row_id: sourceRowId,
        column_name: column,
        reason: error.reason,
      });
      if (existing.length === 0) {
        const quarantineId = (await this.inner.reserveRowIds('storage_quarantine', 1))[0];
        await this.inner.insert('storage_quarantine', {
          id: quarantineId,
          source_table: table,
          source_row_id: sourceRowId,
          column_name: column,
          ciphertext: this.encryptValue(
            ciphertext,
            this.rowAad('storage_quarantine', quarantineId, 'ciphertext'),
          ),
          row_data: this.encryptValue(
            JSON.stringify(row),
            this.rowAad('storage_quarantine', quarantineId, 'row_data'),
          ),
          reason: error.reason,
        });
      }
    } catch (quarantineError) {
      const message = quarantineError instanceof Error ? quarantineError.message : 'unknown quarantine failure';
      const failure = { location: `${table}:quarantine`, message };
      this.integrityFailures.push(failure);
      this.options.onIntegrityFailure?.(failure);
    }
  }

  private keyAad(key: string): string {
    return `config:${key}`;
  }

  private rowAad(table: string, rowId: number, column: string): string {
    return `row:${table}:${rowId}:${column}`;
  }

  private async getLegacyRecoveryCandidates(): Promise<Array<Omit<LegacyDbRecoveryCandidate, 'preview'> & { legacyCiphertext: string }>> {
    const allowedLocations = new Set<string>(LEGACY_DB_RECOVERY_LOCATIONS);
    const quarantined = await this.query<{
      id: number;
      source_table: string;
      source_row_id: number | null;
      column_name: string;
      ciphertext: string;
      reason: string;
    }>('storage_quarantine', { reason: 'unbound_legacy_ciphertext' });
    const candidates: Array<Omit<LegacyDbRecoveryCandidate, 'preview'> & { legacyCiphertext: string }> = [];
    for (const row of quarantined) {
      if (!Number.isInteger(row.source_row_id) || row.source_row_id === null || row.source_row_id <= 0) continue;
      if (!allowedLocations.has(`${row.source_table}.${row.column_name}`)) continue;
      const [source] = await this.inner.query<Record<string, unknown>>(row.source_table, { id: row.source_row_id });
      if (!source || source[row.column_name] !== row.ciphertext) continue;
      candidates.push({
        quarantineId: row.id,
        table: row.source_table,
        rowId: row.source_row_id,
        column: row.column_name,
        legacyCiphertext: row.ciphertext,
      });
    }
    return candidates;
  }

  private decryptLegacyForRecovery(
    ciphertext: string,
    candidate: Omit<LegacyDbRecoveryCandidate, 'preview'>,
  ): unknown {
    const location = `legacy-review:${candidate.table}:${candidate.rowId}:${candidate.column}`;
    if (ciphertext.startsWith(ENCRYPTED_VALUE_PREFIX_V1)) {
      return this.decryptAuthenticated(ciphertext.slice(ENCRYPTED_VALUE_PREFIX_V1.length), location);
    }
    if (this.looksLikeLegacyCiphertext(ciphertext)) {
      return this.decryptAuthenticated(ciphertext, location);
    }
    throw new Error(`Legacy recovery candidate ${candidate.quarantineId} is not V1 ciphertext`);
  }
}
