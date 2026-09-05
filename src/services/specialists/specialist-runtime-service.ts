import { randomUUID } from 'crypto';
import {
  AcceptedSpecialistTaskMetadataSchema,
  SpecialistAdapterEventSchema,
  SpecialistTaskRequestSchema,
  MAX_SPECIALIST_EVENT_IDS,
  applySpecialistTaskEvent,
  createSpecialistTaskSnapshot,
  isTerminalSpecialistTaskStatus,
  type AcceptedSpecialistTaskMetadata,
  type SpecialistAdapterEvent,
  type SpecialistTaskRequest,
  type SpecialistTaskSnapshot,
} from '../../core/specialist-task.js';
import { isAiOperationCompatible } from '../../core/ai-provider-contract.js';
import type {
  SpecialistBindingResolver,
  SpecialistAdapterContext,
  SpecialistCredentialResolver,
  SpecialistResolvedBinding,
  SpecialistTaskAdapter,
} from './specialist-task-adapter.js';
import {
  DEFAULT_SPECIALIST_TERMINAL_RETENTION,
  SpecialistTaskStore,
} from './specialist-task-store.js';
import { linkAbortSignals, runWithTimeout, waitForSettlement } from '../../core/abort-utils.js';

const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_SHUTDOWN_DRAIN_MS = 1_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
const DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS = 30_000;

export type SpecialistRuntimeErrorCode =
  | 'invalid_request'
  | 'binding_unavailable'
  | 'adapter_unavailable'
  | 'capacity_unavailable'
  | 'preflight_failed'
  | 'task_not_found'
  | 'invalid_state'
  | 'stale_input_request'
  | 'task_record_failed'
  | 'adapter_failed'
  | 'runtime_stopped';

export type SpecialistRuntimeResult =
  | { readonly ok: true; readonly snapshot?: SpecialistTaskSnapshot }
  | { readonly ok: false; readonly code: SpecialistRuntimeErrorCode };

export interface SpecialistRuntimeServiceDependencies {
  readonly store: SpecialistTaskStore;
  readonly adapters: readonly SpecialistTaskAdapter[];
  readonly resolveBinding: SpecialistBindingResolver;
  readonly resolveCredential: SpecialistCredentialResolver;
  readonly now?: () => number;
  readonly maxConcurrentTasks?: number;
  readonly maxConcurrentTasksPerProvider?: number;
  readonly terminalRetentionMs?: number;
  readonly terminalRetentionCount?: number;
  readonly shutdownDrainMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly providerOperationTimeoutMs?: number;
}

type Listener = (snapshot: SpecialistTaskSnapshot) => void;

interface ActiveTask {
  metadata: AcceptedSpecialistTaskMetadata;
  snapshot: SpecialistTaskSnapshot;
  adapter: SpecialistTaskAdapter;
  binding: SpecialistResolvedBinding;
  eventIds: Set<string>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

function timestamp(now: () => number): string {
  return new Date(now()).toISOString();
}

/** Owns provider-neutral accepted specialist tasks and their pinned adapter lifecycle. */
export class SpecialistRuntimeService {
  private readonly tasks = new Map<string, ActiveTask>();
  private readonly listeners = new Set<Listener>();
  private readonly adapters = new Map<string, SpecialistTaskAdapter>();
  private readonly now: () => number;
  private readonly maxConcurrentTasks: number;
  private readonly maxConcurrentTasksPerProvider: number;
  private readonly terminalRetentionMs: number;
  private readonly terminalRetentionCount: number;
  private readonly shutdownDrainMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly providerOperationTimeoutMs: number;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private acceptingAdapterEvents = true;
  private shutdownPromise: Promise<void> | null = null;
  private readonly shutdownAbort = new AbortController();
  private readonly providerOperations = new Set<AbortController>();
  private readonly lateStartObservers = new Set<Promise<void>>();

