import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KeyAccessError, KeyManager } from '../../../src/core/crypto/key-manager.js';
import {
  FINAL_KEY_LOSS_ARCHIVE_DIRECTORIES,
  FINAL_KEY_LOSS_ARCHIVE_FILES,
  FINAL_KEY_LOSS_RESET_CONFIRMATION,
  KeyLossResetError,
  resetAfterFinalKeyLoss,
} from '../../../src/core/crypto/key-loss-reset.js';

const OLD_WRAPPING_KEY = Buffer.alloc(32, 71);
const NEW_WRAPPING_KEY = Buffer.alloc(32, 72);

describe('final key loss reset', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-final-key-loss-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('archives the exact encrypted state and only then publishes a fresh durable key', () => {
    const oldKey = new KeyManager(tmpDir, { testWrappingKey: OLD_WRAPPING_KEY }).getOrCreateKey();
    const expected = new Map<string, Buffer>();
    for (const [index, fileName] of FINAL_KEY_LOSS_ARCHIVE_FILES.entries()) {
      const filePath = path.join(tmpDir, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, `encrypted-${index}`, 'utf-8');
      expected.set(fileName, fs.readFileSync(filePath));
    }
    const credentialDir = path.join(tmpDir, FINAL_KEY_LOSS_ARCHIVE_DIRECTORIES[0]);
    fs.mkdirSync(credentialDir);
    fs.writeFileSync(path.join(credentialDir, 'connection.enc'), 'encrypted-ai-key', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'unrelated-electron-state.json'), 'keep-me', 'utf-8');
    const failure = readFinalLoss(tmpDir, NEW_WRAPPING_KEY);
    const events: string[] = [];

    const result = resetAfterFinalKeyLoss(
      tmpDir,
      failure,
      FINAL_KEY_LOSS_RESET_CONFIRMATION,
      {
        keyManagerOptions: { testWrappingKey: NEW_WRAPPING_KEY },
        faultInjector: (_point, fileName) => events.push(fileName),
      },
    );

    expect(result.archivedFiles).toEqual([
      ...FINAL_KEY_LOSS_ARCHIVE_FILES,
      ...FINAL_KEY_LOSS_ARCHIVE_DIRECTORIES,
    ]);
    expect(events.slice(0, 2)).toEqual(['sarah.key', 'sarah.key.bak']);
    expect(path.dirname(result.archivePath)).toBe(path.join(tmpDir, 'key-loss-recovery'));
    for (const [fileName, bytes] of expected) {
      expect(fs.readFileSync(path.join(result.archivePath, fileName))).toEqual(bytes);
    }
    expect(fs.readFileSync(path.join(tmpDir, 'unrelated-electron-state.json'), 'utf-8')).toBe('keep-me');
    for (const fileName of FINAL_KEY_LOSS_ARCHIVE_FILES) {
      if (fileName === 'sarah.key' || fileName === 'sarah.key.bak') continue;
      expect(fs.existsSync(path.join(tmpDir, fileName))).toBe(false);
    }
    expect(fs.readFileSync(
      path.join(result.archivePath, FINAL_KEY_LOSS_ARCHIVE_DIRECTORIES[0], 'connection.enc'),
      'utf-8',
    )).toBe('encrypted-ai-key');
    expect(fs.existsSync(credentialDir)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'sarah.key'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sarah.key.bak'))).toBe(true);
    const freshKey = new KeyManager(tmpDir, { testWrappingKey: NEW_WRAPPING_KEY }).getOrCreateKey();
    expect(freshKey.equals(oldKey)).toBe(false);

    const manifest = JSON.parse(fs.readFileSync(path.join(result.archivePath, 'manifest.json'), 'utf-8')) as {
      version: number;
      reason: string;
      files: string[];
    };
    expect(manifest).toMatchObject({
      version: 1,
      reason: 'key-envelopes-unreadable',
      files: [...FINAL_KEY_LOSS_ARCHIVE_FILES, ...FINAL_KEY_LOSS_ARCHIVE_DIRECTORIES],
    });
  });

  it('rolls every completed move back before any fresh key can be generated', () => {
    new KeyManager(tmpDir, { testWrappingKey: OLD_WRAPPING_KEY }).getOrCreateKey();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), 'encrypted-config', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'sarah.db'), 'encrypted-db', 'utf-8');
    const expected = new Map(
      ['sarah.key', 'sarah.key.bak', 'config.json', 'sarah.db'].map((fileName) => [
        fileName,
        fs.readFileSync(path.join(tmpDir, fileName)),
      ]),
    );
    const failure = readFinalLoss(tmpDir, NEW_WRAPPING_KEY);

    expect(() => resetAfterFinalKeyLoss(
      tmpDir,
      failure,
      FINAL_KEY_LOSS_RESET_CONFIRMATION,
      {
        keyManagerOptions: { testWrappingKey: NEW_WRAPPING_KEY },
        faultInjector: (_point, fileName) => {
          if (fileName === 'config.json') throw new Error('injected archive failure');
        },
      },
    )).toThrow('injected archive failure');

    for (const [fileName, bytes] of expected) {
      expect(fs.readFileSync(path.join(tmpDir, fileName))).toEqual(bytes);
    }
    expect(fs.existsSync(path.join(tmpDir, 'key-loss-recovery'))).toBe(false);
  });

  it('aborts if a readable backup repairs the key before the reset boundary', () => {
    new KeyManager(tmpDir, { testWrappingKey: OLD_WRAPPING_KEY }).getOrCreateKey();
    fs.writeFileSync(path.join(tmpDir, 'config.json'), 'encrypted-config', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'sarah.key'), 'broken-primary', 'utf-8');
    const backupBefore = fs.readFileSync(path.join(tmpDir, 'sarah.key.bak'));
    const staleFailure = new KeyAccessError(
      'key-envelopes-unreadable',
      'stale final-loss observation',
    );

    expect(() => resetAfterFinalKeyLoss(
      tmpDir,
      staleFailure,
      FINAL_KEY_LOSS_RESET_CONFIRMATION,
      { keyManagerOptions: { testWrappingKey: OLD_WRAPPING_KEY } },
    )).toThrow('became readable');

    expect(fs.readFileSync(path.join(tmpDir, 'sarah.key'))).toEqual(backupBefore);
    expect(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')).toBe('encrypted-config');
    expect(fs.existsSync(path.join(tmpDir, 'key-loss-recovery'))).toBe(false);
  });

  it('never resets a transient key-protection failure', () => {
    const transient = new KeyAccessError(
      'safe-storage-unavailable',
      'safeStorage is temporarily unavailable',
    );
    fs.writeFileSync(path.join(tmpDir, 'sarah.db'), 'encrypted-db', 'utf-8');

    expect(() => resetAfterFinalKeyLoss(
      tmpDir,
      transient,
      FINAL_KEY_LOSS_RESET_CONFIRMATION,
      { keyManagerOptions: { testWrappingKey: NEW_WRAPPING_KEY } },
    )).toThrow('confirmed final key loss');
    expect(fs.readFileSync(path.join(tmpDir, 'sarah.db'), 'utf-8')).toBe('encrypted-db');
  });

  it('requires the exact internal confirmation capability without touching files', () => {
    new KeyManager(tmpDir, { testWrappingKey: OLD_WRAPPING_KEY }).getOrCreateKey();
    fs.writeFileSync(path.join(tmpDir, 'sarah.db'), 'encrypted-db', 'utf-8');
    const failure = readFinalLoss(tmpDir, NEW_WRAPPING_KEY);
    const keyBefore = fs.readFileSync(path.join(tmpDir, 'sarah.key'));

    expect(() => Reflect.apply(resetAfterFinalKeyLoss, undefined, [
      tmpDir,
      failure,
      Symbol('wrong-confirmation'),
      { keyManagerOptions: { testWrappingKey: NEW_WRAPPING_KEY } },
    ])).toThrow('explicit internal confirmation');

    expect(fs.readFileSync(path.join(tmpDir, 'sarah.key'))).toEqual(keyBefore);
    expect(fs.readFileSync(path.join(tmpDir, 'sarah.db'), 'utf-8')).toBe('encrypted-db');
  });

  it('keeps the complete archive when fresh key protection remains unavailable', () => {
    new KeyManager(tmpDir, { testWrappingKey: OLD_WRAPPING_KEY }).getOrCreateKey();
    fs.writeFileSync(path.join(tmpDir, 'sarah.db'), 'encrypted-db', 'utf-8');
    const failure = readFinalLoss(tmpDir, NEW_WRAPPING_KEY);

    let resetError: KeyLossResetError | null = null;
    try {
      resetAfterFinalKeyLoss(
        tmpDir,
        failure,
        FINAL_KEY_LOSS_RESET_CONFIRMATION,
        {
          keyManagerOptions: { testWrappingKey: NEW_WRAPPING_KEY },
          beforeFreshKey: () => {
            throw new KeyAccessError(
              'safe-storage-unavailable',
              'injected fresh-key protection failure',
            );
          },
        },
      );
    } catch (error) {
      if (error instanceof KeyLossResetError) resetError = error;
    }

    expect(resetError?.message).toContain('fresh key could not be created');
    expect(resetError?.archivePath).toBeTruthy();
    const archivePath = resetError?.archivePath ?? '';
    expect(fs.readFileSync(path.join(archivePath, 'sarah.db'), 'utf-8')).toBe('encrypted-db');
    expect(fs.existsSync(path.join(tmpDir, 'sarah.db'))).toBe(false);
  });
});

function readFinalLoss(storageDir: string, wrappingKey: Buffer): KeyAccessError {
  try {
    new KeyManager(storageDir, { testWrappingKey: wrappingKey }).getOrCreateKey();
  } catch (error) {
    if (error instanceof KeyAccessError && error.isFinalKeyLoss) return error;
    throw error;
  }
  throw new Error('Expected final key loss');
}
