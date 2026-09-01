import type { AppContext } from '../../core/bootstrap.js';
import { MEMORY_RECOVERY_GUARD_KEY } from '../../core/bootstrap.js';
import {
  abortError,
  linkAbortSignals,
  runWithTimeout,
  throwIfAborted,
} from '../../core/abort-utils.js';
import {
  MemoryPolicyApplyError,
  mustKeepTurnTransient,
  type TurnPersistencePolicy,
} from '../../core/memory-policy.js';
import { FALLBACK_CONVERSATION_ID } from '../../core/storage/conversation-store.js';
import type { CuratedMemoryView, Layer2MemoryStore } from '../../core/storage/layer2-memory-store.js';
import type { TurnId } from '../../core/turn-contract.js';
import type { TurnCoordinator } from '../../core/turn-coordinator.js';
import type { MemoryCurator } from './memory-curator.js';
import type { RouterHistoryEntry } from './router-context-builder.js';
import type { RouterTurnDraft } from './router-turn-persistence.js';

interface RouterPersistenceRuntimeOptions {
  context: AppContext;
  memoryStore: Layer2MemoryStore;
  memoryCurator: MemoryCurator;
  coordinator: TurnCoordinator;
  turnDrafts: Map<TurnId, RouterTurnDraft>;
  getHistory: () => RouterHistoryEntry[];
  setHistory: (history: RouterHistoryEntry[]) => void;
  memoryPolicyWaitTimeoutMs: number;
  shutdownDrainTimeoutMs: number;
}

/**
 * Coordinates Router persistence, memory policy barriers, and shutdown-safe mutations.
 *
 * @category Service Data Access
 */
export class RouterPersistenceRuntime {
  private policyReady = true;
  private policyBarrier: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly shutdownAbort = new AbortController();
  private persistenceWarned = false;
  private memories: CuratedMemoryView[] = [];

  constructor(private readonly options: RouterPersistenceRuntimeOptions) {}

  get memoryPolicyReady(): boolean {
    return this.policyReady;
  }

  get curatedMemories(): readonly CuratedMemoryView[] {
    return this.memories;
  }

  get pendingMutation(): Promise<void> {
    return this.mutationQueue;
  }

  async initializePolicy(): Promise<void> {
    const trust = this.options.context.parsedConfig.trust;
    try {
      if (trust.memoryAllowed || !this.options.context.memoryRecoveryGuardActive) {
        await this.options.memoryStore.applyPolicy({
          allowed: trust.memoryAllowed,
          exclusions: trust.memoryExclusions,
        });
        if (trust.memoryAllowed) await this.clearMemoryRecoveryGuard();
      }
    } catch {
      this.policyReady = false;
      this.markStorageDegraded();
      console.warn('[Router] Memory policy cleanup unavailable; persistence disabled for this run');
    }
  }

  async recoverMemoryJobs(): Promise<void> {
    const trust = this.options.context.parsedConfig.trust;
    if (!this.policyReady || !trust.memoryAllowed) return;
    try {
      await this.options.memoryStore.recoverInterruptedJobs(Date.now(), true);
      await this.options.memoryStore.recoverFailedJobs();
      await this.refreshMemoryCache();
      if (await this.options.memoryStore.hasPending()) this.options.memoryCurator.schedule();
    } catch {
      this.policyReady = false;
      this.memories = [];
      this.markStorageDegraded();
    }
  }

