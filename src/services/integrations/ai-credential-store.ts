import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { KeyManager } from '../../core/crypto/key-manager.js';
import { decrypt, encrypt } from '../../core/crypto/crypto.js';
import {
  AiStoredSecretAuthKindSchema as AiAuthKindSchema,
  AiProviderIdSchema,
  type AiProviderId,
} from '../../core/ai-provider-contract.js';

const CREDENTIAL_DIRECTORY = 'ai-credentials';
const STORE_PREFIX = 'sarah-ai-credential:v1:';
const ConnectionIdSchema = z.uuid();

export interface AiCredentialIdentity {
  connectionId: string;
  providerId: AiProviderId;
  authKind: 'api_key';
}

interface AiCredentialData {
  version: 1;
  apiKey: string;
}

interface AiCredentialEnvelope {
  version: 1;
  generation: number;
  commitId: string;
  data: AiCredentialData;
}

interface CredentialSnapshot {
  generation: number;
  commitId: string;
  apiKey: string;
}

export type AiCredentialStoreStatus =
  | { state: 'ready' }
  | { state: 'recovered'; message: string }
  | { state: 'degraded'; message: string };

export type AiCredentialStoreFaultPoint = 'after-backup-publish';

export class AiCredentialStoreDegradedError extends Error {
  constructor() {
    super('Der verschlüsselte KI-Zugang ist beschädigt und bleibt unverändert.');
    this.name = 'AiCredentialStoreDegradedError';
  }
}

/**
 * Stores one API key per isolated, identity-bound encrypted connection file.
 *
 * - Validates every file identity before resolving a path.
 * - Authenticates connection, provider, auth kind, and schema through AES-GCM AAD.
 * - Recovers from the newest matching primary/backup commit and blocks degraded writes.
 *
 * @category Data Access Security External Integration
 */
export class AiCredentialStore {
  private readonly snapshots = new Map<string, CredentialSnapshot | null>();
  private readonly statuses = new Map<string, AiCredentialStoreStatus>();

  constructor(
    private readonly storageDir: string,
    private readonly keyManager: KeyManager,
    private readonly faultInjector?: (point: AiCredentialStoreFaultPoint) => void,
  ) {}

  has(identity: AiCredentialIdentity): boolean {
    return this.load(identity) !== undefined;
  }

  /** Main-process-only credential access for a later provider adapter. */
  read(identity: AiCredentialIdentity): string | undefined {
    return this.load(identity)?.apiKey;
  }

  write(identity: AiCredentialIdentity, apiKey: string): void {
    const normalized = this.validateIdentity(identity);
    if (!apiKey.trim() || apiKey !== apiKey.trim()) {
      throw new Error('AI credential must be non-empty and trimmed');
    }
    const key = this.identityKey(normalized);
    const status = this.status(normalized);
    if (status.state === 'degraded') throw new AiCredentialStoreDegradedError();

    const current = this.snapshots.get(key);
    const nextGeneration = current?.generation ? current.generation + 1 : 1;
    const envelope: AiCredentialEnvelope = {
      version: 1,
      generation: nextGeneration,
      commitId: randomUUID(),
      data: { version: 1, apiKey },
    };
    const paths = this.paths(normalized);
    this.ensureCredentialDirectory();
    const wrapped = `${STORE_PREFIX}${encrypt(
      JSON.stringify(envelope),
      this.keyManager.getOrCreateKey(),
      this.aad(normalized),
    )}`;
    const tempPath = `${paths.primary}.${process.pid}.${randomUUID()}.tmp`;
    const backupTempPath = `${paths.backup}.${process.pid}.${randomUUID()}.tmp`;
    try {
      this.writeDurably(tempPath, wrapped);
      this.writeDurably(backupTempPath, wrapped);
      fs.renameSync(backupTempPath, paths.backup);
      this.faultInjector?.('after-backup-publish');
      fs.renameSync(tempPath, paths.primary);
      this.snapshots.set(key, {
        generation: envelope.generation,
        commitId: envelope.commitId,
        apiKey,
      });
      this.statuses.set(key, { state: 'ready' });
    } catch (error) {
      this.snapshots.delete(key);
      this.statuses.delete(key);
      throw error;
    } finally {
      this.removeTemp(tempPath);
      this.removeTemp(backupTempPath);
    }
  }

  delete(identity: AiCredentialIdentity): void {
    const normalized = this.validateIdentity(identity);
    const key = this.identityKey(normalized);
    const paths = this.paths(normalized);
    this.assertCredentialDirectorySafe(false);
    this.removeCredentialFile(paths.primary);
    this.removeCredentialFile(paths.backup);
    this.snapshots.set(key, null);
    this.statuses.set(key, { state: 'ready' });
  }

  status(identity: AiCredentialIdentity): AiCredentialStoreStatus {
    const normalized = this.validateIdentity(identity);
    const key = this.identityKey(normalized);
    if (!this.statuses.has(key)) this.load(normalized);
    return { ...(this.statuses.get(key) ?? { state: 'ready' as const }) };
  }

