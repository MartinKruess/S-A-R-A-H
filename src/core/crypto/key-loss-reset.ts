import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  KeyAccessError,
  KeyManager,
  type KeyManagerOptions,
} from './key-manager.js';

export const FINAL_KEY_LOSS_RESET_CONFIRMATION: unique symbol = Symbol(
  'archive-unreadable-state-and-create-fresh-key',
);

export const FINAL_KEY_LOSS_ARCHIVE_FILES = [
  // Move envelopes first. If only the primary move completes, the backup can
  // still heal it. Once both are moved, every remaining store keeps bootstrap
  // fail-closed instead of allowing a silent empty start after power loss.
  'sarah.key',
  'sarah.key.bak',
  'config.json',
  'config.json.bak',
  'sarah.db',
  'sarah.db-wal',
  'sarah.db-shm',
  'sarah.db-journal',
  'connections.enc',
  'connections.enc.bak',
] as const;

export const FINAL_KEY_LOSS_ARCHIVE_DIRECTORIES = [
  'ai-credentials',
] as const;

export type KeyLossResetFaultPoint = 'after-archive-move';

export interface KeyLossResetOptions {
  keyManagerOptions?: KeyManagerOptions;
  /** Test-only failure injection for rollback verification. */
  faultInjector?: (point: KeyLossResetFaultPoint, fileName: string) => void;
  /** Test-only failure injection after archive completion and before key creation. */
  beforeFreshKey?: () => void;
}

export interface KeyLossResetResult {
  archivePath: string;
  archivedFiles: readonly string[];
}

export class KeyLossResetError extends Error {
  constructor(
    message: string,
    readonly archivePath?: string,
  ) {
    super(message);
    this.name = 'KeyLossResetError';
  }
}

/**
 * Archives state that can no longer be decrypted and creates a fresh key pair.
 *
 * - Requires both a typed final-key-loss error and an internal confirmation token.
 * - Moves only the fixed S.A.R.A.H. encryption-state allowlist on the same volume.
 * - Rolls completed moves back if archiving fails before the fresh key is created.
 *
 * @returns Recovery archive path and the exact archived file names.
 *
 * @category Security Service
 */