  constructor(private readonly dependencies: SpecialistRuntimeServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.maxConcurrentTasks = dependencies.maxConcurrentTasks ?? 2;
    this.maxConcurrentTasksPerProvider = dependencies.maxConcurrentTasksPerProvider ?? 1;
    this.terminalRetentionMs = dependencies.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.terminalRetentionCount = dependencies.terminalRetentionCount
      ?? DEFAULT_SPECIALIST_TERMINAL_RETENTION;
    this.shutdownDrainMs = dependencies.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
    this.cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    this.providerOperationTimeoutMs = dependencies.providerOperationTimeoutMs
      ?? DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS;
    for (const adapter of dependencies.adapters) {
      if (this.adapters.has(adapter.operationId)) {
        throw new Error('Duplicate specialist adapter operation');
      }
      this.adapters.set(adapter.operationId, adapter);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(taskId: string): SpecialistTaskSnapshot | null {
    const task = this.tasks.get(taskId);
    return task ? createSpecialistTaskSnapshot(task.snapshot) : null;
  }

  snapshots(): readonly SpecialistTaskSnapshot[] {
    return Object.freeze([...this.tasks.values()].map((task) => (
      createSpecialistTaskSnapshot(task.snapshot)
    )));
  }

  isAcceptingControls(): boolean {
    return !this.stopped;
  }

  async preflight(request: SpecialistTaskRequest, signal?: AbortSignal): Promise<SpecialistRuntimeResult> {
    if (this.stopped) return { ok: false, code: 'runtime_stopped' };
    const prepared = this.prepare(request);
    if (!prepared.ok) return prepared.result;
    if (!this.hasCapacity(prepared.binding.providerId)) {
      return { ok: false, code: 'capacity_unavailable' };
    }
    try {
      const result = await this.runProviderOperation(
        (operationSignal) => prepared.adapter.preflight(prepared.binding, operationSignal),
        Math.min(request.budget.timeoutMs, this.providerOperationTimeoutMs),
        signal,
      );
      return result.ok ? { ok: true } : { ok: false, code: 'preflight_failed' };
    } catch {
      return { ok: false, code: 'preflight_failed' };
    }
  }

  start(request: SpecialistTaskRequest, signal?: AbortSignal): Promise<SpecialistRuntimeResult> {
    const requestedAt = this.now();
    return this.enqueue(async () => {
      if (this.stopped) return { ok: false, code: 'runtime_stopped' };
      const parsed = SpecialistTaskRequestSchema.safeParse(request);
      if (!parsed.success || this.tasks.has(request.taskId)) {
        return { ok: false, code: 'invalid_request' };
      }
      const prepared = this.prepare(parsed.data);
      if (!prepared.ok) return prepared.result;
      if (!this.hasCapacity(prepared.binding.providerId)) {
        return { ok: false, code: 'capacity_unavailable' };
      }
      const deadlineAtMs = requestedAt + parsed.data.budget.timeoutMs;
      try {
        const checked = await this.runProviderOperation(
          (operationSignal) => prepared.adapter.preflight(prepared.binding, operationSignal),
          Math.min(this.remainingMs(deadlineAtMs), this.providerOperationTimeoutMs),
          signal,
        );
        if (!checked.ok) return { ok: false, code: 'preflight_failed' };
      } catch {
        return { ok: false, code: 'preflight_failed' };
      }

      let expectedGeneration: number;
      try {
        const stored = this.dependencies.store.snapshot();
        const pruned = this.dependencies.store.pruneTerminal(
          new Date(this.now() - this.terminalRetentionMs).toISOString(),
          this.terminalRetentionCount,
          stored.generation,
        );
        this.removePrunedTerminalTasks(pruned);
        expectedGeneration = pruned.generation;
        this.dependencies.store.assertCanCreate(parsed.data.taskId, expectedGeneration);
      } catch {
        return { ok: false, code: 'task_record_failed' };
      }

      const buffered: SpecialistAdapterEvent[] = [];
      let published = false;
      let abandoned = false;
      const context = {
        resolveCredential: () => this.dependencies.resolveCredential(
          prepared.binding.connectionId,
          prepared.binding.providerId,
        ),
        emit: (event: SpecialistAdapterEvent): void => {
          if (abandoned) return;
          if (!published) {
            const parsedEvent = SpecialistAdapterEventSchema.safeParse(event);
            if (parsedEvent.success) buffered.push(parsedEvent.data);
            return;
          }
          this.acceptEvent(parsed.data.taskId, event);
        },
      };
      let acceptance: Awaited<ReturnType<SpecialistTaskAdapter['start']>>;
      try {
        acceptance = await this.startProviderOperation(
          prepared.adapter,
          parsed.data,
          context,
          Math.min(this.remainingMs(deadlineAtMs), this.providerOperationTimeoutMs),
          signal,
        );
      } catch {
        abandoned = true;
        return { ok: false, code: 'adapter_failed' };
      }
      const supportedInitialStatuses: ReadonlySet<string> = new Set(['queued', 'running']);
      if (!supportedInitialStatuses.has(String(acceptance.status))) {
        await this.bestEffortCancel(prepared.adapter, acceptance, context);
        return { ok: false, code: 'adapter_failed' };
      }
      const acceptedAt = timestamp(this.now);
      const candidate = AcceptedSpecialistTaskMetadataSchema.safeParse({
        taskId: parsed.data.taskId,
        role: parsed.data.role,
        providerId: prepared.binding.providerId,
        operationId: prepared.binding.operationId,
        connectionId: prepared.binding.connectionId,
        bindingId: prepared.binding.bindingId,
        bindingRevision: prepared.binding.bindingRevision,
        remoteRef: acceptance.remoteRef,
        status: acceptance.status,
        sequence: 0,
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
        deadlineAt: new Date(deadlineAtMs).toISOString(),
        eventIds: [],
        maxTurns: parsed.data.budget.maxTurns,
        turnsUsed: 1,
      });
      if (!candidate.success) {
        await this.bestEffortCancel(prepared.adapter, acceptance, context);
        return { ok: false, code: 'adapter_failed' };
      }
      if (!this.persistAcceptedTask(candidate.data, expectedGeneration)) {
        await this.bestEffortCancel(prepared.adapter, acceptance, context);
        return { ok: false, code: 'task_record_failed' };
      }
      const active: ActiveTask = {
        metadata: candidate.data,
        snapshot: createSpecialistTaskSnapshot({
          taskId: candidate.data.taskId,
          role: candidate.data.role,
          status: candidate.data.status,
          createdAt: candidate.data.createdAt,
          updatedAt: candidate.data.updatedAt,
        }),
        adapter: prepared.adapter,
        binding: prepared.binding,
        eventIds: new Set(),
      };
      this.tasks.set(active.metadata.taskId, active);
      this.scheduleDeadline(active);
      published = true;
      this.publish(active.snapshot);
      for (const event of buffered) this.acceptEvent(active.metadata.taskId, event);
      return { ok: true, snapshot: this.snapshot(active.metadata.taskId) ?? undefined };
    });
  }

  provideInput(
    taskId: string,
    input: string,
    expectedRequestId: string,
    expectedSequence: number,
    signal?: AbortSignal,
  ): Promise<SpecialistRuntimeResult> {
    return this.control(taskId, 'provideInput', input, expectedRequestId, expectedSequence, signal);
  }

  resume(
    taskId: string,
    expectedRequestId: string,
    expectedSequence: number,
    signal?: AbortSignal,
  ): Promise<SpecialistRuntimeResult> {
    return this.control(taskId, 'resume', undefined, expectedRequestId, expectedSequence, signal);
  }

  cancel(taskId: string, signal?: AbortSignal): Promise<SpecialistRuntimeResult> {
    return this.enqueue(async () => {
      if (this.stopped) return { ok: false, code: 'runtime_stopped' };
      const active = this.tasks.get(taskId);
      if (!active) return { ok: false, code: 'task_not_found' };
      if (isTerminalSpecialistTaskStatus(active.snapshot.status)) {
        return { ok: true, snapshot: this.snapshot(taskId) ?? undefined };
      }
      if (active.snapshot.status !== 'cancel_requested') {
        this.acceptEvent(taskId, {
          eventId: this.localEventId('cancel'),
          type: 'cancel_requested',
        });
        if (this.tasks.get(taskId)?.snapshot.status !== 'cancel_requested') {
          return { ok: false, code: 'task_record_failed' };
        }
      }
      try {
        await this.runProviderOperation(
          (operationSignal) => active.adapter.cancel(
            active.metadata,
            this.contextFor(active),
            operationSignal,
          ),
          this.remainingTaskMs(active),
          signal,
        );
        return { ok: true, snapshot: this.snapshot(taskId) ?? undefined };
      } catch {
        return { ok: false, code: 'adapter_failed' };
      }
    });
  }

  reconcile(signal?: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      const stored = this.dependencies.store.snapshot();
      for (const metadata of stored.tasks) {
        const adapter = this.adapters.get(metadata.operationId);
        const binding: SpecialistResolvedBinding = {
          bindingId: metadata.bindingId,
          bindingRevision: metadata.bindingRevision,
          providerId: metadata.providerId,
          operationId: metadata.operationId,
          connectionId: metadata.connectionId,
        };
        const active: ActiveTask = {
          metadata,
          snapshot: createSpecialistTaskSnapshot({
            taskId: metadata.taskId,
            role: metadata.role,
            status: metadata.status === 'waiting_for_user' ? 'running' : metadata.status,
            sequence: metadata.sequence,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
            ...(metadata.terminalCode ? { terminal: { code: metadata.terminalCode } } : {}),
          }),
          adapter: adapter ?? this.unavailableAdapter(metadata.operationId),
          binding,
          eventIds: new Set(metadata.eventIds),
        };
        this.tasks.set(metadata.taskId, active);
        if (isTerminalSpecialistTaskStatus(metadata.status)) continue;
        if (metadata.deadlineAt && Date.parse(metadata.deadlineAt) <= this.now()) {
          this.acceptEvent(metadata.taskId, {
            eventId: this.localEventId('deadline'),
            type: 'incomplete',
            code: 'task_deadline_exceeded',
          });
          await this.bestEffortCancel(active.adapter, active.metadata, this.contextFor(active));
          continue;
        }
        this.scheduleDeadline(active);
        const retrieve = adapter?.retrieve;
        if (!retrieve || !adapter.isReady()) {
          this.acceptEvent(metadata.taskId, {
            eventId: this.localEventId('reconcile'),
            type: 'incomplete',
            code: 'reconciliation_unavailable',
          });
          continue;
        }
        try {
          const event = await this.runProviderOperation(
            (operationSignal) => retrieve(
              metadata,
              this.contextFor(active),
              operationSignal,
            ),
            this.remainingTaskMs(active),
            signal,
          );
          if (event) {
            this.acceptEvent(metadata.taskId, event);
          } else if (metadata.status === 'waiting_for_user'
            && this.tasks.get(metadata.taskId)?.snapshot.status !== 'waiting_for_user') {
            this.acceptEvent(metadata.taskId, {
              eventId: this.localEventId('reconcile'),
              type: 'incomplete',
              code: 'input_request_unavailable',
            });
          }
        } catch {
          this.acceptEvent(metadata.taskId, {
            eventId: this.localEventId('reconcile'),
            type: 'incomplete',
            code: 'reconciliation_failed',
          });
        }
      }
    }).then(() => undefined);
  }

