import type { RuntimeState } from '../../core/app-lifecycle-controller.js';
import type { LlmConfig } from '../../core/config-schema.js';
import type { ChatMessage, ChatOptions, LlmProvider } from './llm-provider.interface.js';
import type { OllamaContainerManager } from './ollama-container-manager.js';
import { PERFORMANCE_PROFILE_MAP } from './llm-types.js';
import { OllamaProvider } from './providers/ollama-provider.js';
import { RoutingService, type RoutingResult } from './routing-service.js';
import { VramManager } from './vram-manager.js';
import { WorkerService, type WorkerResult } from './worker-service.js';
import { linkAbortSignals, runWithTimeout, throwIfAborted } from '../../core/abort-utils.js';
import { chatWithTimeout } from './chat-with-timeout.js';

export type ModelRole = 'router' | 'local_worker';
export type ModelAvailability = 'checking' | 'available' | 'unavailable' | 'error';
export type ModelResidency = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'error';

export interface ModelRoleSnapshot {
  model: string;
  availability: ModelAvailability;
  residency: ModelResidency;
  message?: string;
}

export interface ModelRuntimeSnapshot {
  state: RuntimeState;
  activeRole: ModelRole | null;
  roles: Record<ModelRole, ModelRoleSnapshot>;
}

export interface WorkerTextGenerator {
  generateWorkerText(prompt: string, options?: ChatOptions): Promise<string>;
}

export interface ModelRuntimePort extends WorkerTextGenerator {
  readonly snapshot: ModelRuntimeSnapshot;
  init(signal?: AbortSignal): Promise<ModelRuntimeSnapshot>;
  route(text: string, signal?: AbortSignal): Promise<RoutingResult>;
  streamWorker(
    messages: ChatMessage[],
    responseStyle: string,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<WorkerResult>;
  ensureRole(role: ModelRole): Promise<void>;
  scheduleRouterRestore(): void;
  destroy(signal?: AbortSignal): Promise<void>;
  /** Compatibility seam for focused legacy tests; productive code never calls it. */
  assumeRole(role: ModelRole): void;
}

interface ContainerRuntime {
  ensureRunning(signal?: AbortSignal): Promise<void>;
}

export interface ModelRuntimeDeps {
  config: LlmConfig;
  containerManager?: Pick<OllamaContainerManager, 'ensureRunning'>;
  routerProvider?: LlmProvider;
  workerProvider?: LlmProvider;
  vramManager?: VramManager;
  onCapability?: (name: 'router' | 'local_worker', state: RuntimeState, message?: string) => void;
  idleTimeoutMs?: number;
  operationDrainTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  transitionTimeoutMs?: number;
  runtimeRecheckDelayMs?: number;
  /** Test/legacy adapter only: let the real request perform Ollama's lazy model load. */
  eagerLoadTransitions?: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 3_000;
const DEFAULT_TRANSITION_TIMEOUT_MS = 120_000;
const DEFAULT_RUNTIME_RECHECK_DELAY_MS = 5_000;

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function cloneSnapshot(snapshot: ModelRuntimeSnapshot): ModelRuntimeSnapshot {
  return {
    state: snapshot.state,
    activeRole: snapshot.activeRole,
    roles: {
      router: { ...snapshot.roles.router },
      local_worker: { ...snapshot.roles.local_worker },
    },
  };
}

/**
 * Owns local model availability, VRAM residency and serialized role changes.
 *
 * - Keeps the router and free-text worker behind separate operations.
 * - Serializes transition plus inference so idle unload cannot race a request.
 * - Verifies productive model loads through Ollama's process state.
 *
 * @category Service
 */
export class ModelRuntime implements ModelRuntimePort {
  private readonly config: LlmConfig;
  private readonly containerManager?: ContainerRuntime;
  private readonly routerProvider: LlmProvider;
  private readonly workerProvider: LlmProvider;
  private readonly routing: RoutingService;
  private readonly worker: WorkerService;
  private readonly vram: VramManager;
  private readonly onCapability?: ModelRuntimeDeps['onCapability'];
  private readonly idleTimeoutMs: number;
  private readonly operationDrainTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly transitionTimeoutMs: number;
  private readonly runtimeRecheckDelayMs: number;
  private readonly eagerLoadTransitions: boolean;
  private current: ModelRuntimeSnapshot;
  private initPromise: Promise<ModelRuntimeSnapshot> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private generation = 0;
  private readonly runtimeAbort = new AbortController();
  private initSignalCleanup: (() => void) | null = null;