export function resetAfterFinalKeyLoss(
  storageDir: string,
  failure: KeyAccessError,
  confirmation: typeof FINAL_KEY_LOSS_RESET_CONFIRMATION,
  options: KeyLossResetOptions = {},
): KeyLossResetResult {
  if (!failure.isFinalKeyLoss) {
    throw new KeyLossResetError('A destructive reset requires a confirmed final key loss');
  }
  if (confirmation !== FINAL_KEY_LOSS_RESET_CONFIRMATION) {
    throw new KeyLossResetError('A destructive reset requires explicit internal confirmation');
  }

  const resolvedStorageDir = path.resolve(storageDir);
  const storageStat = fs.lstatSync(resolvedStorageDir);
  if (!storageStat.isDirectory() || storageStat.isSymbolicLink()) {
    throw new KeyLossResetError('The S.A.R.A.H. storage path must be a local directory');
  }

  // The native confirmation dialog is asynchronous. Re-read both envelopes at
  // the mutation boundary so a meanwhile restored key always cancels reset.
  try {
    new KeyManager(resolvedStorageDir, options.keyManagerOptions).getOrCreateKey();
    throw new KeyLossResetError(
      'The S.A.R.A.H. key became readable before reset; no files were archived',
    );
  } catch (currentError) {
    if (currentError instanceof KeyLossResetError) throw currentError;
    if (!(currentError instanceof KeyAccessError) || !currentError.isFinalKeyLoss) {
      throw new KeyLossResetError(
        'Final key loss could not be reconfirmed; no files were archived',
      );
    }
  }

  const presentFiles = FINAL_KEY_LOSS_ARCHIVE_FILES.filter((fileName) => (
    isArchivableEntry(resolvedStorageDir, fileName, 'file')
  ));
  const presentDirectories = FINAL_KEY_LOSS_ARCHIVE_DIRECTORIES.filter((directoryName) => (
    isArchivableEntry(resolvedStorageDir, directoryName, 'directory')
  ));
  const presentEntries = [...presentFiles, ...presentDirectories];
  if (presentEntries.length === 0) {
    throw new KeyLossResetError('No unreadable S.A.R.A.H. encryption state was found to archive');
  }

  const archiveRoot = path.join(resolvedStorageDir, 'key-loss-recovery');
  ensureArchiveRoot(archiveRoot);
  const archivePath = path.join(
    archiveRoot,
    `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
  );
  fs.mkdirSync(archivePath, { recursive: false, mode: 0o700 });

  const movedFiles: string[] = [];
  try {
    for (const fileName of presentEntries) {
      fs.renameSync(
        path.join(resolvedStorageDir, fileName),
        path.join(archivePath, fileName),
      );
      movedFiles.push(fileName);
      options.faultInjector?.('after-archive-move', fileName);
    }
    writeManifest(archivePath, movedFiles, failure.reason);
  } catch (archiveError) {
    const rollbackErrors: string[] = [];
    for (const fileName of [...movedFiles].reverse()) {
      try {
        fs.renameSync(
          path.join(archivePath, fileName),
          path.join(resolvedStorageDir, fileName),
        );
      } catch (rollbackError) {
        rollbackErrors.push(
          `${fileName}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    removeEmptyArchive(archivePath, archiveRoot);
    const archiveMessage = archiveError instanceof Error ? archiveError.message : String(archiveError);
    const rollbackDetail = rollbackErrors.length > 0
      ? ` Rollback incomplete (${rollbackErrors.join('; ')}). Archive: ${archivePath}`
      : '';
    throw new KeyLossResetError(`Unreadable state could not be archived: ${archiveMessage}.${rollbackDetail}`, archivePath);
  }

  try {
    options.beforeFreshKey?.();
    const freshKey = new KeyManager(resolvedStorageDir, options.keyManagerOptions).getOrCreateKey();
    const primaryExists = fs.existsSync(path.join(resolvedStorageDir, 'sarah.key'));
    const backupExists = fs.existsSync(path.join(resolvedStorageDir, 'sarah.key.bak'));
    if (!primaryExists || !backupExists || freshKey.length !== 32) {
      throw new Error('The fresh key pair was not durably published');
    }
  } catch (keyError) {
    const message = keyError instanceof Error ? keyError.message : String(keyError);
    throw new KeyLossResetError(
      `Unreadable state was archived, but a fresh key could not be created: ${message}`,
      archivePath,
    );
  }

  return { archivePath, archivedFiles: [...movedFiles] };
}

function isArchivableEntry(
  storageDir: string,
  fileName: string,
  expected: 'file' | 'directory',
): boolean {
  const sourcePath = path.join(storageDir, fileName);
  try {
    const stat = fs.lstatSync(sourcePath);
    const matchesExpected = expected === 'file' ? stat.isFile() : stat.isDirectory();
    if (!matchesExpected || stat.isSymbolicLink()) {
      throw new KeyLossResetError(
        `Refusing to archive invalid encryption state ${expected}: ${fileName}`,
      );
    }
    return true;
  } catch (error) {
    if (error instanceof KeyLossResetError) throw error;
    if (errorCode(error) === 'ENOENT') return false;
    const message = error instanceof Error ? error.message : String(error);
    throw new KeyLossResetError(
      `Unreadable encryption state could not be inspected safely (${fileName}): ${message}`,
    );
  }
}

function ensureArchiveRoot(archiveRoot: string): void {
  try {
    fs.mkdirSync(archiveRoot, { recursive: false, mode: 0o700 });
    return;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(archiveRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new KeyLossResetError('The key-loss recovery path must be a local directory');
  }
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: string }).code;
  return typeof code === 'string' ? code : null;
}

function writeManifest(
  archivePath: string,
  archivedFiles: readonly string[],
  reason: KeyAccessError['reason'],
): void {
  const manifestPath = path.join(archivePath, 'manifest.json');
  const handle = fs.openSync(manifestPath, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify({
      version: 1,
      archivedAt: new Date().toISOString(),
      reason,
      files: archivedFiles,
    }, null, 2)}\n`, 'utf-8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function removeEmptyArchive(archivePath: string, archiveRoot: string): void {
  try {
    fs.rmSync(path.join(archivePath, 'manifest.json'), { force: true });
    fs.rmdirSync(archivePath);
    if (fs.readdirSync(archiveRoot).length === 0) fs.rmdirSync(archiveRoot);
  } catch {
    // A leftover empty recovery directory contains no user data and is never loaded.
  }
}
