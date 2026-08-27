import { describe, expect, it, vi } from 'vitest';
import { createRevisionedSnapshotSync } from '../../../src/renderer/dashboard/views/voice-audio-sync.js';

describe('VoiceOut TTS capability synchronization', () => {
  it('applies the initial capability snapshot when no newer event arrived', () => {
    const apply = vi.fn();
    const sync = createRevisionedSnapshotSync(apply);
    const revision = sync.captureSnapshotRevision();

    sync.applySnapshot(false, revision);

    expect(apply).toHaveBeenCalledWith(false);
  });

  it('does not let a stale initial snapshot overwrite a newer capability event', () => {
    const apply = vi.fn();
    const sync = createRevisionedSnapshotSync(apply);
    const revision = sync.captureSnapshotRevision();

    sync.applyEvent(true);
    sync.applySnapshot(false, revision);

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(true);
  });

  it('does not let a stale initial voice-state snapshot overwrite a newer state event', () => {
    const apply = vi.fn();
    const sync = createRevisionedSnapshotSync(apply);
    const revision = sync.captureSnapshotRevision();

    sync.applyEvent({ state: 'speaking' });
    sync.applySnapshot({ state: 'idle' }, revision);

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith({ state: 'speaking' });
  });
});
