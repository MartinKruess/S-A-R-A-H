import { describe, expect, it, vi } from 'vitest';
import type { RuntimeSnapshot } from '../../../src/core/app-lifecycle-controller.js';
import { synchronizeRuntimeStatus } from '../../../src/renderer/dashboard/runtime-status-sync.js';

function snapshot(state: RuntimeSnapshot['state']): RuntimeSnapshot {
  return {
    state,
    generation: 1,
    updatedAt: Date.now(),
    capabilities: { router: { state: state === 'ready' ? 'ready' : 'error' } },
  };
}

describe('synchronizeRuntimeStatus', () => {
  it('does not let a delayed initial snapshot overwrite a newer live event', async () => {
    let resolveInitial!: (value: RuntimeSnapshot) => void;
    let listener!: (value: RuntimeSnapshot) => void;
    const apply = vi.fn();
    synchronizeRuntimeStatus({
      getRuntimeStatus: () => new Promise((resolve) => { resolveInitial = resolve; }),
      onRuntimeStatus: (callback) => {
        listener = callback;
        return vi.fn();
      },
    }, apply, vi.fn());

    const recovered = snapshot('ready');
    listener(recovered);
    resolveInitial(snapshot('degraded'));
    await Promise.resolve();

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(recovered);
  });

  it('applies the initial snapshot when no live event overtook it', async () => {
    const initial = snapshot('ready');
    const apply = vi.fn();
    synchronizeRuntimeStatus({
      getRuntimeStatus: vi.fn(async () => initial),
      onRuntimeStatus: vi.fn(() => vi.fn()),
    }, apply, vi.fn());

    await Promise.resolve();

    expect(apply).toHaveBeenCalledWith(initial);
  });

  it('ignores a delayed initial error after a newer live event', async () => {
    let rejectInitial!: (reason: Error) => void;
    let listener!: (value: RuntimeSnapshot) => void;
    const apply = vi.fn();
    const onInitialError = vi.fn();
    synchronizeRuntimeStatus({
      getRuntimeStatus: () => new Promise((_resolve, reject) => { rejectInitial = reject; }),
      onRuntimeStatus: (callback) => {
        listener = callback;
        return vi.fn();
      },
    }, apply, onInitialError);

    const recovered = snapshot('ready');
    listener(recovered);
    rejectInitial(new Error('initial snapshot failed'));
    await Promise.resolve();

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(recovered);
    expect(onInitialError).not.toHaveBeenCalled();
  });

  it('unsubscribes and ignores a late initial response after teardown', async () => {
    let resolveInitial!: (value: RuntimeSnapshot) => void;
    const unsubscribe = vi.fn();
    const apply = vi.fn();
    const stop = synchronizeRuntimeStatus({
      getRuntimeStatus: () => new Promise((resolve) => { resolveInitial = resolve; }),
      onRuntimeStatus: vi.fn(() => unsubscribe),
    }, apply, vi.fn());

    stop();
    resolveInitial(snapshot('ready'));
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });
});