  constructor(deps: ModelRuntimeDeps) {
    this.config = structuredClone(deps.config);
    this.containerManager = deps.containerManager;
    const numGpu = PERFORMANCE_PROFILE_MAP[this.config.performanceProfile]
      ?? PERFORMANCE_PROFILE_MAP.normal;
    this.routerProvider = deps.routerProvider ?? new OllamaProvider(
      this.config.baseUrl,
      this.config.routerModel,
      { ...this.config.options, num_ctx: 2048, num_gpu: -1 },
    );
    this.workerProvider = deps.workerProvider ?? new OllamaProvider(
      this.config.baseUrl,
      this.config.workerModel,
      {
        ...this.config.options,
        num_ctx: this.config.workerOptions.num_ctx,
        num_gpu: numGpu,
      },
    );
    this.routing = new RoutingService(this.routerProvider);
    this.worker = new WorkerService(this.workerProvider);
    this.vram = deps.vramManager ?? new VramManager(this.config.baseUrl);
    this.onCapability = deps.onCapability;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.operationDrainTimeoutMs = deps.operationDrainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.cleanupTimeoutMs = deps.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    this.transitionTimeoutMs = deps.transitionTimeoutMs ?? DEFAULT_TRANSITION_TIMEOUT_MS;
    this.runtimeRecheckDelayMs = deps.runtimeRecheckDelayMs ?? DEFAULT_RUNTIME_RECHECK_DELAY_MS;
    this.eagerLoadTransitions = deps.eagerLoadTransitions ?? true;
    this.current = {
      state: 'registered',
      activeRole: null,
      roles: {
        router: {
          model: this.config.routerModel,
          availability: 'checking',
          residency: 'unloaded',
        },
        local_worker: {
          model: this.config.workerModel,
          availability: 'checking',
          residency: 'unloaded',
        },
      },
    };
  }

  get snapshot(): ModelRuntimeSnapshot {
    return cloneSnapshot(this.current);
  }

  init(signal?: AbortSignal): Promise<ModelRuntimeSnapshot> {
    if (this.destroyed || this.shuttingDown) {
      return Promise.reject(new Error('ModelRuntime is shutting down'));
    }
    if (!this.initPromise) {
      if (signal) {
        const onAbort = (): void => this.runtimeAbort.abort(signal.reason);
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener('abort', onAbort, { once: true });
          this.initSignalCleanup = () => signal.removeEventListener('abort', onAbort);
        }
      }
      this.initPromise = this.runInit();
    }
    return this.initPromise;
  }

