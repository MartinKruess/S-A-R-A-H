import { abortError } from './abort-utils.js';
import type { TurnId } from './turn-contract.js';

export const DEFAULT_MAX_QUEUED_TURNS = 8;

interface QueuedTurn {
  envelope: { turnId: TurnId };
  execute: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  settlement: Promise<void>;
  settle: () => void;
}

interface ActiveTurn {
  turnId: TurnId;
  controller: AbortController;
}

export class TurnQueueFullError extends Error {
  constructor() {
    super('Turn queue is full');
    this.name = 'TurnQueueFullError';
  }
}

/**
 * Serialisiert fachliche Turns und besitzt deren Abbruchkontext.
 *
 * - Führt höchstens einen Turn gleichzeitig aus.
 * - Hält normale Eingaben in einer begrenzten FIFO-Queue.
 * - Bricht aktive oder noch wartende Turns gezielt ab.
 *
 * @category Service
 */
export class TurnCoordinator {
  private readonly queue: QueuedTurn[] = [];
  private readonly settlements = new Map<TurnId, Promise<void>>();
  private active: ActiveTurn | null = null;
  private draining = false;
  private destroyed = false;

  constructor(private readonly maxQueuedTurns = DEFAULT_MAX_QUEUED_TURNS) {}

  get activeTurnId(): TurnId | null {
    return this.active?.turnId ?? null;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  hasTurn(turnId: TurnId): boolean {
    return this.active?.turnId === turnId
      || this.queue.some((entry) => entry.envelope.turnId === turnId);
  }

  /** Resolves after the active or queued turn has reached its coordinator terminal state. */
  waitForTurn(turnId: TurnId): Promise<void> {
    return this.settlements.get(turnId) ?? Promise.resolve();
  }

  enqueue(
    envelope: { turnId: TurnId },
    execute: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.destroyed) return Promise.reject(abortError('Turn coordinator stopped'));
    if (this.queue.length >= this.maxQueuedTurns) return Promise.reject(new TurnQueueFullError());

    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => { settle = resolve; });
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({ envelope, execute, resolve, reject, settlement, settle });
    });
    this.settlements.set(envelope.turnId, settlement);
    void this.drain();
    return promise;
  }

  cancel(turnId: TurnId, reason = 'Turn canceled'): boolean {
    if (this.active?.turnId === turnId) {
      this.active.controller.abort(abortError(reason));
      return true;
    }

    const index = this.queue.findIndex((entry) => entry.envelope.turnId === turnId);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    entry.reject(abortError(reason));
    this.finishSettlement(entry);
    return true;
  }

  interrupt(reason = 'Turn interrupted'): TurnId | null {
    const turnId = this.active?.turnId ?? null;
    if (turnId) this.cancel(turnId, reason);
    return turnId;
  }

  isCurrent(turnId: TurnId): boolean {
    return this.active?.turnId === turnId && !this.active.controller.signal.aborted;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.active) this.active.controller.abort(abortError('Turn coordinator stopped'));
    for (const entry of this.queue.splice(0)) {
      entry.reject(abortError('Turn coordinator stopped'));
      this.finishSettlement(entry);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || this.destroyed) return;
    this.draining = true;
    try {
      while (!this.destroyed) {
        const entry = this.queue.shift();
        if (!entry) break;
        const controller = new AbortController();
        this.active = { turnId: entry.envelope.turnId, controller };
        try {
          await entry.execute(controller.signal);
          entry.resolve();
        } catch (value) {
          entry.reject(value instanceof Error ? value : new Error(String(value)));
        } finally {
          if (this.active?.turnId === entry.envelope.turnId) this.active = null;
          this.finishSettlement(entry);
        }
      }
    } finally {
      this.draining = false;
      if (!this.destroyed && this.queue.length > 0) void this.drain();
    }
  }

  private finishSettlement(entry: QueuedTurn): void {
    entry.settle();
    if (this.settlements.get(entry.envelope.turnId) === entry.settlement) {
      this.settlements.delete(entry.envelope.turnId);
    }
  }
}
