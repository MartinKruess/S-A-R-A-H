import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  isFolderScanAllowed,
  isProgramDetectionAllowed,
  resolveFolderScanPath,
  type FolderScanGrant,
} from '../../src/main/ipc-programs.js';

function canonical(folderPath: string): string {
  const resolved = fs.realpathSync.native(folderPath);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

describe('program-folder scan authorization', () => {
  const workspace = process.cwd();
  const sourceFolder = path.join(workspace, 'src');
  const senderId = 7;

  function grant(folderPath: string, overrides: Partial<FolderScanGrant> = {}): Map<string, FolderScanGrant> {
    return new Map([[canonical(folderPath), {
      senderId,
      expiresAt: 2_000,
      ...overrides,
    }]]);
  }

  it('denies every renderer path when file access is disabled', () => {
    expect(isFolderScanAllowed(workspace, 'none', [workspace], grant(workspace), senderId, 1_000))
      .toBe(false);
  });

  it('allows only configured roots and descendants in specific-folders mode', () => {
    expect(isFolderScanAllowed(sourceFolder, 'specific-folders', [workspace], new Map(), senderId, 1_000))
      .toBe(true);
    expect(isFolderScanAllowed(path.dirname(workspace), 'specific-folders', [workspace], new Map(), senderId, 1_000))
      .toBe(false);
  });

  it('accepts an exact native-picker grant but not an arbitrary sibling', () => {
    const selectedGrant = grant(sourceFolder);
    expect(isFolderScanAllowed(sourceFolder, 'specific-folders', [], selectedGrant, senderId, 1_000)).toBe(true);
    expect(isFolderScanAllowed(workspace, 'specific-folders', [], selectedGrant, senderId, 1_000)).toBe(false);
  });

  it('permits arbitrary existing paths only in all mode', () => {
    expect(isFolderScanAllowed(workspace, 'all', [], new Map(), senderId, 1_000)).toBe(true);
  });

  it('returns the canonical path that was authorized for the subsequent filesystem read', () => {
    expect(resolveFolderScanPath(
      sourceFolder,
      'specific-folders',
      [workspace],
      new Map(),
      senderId,
      1_000,
    )).toBe(canonical(sourceFolder));
  });

  it('rejects picker grants from another renderer or after expiry', () => {
    const selectedGrant = grant(sourceFolder);
    expect(isFolderScanAllowed(sourceFolder, 'specific-folders', [], selectedGrant, senderId + 1, 1_000)).toBe(false);
    expect(isFolderScanAllowed(sourceFolder, 'specific-folders', [], selectedGrant, senderId, 2_001)).toBe(false);
  });

  it('allows machine-wide automatic inventory only with all-files access', () => {
    expect(isProgramDetectionAllowed('none')).toBe(false);
    expect(isProgramDetectionAllowed('specific-folders')).toBe(false);
    expect(isProgramDetectionAllowed('all')).toBe(true);
  });
});