  private async runInit(): Promise<ModelRuntimeSnapshot> {
    this.current.state = 'starting';
    throwIfAborted(this.runtimeAbort.signal);
    try {
      await this.containerManager?.ensureRunning(this.runtimeAbort.signal);
    } catch (value) {
      const message = errorMessage(value);
      this.markUnavailable('router', message);
      this.markUnavailable('local_worker', message);
      this.current.state = 'error';
      this.scheduleRuntimeRecheck();
      throw value;
    }

    const [routerCheck, workerCheck] = await Promise.all([
      this.checkAvailability(this.routerProvider, this.runtimeAbort.signal),
      this.checkAvailability(this.workerProvider, this.runtimeAbort.signal),
    ]);
    if (routerCheck.error) this.markUnavailable('router', routerCheck.error);
    else this.setAvailability('router', routerCheck.available);
    if (workerCheck.error) this.markUnavailable('local_worker', workerCheck.error);
    else this.setAvailability('local_worker', workerCheck.available);
    if (!workerCheck.available) this.scheduleRuntimeRecheck();

    if (!routerCheck.available) {
      this.current.state = 'error';
      this.scheduleRuntimeRecheck();
      throw new Error(`Router model unavailable: ${this.config.routerModel}`);
    }

    try {
      await this.ensureRole('router');
      if (!this.eagerLoadTransitions) {
        await runWithTimeout(
          (warmupSignal) => this.routing.warmup(warmupSignal),
          this.transitionTimeoutMs,
          `Router warmup timed out: ${this.config.routerModel}`,
          this.runtimeAbort.signal,
        );
      }
    } catch (value) {
      const message = errorMessage(value);
      this.current.state = 'error';
      this.onCapability?.('router', 'error', message);
      this.scheduleRuntimeRecheck();
      throw value;
    }
    this.current.state = workerCheck.available ? 'ready' : 'degraded';
    return this.snapshot;
  }

  private setAvailability(role: ModelRole, available: boolean): void {
    const state = available ? 'available' : 'unavailable';
    this.current.roles[role] = {
      ...this.current.roles[role],
      availability: state,
      ...(available ? { message: undefined } : { message: `Modell nicht verfügbar: ${this.modelFor(role)}` }),
    };
    this.onCapability?.(
      role,
      available ? (role === 'router' ? 'starting' : 'ready') : 'unavailable',
      available ? undefined : this.current.roles[role].message,
    );
  }

  private markUnavailable(role: ModelRole, message: string): void {
    this.current.roles[role] = {
      ...this.current.roles[role],
      availability: 'error',
      residency: 'error',
      message,
    };
    this.onCapability?.(role, 'error', message);
  }

  private async checkAvailability(
    provider: LlmProvider,
    signal?: AbortSignal,
  ): Promise<{ available: boolean; error?: string }> {
    try {
      return { available: await provider.isAvailable(signal) };
    } catch (value) {
      return { available: false, error: errorMessage(value) };
    }
  }

  route(text: string, signal?: AbortSignal): Promise<RoutingResult> {
    return this.runWithRole('router', (operationSignal) => this.routing.route(text, operationSignal), false, signal);
  }

  streamWorker(
    messages: ChatMessage[],
    responseStyle: string,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    return this.runWithRole(
      'local_worker',
      (operationSignal) => this.worker.stream(messages, responseStyle, onChunk, operationSignal),
      true,
      signal,
    );
  }

  generateWorkerText(prompt: string, options?: ChatOptions): Promise<string> {
    return this.runWithRole(
      'local_worker',
      (operationSignal) => chatWithTimeout(
        this.workerProvider,
        [{ role: 'user', content: prompt }],
        () => {},
        { ...options, signal: operationSignal },
      ),
      true,
      options?.signal,
    );
  }

  ensureRole(role: ModelRole): Promise<void> {
    return this.enqueue(async (generation) => this.transition(role, generation));
  }

