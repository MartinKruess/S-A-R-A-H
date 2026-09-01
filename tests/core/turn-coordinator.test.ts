import { describe, expect, it, vi } from 'vitest';
import { TurnCoordinator, TurnQueueFullError } from '../../src/core/turn-coordinator.js';
import type { TurnEnvelope } from '../../src/core/turn-contract.js';

function turn(turnId: string): TurnEnvelope {
  return {
    turnId,
    source: 'chat',
    mode: 'chat',
    originalText: turnId,
    normalizedText: turnId,
    effectiveText: turnId,
    command: { kind: 'none' },
    createdAt: '2026-08-26T00:00:00.000Z',
  };
}

describe('TurnCoordinator', () => {
  it('executes concurrent submissions strictly in FIFO order', async () => {
    const coordinator = new TurnCoordinator();
    const events: string[] = [];
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = coordinator.enqueue(turn('one'), async () => {
      events.push('one:start');
      await firstGate;
      events.push('one:end');
    });
    const second = coordinator.enqueue(turn('two'), async () => {
      events.push('two:start');
      events.push('two:end');
    });

    await vi.waitFor(() => expect(events).toEqual(['one:start']));
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['one:start', 'one:end', 'two:start', 'two:end']);
  });

  it('aborts the active turn and continues with the next queued turn', async () => {
    const coordinator = new TurnCoordinator();
    const second = vi.fn();
    const first = coordinator.enqueue(turn('one'), (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const next = coordinator.enqueue(turn('two'), async () => { second(); });

    await vi.waitFor(() => expect(coordinator.activeTurnId).toBe('one'));
    expect(coordinator.cancel('one', 'test cancellation')).toBe(true);
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await next;
    expect(second).toHaveBeenCalledOnce();
  });

  it('rejects overload instead of growing the queue without a bound', async () => {
    const coordinator = new TurnCoordinator(1);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = coordinator.enqueue(turn('active'), async () => gate);
    const queued = coordinator.enqueue(turn('queued'), async () => {});
    await expect(coordinator.enqueue(turn('overflow'), async () => {}))
      .rejects.toBeInstanceOf(TurnQueueFullError);
    release();
    await Promise.all([active, queued]);
  });
});