  async applyMemoryPolicy(policy: TurnPersistencePolicy): Promise<void> {
    this.policyReady = false;
    let releasePolicyBarrier!: () => void;
    const policyBarrier = new Promise<void>((resolve) => { releasePolicyBarrier = resolve; });
    this.policyBarrier = policyBarrier;
    try {
      const activeTurnId = this.options.coordinator.activeTurnId;
      const recalledContents = activeTurnId
        ? this.options.turnDrafts.get(activeTurnId)?.recalledContents ?? []
        : [];
      if (activeTurnId && recalledContents.length > 0
        && mustKeepTurnTransient(recalledContents, policy)) {
        this.options.coordinator.cancel(activeTurnId, 'Memory policy became more restrictive');
        await this.options.coordinator.waitForTurn(activeTurnId);
      }
      await this.runMemoryMutation(async () => {
        await this.options.memoryCurator.cancelAndWait();
        if (policy.allowed || !this.options.context.memoryRecoveryGuardActive) {
          await this.options.memoryStore.applyPolicy(policy);
        }
        const byTurn = new Map<TurnId, RouterHistoryEntry[]>();
        for (const entry of this.options.getHistory()) {
          const entries = byTurn.get(entry.turnId) ?? [];
          entries.push(entry);
          byTurn.set(entry.turnId, entries);
        }
        const excluded = new Set<TurnId>();
        for (const [turnId, entries] of byTurn) {
          if (mustKeepTurnTransient(
            entries.map((entry) => entry.content),
            { allowed: true, exclusions: policy.exclusions },
          )) excluded.add(turnId);
        }
        this.options.setHistory(this.options.getHistory().filter((entry) => !excluded.has(entry.turnId)));
        if (policy.allowed) await this.refreshMemoryCache();
        else this.memories = [];
        this.policyReady = true;
        if (policy.allowed) await this.clearMemoryRecoveryGuard();
      });
    } catch (error) {
      this.policyReady = false;
      this.memories = [];
      this.warnPersistenceOnce();
      throw new MemoryPolicyApplyError(
        `Memory policy cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      releasePolicyBarrier();
      if (this.policyBarrier === policyBarrier) this.policyBarrier = null;
    }
  }

  async waitForMemoryPolicy(signal: AbortSignal): Promise<void> {
    const barrier = this.policyBarrier;
    if (!barrier) return;
    await runWithTimeout(
      () => barrier,
      this.options.memoryPolicyWaitTimeoutMs,
      'Memory policy wait timed out',
      signal,
    );
    throwIfAborted(signal);
    if (!this.policyReady) throw new MemoryPolicyApplyError('Memory policy is unavailable');
  }

  async persistTurn(
    conversationId: number,
    turnId: TurnId,
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
    policy: TurnPersistencePolicy,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (conversationId === FALLBACK_CONVERSATION_ID) {
      this.warnPersistenceOnce();
      return;
    }
    try {
      const stagingId = await this.runMemoryMutation(() => this.options.memoryStore.persistTurn(
        conversationId,
        turnId,
        messages,
        policy,
      ), signal);
      throwIfAborted(signal);
      if (stagingId != null) this.options.memoryCurator.schedule();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      console.warn('[Router] Turn persist failed (non-fatal):', error);
      this.warnPersistenceOnce();
    }
  }

  async runMemoryMutation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const linked = linkAbortSignals(signal, this.shutdownAbort.signal);
    const mutationSignal = linked.signal;
    const execute = async (): Promise<T> => {
      throwIfAborted(mutationSignal);
      const result = await operation();
      throwIfAborted(mutationSignal);
      return result;
    };
    const run = this.mutationQueue.then(execute, execute);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    try {
      throwIfAborted(mutationSignal);
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          mutationSignal.removeEventListener('abort', onAbort);
          callback();
        };
        const onAbort = (): void => finish(() => {
          const reason = mutationSignal.reason;
          reject(reason instanceof Error ? reason : abortError());
        });
        mutationSignal.addEventListener('abort', onAbort, { once: true });
        run.then(
          (value) => finish(() => resolve(value)),
          (error: Error) => finish(() => reject(error)),
        );
      });
    } finally {
      linked.dispose();
    }
  }

  async drainPendingWork(
    activeTurnId: TurnId | null,
    pendingOutput: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const drains: Promise<void>[] = [pendingOutput, this.mutationQueue];
    if (activeTurnId) drains.push(this.options.coordinator.waitForTurn(activeTurnId));
    try {
      await runWithTimeout(
        () => Promise.allSettled(drains).then(() => undefined),
        this.options.shutdownDrainTimeoutMs,
        'Router shutdown drain timed out',
        signal,
      );
    } catch (error) {
      console.warn('[Router] Pending work did not drain before shutdown:', error);
    }
  }

  abortShutdown(): void {
    this.shutdownAbort.abort(abortError('Router shutdown started'));
  }

  async refreshMemoryCache(): Promise<void> {
    this.memories = await this.options.memoryStore.listWithTopics();
  }

  warnPersistenceOnce(): void {
    this.markStorageDegraded();
    if (this.persistenceWarned) return;
    this.persistenceWarned = true;
    this.options.context.bus.emit('router', 'storage:degraded', {
      message: 'Speichern nicht möglich — diese Unterhaltung wird nach einem Neustart vergessen.',
    });
  }

  markStorageDegraded(): void {
    this.options.context.lifecycle?.setCapability(
      'storage',
      'degraded',
      'Speichern nicht möglich — neue Unterhaltungen bleiben nur bis zum Neustart erhalten.',
    );
  }

  private async clearMemoryRecoveryGuard(): Promise<void> {
    if (!this.options.context.memoryRecoveryGuardActive) return;
    this.options.context.memoryRecoveryGuardActive = false;
    try {
      await this.options.context.config.set(MEMORY_RECOVERY_GUARD_KEY, false);
    } catch (error) {
      console.warn('[Router] Memory recovery guard could not be cleared:', error);
    }
  }
}