  private runWithRole<T>(
    role: ModelRole,
    operation: (signal: AbortSignal) => Promise<T>,
    restoreRouter = false,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    return this.enqueue(async (generation) => {
      const linked = linkAbortSignals(this.runtimeAbort.signal, callerSignal);
      let transitionCompleted = false;
      try {
        throwIfAborted(linked.signal);
        await this.transition(role, generation, linked.signal);
        transitionCompleted = true;
        this.assertCurrent(generation);
        const result = await operation(linked.signal);
        this.assertCurrent(generation);
        if (restoreRouter) this.scheduleRouterRestore();
        return result;
      } catch (operationError) {
        const operationWasAborted = linked.signal.aborted
          || (operationError instanceof Error && operationError.name === 'AbortError');
        if (
          restoreRouter
          && generation === this.generation
          && !this.shuttingDown
          && !this.destroyed
          && !this.runtimeAbort.signal.aborted
          && (
            this.current.activeRole !== 'router'
            || this.current.roles.router.residency !== 'loaded'
          )
        ) {
          try {
            await this.transition('router', generation, this.runtimeAbort.signal);
          } catch (restoreError) {
            if (
              generation !== this.generation
              || this.shuttingDown
              || this.destroyed
              || this.runtimeAbort.signal.aborted
            ) {
              throw operationError;
            }
            const message = `Router restore failed: ${errorMessage(restoreError)}`;
            this.current.roles.router.residency = 'error';
            this.current.roles.router.message = message;
            this.current.state = 'degraded';
            this.onCapability?.('router', 'error', message);
            if (!operationWasAborted) this.markRuntimeFailure(role, operationError);
            throw new AggregateError(
              [operationError, restoreError],
              'Worker operation and router restore failed',
            );
          }
        }
        if (
          transitionCompleted
          && !operationWasAborted
          && generation === this.generation
          && !this.shuttingDown
          && !this.destroyed
        ) {
          this.markRuntimeFailure(role, operationError);
        }
        throw operationError;
      } finally {
        linked.dispose();
      }
    }, callerSignal);
  }