  private load(identity: AiCredentialIdentity): CredentialSnapshot | undefined {
    const normalized = this.validateIdentity(identity);
    const key = this.identityKey(normalized);
    if (this.snapshots.has(key)) return this.snapshots.get(key) ?? undefined;

    const paths = this.paths(normalized);
    this.assertCredentialDirectorySafe(false);
    const primaryExists = this.safeFileExists(paths.primary);
    const backupExists = this.safeFileExists(paths.backup);
    if (!primaryExists && !backupExists) {
      this.snapshots.set(key, null);
      this.statuses.set(key, { state: 'ready' });
      return undefined;
    }

    let primary: CredentialSnapshot | undefined;
    let backup: CredentialSnapshot | undefined;
    try {
      if (primaryExists) primary = this.readFile(paths.primary, normalized);
    } catch {
      // The matching backup remains an independent recovery source.
    }
    try {
      if (backupExists) backup = this.readFile(paths.backup, normalized);
    } catch {
      // Evaluated below without exposing cryptographic details.
    }

    const selected = this.selectNewest(primary, backup);
    if (!selected) {
      this.snapshots.set(key, null);
      this.statuses.set(key, {
        state: 'degraded',
        message: 'Der verschlüsselte KI-Zugang ist beschädigt und bleibt unverändert.',
      });
      return undefined;
    }

    this.snapshots.set(key, selected);
    const bothCurrent = primary !== undefined
      && backup !== undefined
      && primary.generation === backup.generation
      && primary.commitId === backup.commitId;
    this.statuses.set(key, bothCurrent
      ? { state: 'ready' }
      : {
          state: 'recovered',
          message: 'Der neueste gültige KI-Zugang wurde aus einer sicheren Kopie geladen.',
        });
    return selected;
  }

  private readFile(filePath: string, identity: AiCredentialIdentity): CredentialSnapshot {
    this.assertRegularFile(filePath);
    const wrapped = fs.readFileSync(filePath, 'utf-8');
    if (!wrapped.startsWith(STORE_PREFIX)) throw new Error('Invalid AI credential prefix');
    const plaintext = decrypt(
      wrapped.slice(STORE_PREFIX.length),
      this.keyManager.getOrCreateKey(),
      this.aad(identity),
    );
    const parsed: object = JSON.parse(plaintext) as object;
    if (parsed === null || Array.isArray(parsed)) throw new Error('Invalid AI credential envelope');
    const envelope = parsed as Partial<AiCredentialEnvelope>;
    if (
      envelope.version !== 1
      || typeof envelope.generation !== 'number'
      || !Number.isSafeInteger(envelope.generation)
      || envelope.generation < 1
      || typeof envelope.commitId !== 'string'
      || !ConnectionIdSchema.safeParse(envelope.commitId).success
      || !this.isCredentialData(envelope.data)
    ) {
      throw new Error('Invalid AI credential envelope');
    }
    return {
      generation: envelope.generation,
      commitId: envelope.commitId,
      apiKey: envelope.data.apiKey,
    };
  }

  private isCredentialData(value: object | undefined): value is AiCredentialData {
    if (value === undefined || value === null || Array.isArray(value)) return false;
    const candidate = value as Partial<AiCredentialData>;
    return candidate.version === 1
      && typeof candidate.apiKey === 'string'
      && candidate.apiKey.trim().length > 0
      && candidate.apiKey === candidate.apiKey.trim();
  }

  private selectNewest(
    primary: CredentialSnapshot | undefined,
    backup: CredentialSnapshot | undefined,
  ): CredentialSnapshot | undefined {
    if (!primary) return backup;
    if (!backup) return primary;
    if (primary.generation !== backup.generation) {
      return primary.generation > backup.generation ? primary : backup;
    }
    return primary.commitId === backup.commitId ? primary : undefined;
  }

  private validateIdentity(identity: AiCredentialIdentity): AiCredentialIdentity {
    return {
      connectionId: ConnectionIdSchema.parse(identity.connectionId),
      providerId: AiProviderIdSchema.parse(identity.providerId),
      authKind: AiAuthKindSchema.parse(identity.authKind),
    };
  }

  private identityKey(identity: AiCredentialIdentity): string {
    return `${identity.connectionId}:${identity.providerId}:${identity.authKind}`;
  }

  private aad(identity: AiCredentialIdentity): string {
    return `sarah:ai-credential:v1:${identity.connectionId}:${identity.providerId}:${identity.authKind}`;
  }

  private paths(identity: AiCredentialIdentity): { primary: string; backup: string } {
    const root = path.resolve(this.storageDir, CREDENTIAL_DIRECTORY);
    const primary = path.resolve(root, `${identity.connectionId}.enc`);
    if (path.dirname(primary) !== root) throw new Error('Invalid AI credential path');
    return { primary, backup: `${primary}.bak` };
  }

  private ensureCredentialDirectory(): void {
    const root = path.resolve(this.storageDir, CREDENTIAL_DIRECTORY);
    try {
      fs.mkdirSync(root, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (this.errorCode(error) !== 'EEXIST') throw error;
    }
    this.assertCredentialDirectorySafe(true);
  }

  private assertCredentialDirectorySafe(required: boolean): void {
    const root = path.resolve(this.storageDir, CREDENTIAL_DIRECTORY);
    try {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('AI credential storage path is not a local directory');
      }
    } catch (error) {
      if (!required && this.errorCode(error) === 'ENOENT') return;
      throw error;
    }
  }

  private safeFileExists(filePath: string): boolean {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid AI credential file');
      return true;
    } catch (error) {
      if (this.errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private assertRegularFile(filePath: string): void {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid AI credential file');
  }

  private removeCredentialFile(filePath: string): void {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid AI credential file');
      fs.rmSync(filePath);
    } catch (error) {
      if (this.errorCode(error) !== 'ENOENT') throw error;
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
      // Temporary files are never considered credential stores on load.
    }
  }

  private errorCode(error: unknown): string | null {
    if (error === null || typeof error !== 'object' || !('code' in error)) return null;
    const code = (error as { code?: string }).code;
    return typeof code === 'string' ? code : null;
  }
}