  /** Stops new work, requests remote cancellation, drains terminal events, then records uncertainty. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    this.shutdownAbort.abort(new Error('Specialist runtime shutdown started'));
    for (const operation of this.providerOperations) operation.abort();
    this.shutdownPromise = this.enqueue(async () => {
      const activeTasks = [...this.tasks.values()].filter(
        (task) => !isTerminalSpecialistTaskStatus(task.snapshot.status),
      );
      await Promise.allSettled(activeTasks.map(async (active) => {
        if (active.snapshot.status !== 'cancel_requested') {
          this.acceptEvent(active.metadata.taskId, {
            eventId: this.localEventId('shutdown'),
            type: 'cancel_requested',
          });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.shutdownDrainMs);
        try {
          await Promise.race([
            active.adapter.cancel(active.metadata, this.contextFor(active), controller.signal),
            new Promise<void>((resolve) => setTimeout(resolve, this.shutdownDrainMs)),
          ]);
        } catch {
          // An unconfirmed cancellation is persisted as incomplete below.
        } finally {
          clearTimeout(timeout);
        }
      }));
      if (this.shutdownDrainMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.shutdownDrainMs));
      }
      const lateObservers = [...this.lateStartObservers];
      if (lateObservers.length > 0) {
        await waitForSettlement(Promise.allSettled(lateObservers), this.shutdownDrainMs);
      }
      for (const active of activeTasks) {
        if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
        if (isTerminalSpecialistTaskStatus(active.snapshot.status)) continue;
        this.acceptEvent(active.metadata.taskId, {
          eventId: this.localEventId('shutdown'),
          type: 'incomplete',
          code: 'shutdown_unconfirmed',
        });
      }
      this.acceptingAdapterEvents = false;
      this.listeners.clear();
    }).then(() => undefined);
    return this.shutdownPromise;
  }

  destroy(): Promise<void> {
    return this.shutdown();
  }

  private control(
    taskId: string,
    kind: 'provideInput' | 'resume',
    input: string | undefined,
    expectedRequestId: string,
    expectedSequence: number,
    signal?: AbortSignal,
  ): Promise<SpecialistRuntimeResult> {
    return this.enqueue(async () => {
      if (this.stopped) return { ok: false, code: 'runtime_stopped' };
      const active = this.tasks.get(taskId);
      if (!active) return { ok: false, code: 'task_not_found' };
      if (active.snapshot.status !== 'waiting_for_user') {
        return { ok: false, code: 'invalid_state' };
      }
      if (active.snapshot.sequence !== expectedSequence
        || active.snapshot.inputRequest?.requestId !== expectedRequestId) {
        return { ok: false, code: 'stale_input_request' };
      }
      const normalized = input?.normalize('NFC').trim() ?? '';
      if (kind === 'provideInput' && (!normalized || normalized.length > 4_000)) {
        return { ok: false, code: 'invalid_request' };
      }
      if (active.metadata.turnsUsed >= active.metadata.maxTurns) {
        this.acceptEvent(taskId, {
          eventId: this.localEventId('turn-budget'),
          type: 'incomplete',
          code: 'turn_budget_exhausted',
        });
        const exhausted = this.tasks.get(taskId);
        if (exhausted?.snapshot.status === 'incomplete') {
          await this.bestEffortCancel(
            exhausted.adapter,
            exhausted.metadata,
            this.contextFor(exhausted),
          );
        }
        return { ok: false, code: 'invalid_state' };
      }
      const consumedEventId = this.localEventId(kind);
      const previousTurnsUsed = active.metadata.turnsUsed;
      this.acceptEvent(taskId, { eventId: consumedEventId, type: 'running' }, true);
      const consumed = this.tasks.get(taskId);
      if (!consumed
        || consumed.snapshot.status !== 'running'
        || consumed.snapshot.sequence !== expectedSequence + 1
        || consumed.metadata.turnsUsed !== previousTurnsUsed + 1) {
        return { ok: false, code: 'task_record_failed' };
      }
      try {
        const context = this.contextFor(consumed);
        if (kind === 'provideInput') {
          await this.runProviderOperation(
            (operationSignal) => consumed.adapter.provideInput(
              consumed.metadata,
              normalized,
              context,
              operationSignal,
            ),
            this.remainingTaskMs(consumed),
            signal,
          );
        } else {
          await this.runProviderOperation(
            (operationSignal) => consumed.adapter.resume(
              consumed.metadata,
              context,
              operationSignal,
            ),
            this.remainingTaskMs(consumed),
            signal,
          );
        }
        return { ok: true, snapshot: this.snapshot(taskId) ?? undefined };
      } catch {
        const current = this.tasks.get(taskId);
        if (current?.snapshot.status === 'running'
          && current.snapshot.sequence === expectedSequence + 1) {
          this.acceptEvent(taskId, {
            eventId: this.localEventId('cancel'),
            type: 'cancel_requested',
          });
          const canceling = this.tasks.get(taskId);
          if (!canceling || canceling.snapshot.status !== 'cancel_requested') {
            return { ok: false, code: 'task_record_failed' };
          }
          await this.bestEffortCancel(
            canceling.adapter,
            canceling.metadata,
            this.contextFor(canceling),
          );
          const afterCancel = this.tasks.get(taskId);
          if (afterCancel?.snapshot.status === 'cancel_requested') {
            this.acceptEvent(taskId, {
              eventId: this.localEventId(kind),
              type: 'incomplete',
              code: 'control_delivery_unknown',
            });
          }
        }
        return { ok: false, code: 'adapter_failed' };
      }
    });
  }

  private prepare(request: SpecialistTaskRequest):
    | { readonly ok: true; readonly binding: SpecialistResolvedBinding; readonly adapter: SpecialistTaskAdapter }
    | { readonly ok: false; readonly result: SpecialistRuntimeResult } {
    const parsed = SpecialistTaskRequestSchema.safeParse(request);
    if (!parsed.success) return { ok: false, result: { ok: false, code: 'invalid_request' } };
    const binding = this.dependencies.resolveBinding(parsed.data.role);
    if (!binding
      || binding.providerId !== parsed.data.providerId
      || binding.operationId !== parsed.data.operationId
      || binding.connectionId !== parsed.data.connectionId
      || binding.bindingId !== parsed.data.bindingId
      || binding.bindingRevision !== parsed.data.bindingRevision
      || !isAiOperationCompatible(binding.providerId, parsed.data.role, binding.operationId)) {
      return { ok: false, result: { ok: false, code: 'binding_unavailable' } };
    }
    const adapter = this.adapters.get(binding.operationId);
    if (!adapter || adapter.operationId !== binding.operationId || !adapter.isReady()) {
      return { ok: false, result: { ok: false, code: 'adapter_unavailable' } };
    }
    return { ok: true, binding, adapter };
  }

  private hasCapacity(providerId: string): boolean {
    const active = [...this.tasks.values()].filter(
      (task) => !isTerminalSpecialistTaskStatus(task.snapshot.status),
    );
    return active.length < this.maxConcurrentTasks
      && active.filter((task) => task.binding.providerId === providerId).length
        < this.maxConcurrentTasksPerProvider;
  }

  private acceptEvent(taskId: string, event: SpecialistAdapterEvent, consumeTurn = false): void {
    if (!this.acceptingAdapterEvents) return;
    const active = this.tasks.get(taskId);
    if (!active) return;
    const parsed = SpecialistAdapterEventSchema.safeParse(event);
    if (!parsed.success || active.eventIds.has(parsed.data.eventId)) return;
    if (isTerminalSpecialistTaskStatus(active.snapshot.status)) return;
    const terminalEvent = ['completed', 'failed', 'canceled', 'incomplete'].includes(parsed.data.type);
    const eventLimitExceeded = active.eventIds.size >= MAX_SPECIALIST_EVENT_IDS - 1
      && !terminalEvent
    const acceptedEvent: SpecialistAdapterEvent = eventLimitExceeded
      ? { eventId: parsed.data.eventId, type: 'incomplete', code: 'event_limit_exceeded' }
      : parsed.data;
    let next: SpecialistTaskSnapshot;
    try {
      next = applySpecialistTaskEvent(active.snapshot, acceptedEvent, timestamp(this.now));
    } catch {
      return;
    }
    const metadata: AcceptedSpecialistTaskMetadata = {
      ...active.metadata,
      status: next.status === 'starting' ? active.metadata.status : next.status,
      sequence: next.sequence,
      updatedAt: next.updatedAt,
      eventIds: Object.freeze([...active.metadata.eventIds, parsed.data.eventId]),
      turnsUsed: active.metadata.turnsUsed + (consumeTurn ? 1 : 0),
      ...(next.terminal?.code ? { terminalCode: next.terminal.code } : {}),
    };
    try {
      const stored = this.dependencies.store.snapshot();
      this.dependencies.store.update(metadata, stored.generation);
    } catch {
      if (this.dependencies.store.publicationState(metadata) !== 'published') return;
    }
    active.eventIds.clear();
    for (const eventId of metadata.eventIds) active.eventIds.add(eventId);
    active.metadata = metadata;
    active.snapshot = next;
    if (isTerminalSpecialistTaskStatus(next.status) && active.deadlineTimer) {
      clearTimeout(active.deadlineTimer);
      active.deadlineTimer = undefined;
    }
    this.publish(next);
    if (eventLimitExceeded) {
      void this.bestEffortCancel(active.adapter, active.metadata, this.contextFor(active));
    }
  }

  private localEventId(scope: string): string {
    return `local-${scope}-${randomUUID()}`;
  }

  private remainingMs(deadlineAtMs: number): number {
    return Math.max(1, deadlineAtMs - this.now());
  }

  private remainingTaskMs(active: ActiveTask): number {
    const deadlineAtMs = active.metadata.deadlineAt
      ? Date.parse(active.metadata.deadlineAt)
      : this.now() + this.providerOperationTimeoutMs;
    return Math.min(this.providerOperationTimeoutMs, this.remainingMs(deadlineAtMs));
  }

  private async runProviderOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const linked = linkAbortSignals(callerSignal, this.shutdownAbort.signal, controller.signal);
    this.providerOperations.add(controller);
    try {
      return await runWithTimeout(
        operation,
        Math.max(1, timeoutMs),
        'Specialist provider operation timed out',
        linked.signal,
      );
    } finally {
      this.providerOperations.delete(controller);
      linked.dispose();
    }
  }

  private async startProviderOperation(
    adapter: SpecialistTaskAdapter,
    request: SpecialistTaskRequest,
    context: SpecialistAdapterContext,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<Awaited<ReturnType<SpecialistTaskAdapter['start']>>> {
    const decision = { resolve: (_abandoned: boolean): void => undefined };
    const abandonment = new Promise<boolean>((resolve) => { decision.resolve = resolve; });
    try {
      const acceptance = await this.runProviderOperation((operationSignal) => {
        const pending = adapter.start(request, context, operationSignal);
        const observer = pending.then(async (lateAcceptance) => {
          if (await abandonment) {
            await this.bestEffortCancel(adapter, lateAcceptance, context);
          }
        }, () => undefined);
        this.trackLateStartObserver(observer);
        return pending;
      }, timeoutMs, callerSignal);
      decision.resolve(false);
      return acceptance;
    } catch (error) {
      decision.resolve(true);
      throw error;
    }
  }

  private trackLateStartObserver(observer: Promise<void>): void {
    this.lateStartObservers.add(observer);
    void observer.then(
      () => this.lateStartObservers.delete(observer),
      () => this.lateStartObservers.delete(observer),
    );
  }

  private persistAcceptedTask(
    candidate: AcceptedSpecialistTaskMetadata,
    expectedGeneration: number,
  ): boolean {
    try {
      this.dependencies.store.create(candidate, expectedGeneration);
      return true;
    } catch {
      if (this.dependencies.store.publicationState(candidate) === 'published') return true;
    }
    try {
      const latest = this.dependencies.store.snapshot();
      if (latest.tasks.some((task) => task.taskId === candidate.taskId)) return false;
      this.dependencies.store.create(candidate, latest.generation);
      return true;
    } catch {
      return this.dependencies.store.publicationState(candidate) === 'published';
    }
  }

  private scheduleDeadline(active: ActiveTask): void {
    if (!active.metadata.deadlineAt || isTerminalSpecialistTaskStatus(active.snapshot.status)) return;
    if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
    const delayMs = Math.max(0, Date.parse(active.metadata.deadlineAt) - this.now());
    active.deadlineTimer = setTimeout(() => {
      void this.enqueue(async () => {
        const current = this.tasks.get(active.metadata.taskId);
        if (!current || isTerminalSpecialistTaskStatus(current.snapshot.status)) return;
        this.acceptEvent(current.metadata.taskId, {
          eventId: this.localEventId('deadline'),
          type: 'incomplete',
          code: 'task_deadline_exceeded',
        });
        await this.bestEffortCancel(current.adapter, current.metadata, this.contextFor(current));
      });
    }, delayMs);
    active.deadlineTimer.unref?.();
  }

  private contextFor(active: ActiveTask) {
    return {
      resolveCredential: () => this.dependencies.resolveCredential(
        active.binding.connectionId,
        active.binding.providerId,
      ),
      emit: (event: SpecialistAdapterEvent): void => this.acceptEvent(active.metadata.taskId, event),
    };
  }

  private async bestEffortCancel(
    adapter: SpecialistTaskAdapter,
    acceptance: AcceptedSpecialistTaskMetadata
      | Awaited<ReturnType<SpecialistTaskAdapter['start']>>,
    context: ReturnType<SpecialistRuntimeService['contextFor']> | {
      readonly resolveCredential: () => string | null;
      readonly emit: (event: SpecialistAdapterEvent) => void;
    },
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cleanupTimeoutMs);
    let settleTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        adapter.cancel(acceptance, context, controller.signal),
        new Promise<void>((resolve) => {
          settleTimeout = setTimeout(resolve, this.cleanupTimeoutMs);
        }),
      ]);
    } catch {
      // The original durable-publication failure remains authoritative.
    } finally {
      clearTimeout(timeout);
      if (settleTimeout) clearTimeout(settleTimeout);
    }
  }

  private removePrunedTerminalTasks(
    persisted: ReturnType<SpecialistTaskStore['snapshot']>,
  ): void {
    const retained = new Set(persisted.tasks.map((task) => task.taskId));
    for (const [taskId, active] of this.tasks) {
      if (!retained.has(taskId) && isTerminalSpecialistTaskStatus(active.snapshot.status)) {
        this.tasks.delete(taskId);
      }
    }
  }

  private unavailableAdapter(operationId: SpecialistTaskAdapter['operationId']): SpecialistTaskAdapter {
    const unavailable = async (): Promise<void> => { throw new Error('Adapter unavailable'); };
    return {
      operationId,
      isReady: () => false,
      preflight: async () => ({ ok: false, code: 'unavailable' }),
      start: async () => { throw new Error('Adapter unavailable'); },
      resume: unavailable,
      provideInput: unavailable,
      cancel: unavailable,
    };
  }

  private publish(snapshot: SpecialistTaskSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(createSpecialistTaskSnapshot(snapshot));
      } catch {
        // One observer cannot break task state publication.
      }
    }
  }

  private enqueue(operation: () => Promise<SpecialistRuntimeResult | void>): Promise<SpecialistRuntimeResult> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run.then((result) => result ?? { ok: true });
  }
}