  private enqueue<T>(
    operation: (generation: number) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (this.shuttingDown || this.destroyed || this.runtimeAbort.signal.aborted) {
      return Promise.reject(new Error('ModelRuntime is shutting down'));
    }
    if (callerSignal?.aborted) {
      const reason = callerSignal.reason;
      return Promise.reject(reason instanceof Error ? reason : new Error('ModelRuntime operation aborted'));
    }
    const runOperation = () => {
      throwIfAborted(callerSignal);
      const generation = ++this.generation;
      return operation(generation);
    };
    const run = this.operationTail.then(runOperation, runOperation);
    this.operationTail = run.then(() => undefined, () => undefined);
    if (!callerSignal) return run;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callerSignal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => finish(() => {
        const reason = callerSignal.reason;
        reject(reason instanceof Error ? reason : new Error('ModelRuntime operation aborted'));
      });
      callerSignal.addEventListener('abort', onAbort, { once: true });
      run.then(
        (value) => finish(() => resolve(value)),
        (error: Error) => finish(() => reject(error)),
      );
    });
  }

  private async transition(role: ModelRole, generation: number, signal = this.runtimeAbort.signal): Promise<void> {
    try {
      await runWithTimeout(
        (transitionSignal) => this.performTransition(role, generation, transitionSignal),
        this.transitionTimeoutMs,
        `Model transition timed out: ${this.modelFor(role)}`,
        signal,
      );
    } catch (error) {
      if (
        error instanceof Error
        && error.name === 'TimeoutError'
        && generation === this.generation
        && !this.shuttingDown
      ) {
        this.generation += 1;
        const message = error.message;
        const activeRole = this.current.activeRole;
        if (activeRole) {
          this.current.roles[activeRole].residency = 'error';
          this.current.roles[activeRole].message = message;
          this.onCapability?.(activeRole, 'error', message);
        }
        this.current.roles[role].residency = 'error';
        this.current.roles[role].message = message;
        this.current.activeRole = null;
        this.current.state = role === 'router' ? 'error' : 'degraded';
        this.onCapability?.(role, 'error', message);
        this.scheduleRuntimeRecheck();
      }
      throw error;
    }
  }

  private async performTransition(
    role: ModelRole,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertCurrent(generation);
    throwIfAborted(signal);
    this.clearIdleTimer();
    const target = this.current.roles[role];
    if (target.availability !== 'available') {
      throw new Error(target.message ?? `Model role unavailable: ${role}`);
    }
    if (this.current.activeRole === role && target.residency === 'loaded') return;

    const previousRole = this.current.activeRole;
    if (previousRole && previousRole !== role) {
      this.current.roles[previousRole].residency = 'unloading';
      if (this.eagerLoadTransitions) {
        const unloaded = await this.vram.unloadModel(this.modelFor(previousRole), signal);
        this.assertCurrent(generation);
        if (!unloaded) {
          const message = `Model could not be unloaded: ${this.modelFor(previousRole)}`;
          this.current.roles[previousRole].residency = 'error';
          this.current.roles[previousRole].message = message;
          this.current.state = 'degraded';
          this.onCapability?.(previousRole, 'error', message);
          throw new Error(message);
        }
      }
      this.current.roles[previousRole].residency = 'unloaded';
      this.current.activeRole = null;
    }

    target.residency = 'loading';
    try {
      if (this.eagerLoadTransitions) {
        await this.providerFor(role).chat(
          [{ role: 'user', content: 'ok' }],
          () => {},
          { num_predict: 1, keep_alive: -1, signal },
        );
        this.assertCurrent(generation);
        const loaded = await this.vram.waitForModel(this.modelFor(role), 10, 100, signal);
        this.assertCurrent(generation);
        if (!loaded) throw new Error(`Model load could not be verified: ${this.modelFor(role)}`);
      }
      target.residency = 'loaded';
      target.message = undefined;
      this.current.activeRole = role;
      this.current.state = this.current.roles.local_worker.availability === 'available'
        ? 'ready'
        : 'degraded';
      this.onCapability?.(role, 'ready');
    } catch (value) {
      const mayCleanUp = (
        generation === this.generation
        && !this.shuttingDown
        && !this.destroyed
        && !this.runtimeAbort.signal.aborted
      );
      let targetUnloaded = false;
      if (mayCleanUp) {
        try {
          targetUnloaded = await this.vram.unloadModel(
            this.modelFor(role),
            this.runtimeAbort.signal,
          );
        } catch {
          // The original transition error remains the primary failure.
        }
      }
      if (
        mayCleanUp
        && generation === this.generation
        && !this.shuttingDown
        && !this.destroyed
        && !this.runtimeAbort.signal.aborted
      ) {
        const cancelledCleanly = signal.aborted && targetUnloaded;
        target.residency = cancelledCleanly ? 'unloaded' : 'error';
        target.message = cancelledCleanly ? undefined : errorMessage(value);
        this.current.activeRole = null;
        this.current.state = role === 'router' ? 'error' : 'degraded';
        if (!cancelledCleanly) this.markRuntimeFailure(role, value);
      }
      throw value;
    }
  }

  scheduleRouterRestore(): void {
    this.clearIdleTimer();
    if (this.shuttingDown || this.current.activeRole !== 'local_worker') return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.ensureRole('router').catch((value) => {
        console.warn('[ModelRuntime] Router restore failed:', value);
      });
    }, this.idleTimeoutMs);
  }

  private markRuntimeFailure(role: ModelRole, value: unknown): void {
    const message = errorMessage(value);
    const currentRole = this.current.roles[role];
    currentRole.availability = 'error';
    if (this.current.activeRole === role) currentRole.residency = 'error';
    currentRole.message = message;
    if (this.current.activeRole === role) this.current.activeRole = null;
    this.current.state = role === 'router' ? 'error' : 'degraded';
    this.onCapability?.(role, 'error', message);
    this.scheduleRuntimeRecheck();
  }

  private scheduleRuntimeRecheck(): void {
    if (this.shuttingDown || this.destroyed || this.runtimeRecheckTimer) return;
    this.runtimeRecheckTimer = setTimeout(() => {
      this.runtimeRecheckTimer = null;
      void this.recheckRuntime().catch((value) => {
        if (!this.shuttingDown && !this.destroyed) {
          console.warn('[ModelRuntime] Runtime recheck failed:', value);
          this.scheduleRuntimeRecheck();
        }
      });
    }, this.runtimeRecheckDelayMs);
    this.runtimeRecheckTimer.unref?.();
  }

  private async recheckRuntime(): Promise<void> {
    if (this.shuttingDown || this.destroyed) return;
    await runWithTimeout(
      async (signal) => {
        await this.containerManager?.ensureRunning(signal);
        const [routerCheck, workerCheck] = await Promise.all([
          this.checkAvailability(this.routerProvider, signal),
          this.checkAvailability(this.workerProvider, signal),
        ]);
        if (!routerCheck.available) {
          const message = routerCheck.error ?? `Modell nicht verfügbar: ${this.config.routerModel}`;
          this.markUnavailable('router', message);
          throw new Error(message);
        }
        this.setAvailability('router', true);
        if (workerCheck.available) this.setAvailability('local_worker', true);
        else this.markUnavailable(
          'local_worker',
          workerCheck.error ?? `Modell nicht verfügbar: ${this.config.workerModel}`,
        );
      },
      this.transitionTimeoutMs,
      'Ollama runtime recheck timed out',
      this.runtimeAbort.signal,
    );
    await this.ensureRole('router');
    this.current.state = this.current.roles.local_worker.availability === 'available'
      ? 'ready'
      : 'degraded';
    if (this.current.roles.local_worker.availability !== 'available') {
      this.scheduleRuntimeRecheck();
    }
  }

  assumeRole(role: ModelRole): void {
    this.clearIdleTimer();
    const other: ModelRole = role === 'router' ? 'local_worker' : 'router';
    this.current.activeRole = role;
    this.current.roles[role].availability = 'available';
    this.current.roles[role].residency = 'loaded';
    this.current.roles[other].residency = 'unloaded';
  }

  destroy(signal?: AbortSignal): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this.runDestroy(signal);
    return this.destroyPromise;
  }

  private async runDestroy(signal?: AbortSignal): Promise<void> {
    if (this.destroyed) return;
    this.shuttingDown = true;
    this.generation += 1;
    this.clearIdleTimer();
    if (this.runtimeRecheckTimer) clearTimeout(this.runtimeRecheckTimer);
    this.runtimeRecheckTimer = null;
    this.initSignalCleanup?.();
    this.initSignalCleanup = null;
    this.runtimeAbort.abort();

    await this.waitForOperationDrain();
    const releaseModel = async (model: string): Promise<void> => {
      const released = await runWithTimeout(
        (cleanupSignal) => this.vram.unloadModel(model, cleanupSignal),
        this.cleanupTimeoutMs,
        `Model cleanup timed out: ${model}`,
        signal,
      );
      if (!released) throw new Error(`Model could not be unloaded: ${model}`);
    };
    const releases = await Promise.allSettled([
      releaseModel(this.config.routerModel),
      releaseModel(this.config.workerModel),
    ]);
    this.current.activeRole = null;
    this.current.roles.router.residency = releases[0].status === 'fulfilled' ? 'unloaded' : 'error';
    this.current.roles.local_worker.residency = releases[1].status === 'fulfilled' ? 'unloaded' : 'error';
    this.current.roles.router.message = releases[0].status === 'rejected'
      ? errorMessage(releases[0].reason)
      : undefined;
    this.current.roles.local_worker.message = releases[1].status === 'rejected'
      ? errorMessage(releases[1].reason)
      : undefined;
    this.current.state = 'stopped';
    this.destroyed = true;
    const failures = releases.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (this.eagerLoadTransitions && failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Model cleanup failed',
      );
    }
  }

  private providerFor(role: ModelRole): LlmProvider {
    return role === 'router' ? this.routerProvider : this.workerProvider;
  }

  private modelFor(role: ModelRole): string {
    return role === 'router' ? this.config.routerModel : this.config.workerModel;
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private waitForOperationDrain(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, this.operationDrainTimeoutMs);
      timer.unref?.();
      void this.operationTail.then(finish, finish);
    });
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation || this.shuttingDown || this.destroyed) {
      throw new Error('ModelRuntime operation became stale');
    }
  }
}
