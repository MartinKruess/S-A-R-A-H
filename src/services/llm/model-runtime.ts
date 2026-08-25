import type { RuntimeState } from '../../core/app-lifecycle-controller.js';
import type { LlmConfig } from '../../core/config-schema.js';
import type { ChatMessage, ChatOptions, LlmProvider } from './llm-provider.interface.js';
import type { OllamaContainerManager } from './ollama-container-manager.js';
import { PERFORMANCE_PROFILE_MAP } from './llm-types.js';
import { OllamaProvider } from './providers/ollama-provider.js';
import { RoutingService, type RoutingResult } from './routing-service.js';
import { VramManager } from './vram-manager.js';
import { WorkerService, type WorkerResult } from './worker-service.js';

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
  init(): Promise<ModelRuntimeSnapshot>;
  route(text: string): Promise<RoutingResult>;
  streamWorker(
    messages: ChatMessage[],
    responseStyle: string,
    onChunk: (text: string) => void,
  ): Promise<WorkerResult>;
  ensureRole(role: ModelRole): Promise<void>;
  scheduleRouterRestore(): void;
  destroy(): Promise<void>;
  /** Compatibility seam for focused legacy tests; productive code never calls it. */
  assumeRole(role: ModelRole): void;
}

interface ContainerRuntime {
  ensureRunning(): Promise<void>;
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
  /** Test/legacy adapter only: let the real request perform Ollama's lazy model load. */
  eagerLoadTransitions?: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

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
  private readonly eagerLoadTransitions: boolean;
  private current: ModelRuntimeSnapshot;
  private initPromise: Promise<ModelRuntimeSnapshot> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private generation = 0;

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

  init(): Promise<ModelRuntimeSnapshot> {
    if (this.destroyed || this.shuttingDown) {
      return Promise.reject(new Error('ModelRuntime is shutting down'));
    }
    if (!this.initPromise) this.initPromise = this.runInit();
    return this.initPromise;
  }

  private async runInit(): Promise<ModelRuntimeSnapshot> {
    this.current.state = 'starting';
    try {
      await this.containerManager?.ensureRunning();
    } catch (value) {
      const message = errorMessage(value);
      this.markUnavailable('router', message);
      this.markUnavailable('local_worker', message);
      this.current.state = 'error';
      throw value;
    }

    const [routerCheck, workerCheck] = await Promise.all([
      this.checkAvailability(this.routerProvider),
      this.checkAvailability(this.workerProvider),
    ]);
    if (routerCheck.error) this.markUnavailable('router', routerCheck.error);
    else this.setAvailability('router', routerCheck.available);
    if (workerCheck.error) this.markUnavailable('local_worker', workerCheck.error);
    else this.setAvailability('local_worker', workerCheck.available);

    if (!routerCheck.available) {
      this.current.state = 'error';
      throw new Error(`Router model unavailable: ${this.config.routerModel}`);
    }

    try {
      await this.ensureRole('router');
      if (!this.eagerLoadTransitions) {
        await this.routing.warmup();
      }
    } catch (value) {
      const message = errorMessage(value);
      this.current.state = 'error';
      this.onCapability?.('router', 'error', message);
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
  ): Promise<{ available: boolean; error?: string }> {
    try {
      return { available: await provider.isAvailable() };
    } catch (value) {
      return { available: false, error: errorMessage(value) };
    }
  }

  route(text: string): Promise<RoutingResult> {
    return this.runWithRole('router', () => this.routing.route(text));
  }

  streamWorker(
    messages: ChatMessage[],
    responseStyle: string,
    onChunk: (text: string) => void,
  ): Promise<WorkerResult> {
    return this.runWithRole(
      'local_worker',
      () => this.worker.stream(messages, responseStyle, onChunk),
      true,
    );
  }

  generateWorkerText(prompt: string, options?: ChatOptions): Promise<string> {
    return this.runWithRole(
      'local_worker',
      () => this.workerProvider.chat([{ role: 'user', content: prompt }], () => {}, options),
      true,
    );
  }

  ensureRole(role: ModelRole): Promise<void> {
    return this.enqueue(async (generation) => this.transition(role, generation));
  }

  private runWithRole<T>(role: ModelRole, operation: () => Promise<T>, restoreRouter = false): Promise<T> {
    return this.enqueue(async (generation) => {
      await this.transition(role, generation);
      this.assertCurrent(generation);
      const result = await operation();
      this.assertCurrent(generation);
      if (restoreRouter) this.scheduleRouterRestore();
      return result;
    });
  }

  private enqueue<T>(operation: (generation: number) => Promise<T>): Promise<T> {
    if (this.shuttingDown || this.destroyed) {
      return Promise.reject(new Error('ModelRuntime is shutting down'));
    }
    const generation = this.generation;
    const runOperation = () => operation(generation);
    const run = this.operationTail.then(runOperation, runOperation);
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async transition(role: ModelRole, generation: number): Promise<void> {
    this.assertCurrent(generation);
    this.clearIdleTimer();
    const target = this.current.roles[role];
    if (target.availability !== 'available') {
      throw new Error(target.message ?? `Model role unavailable: ${role}`);
    }
    if (this.current.activeRole === role && target.residency === 'loaded') return;

    const previousRole = this.current.activeRole;
    if (previousRole && previousRole !== role) {
      this.current.roles[previousRole].residency = 'unloading';
      const unloaded = await this.vram.unloadModel(this.modelFor(previousRole));
      this.assertCurrent(generation);
      this.current.roles[previousRole].residency = unloaded ? 'unloaded' : 'error';
    }

    target.residency = 'loading';
    try {
      if (this.eagerLoadTransitions) {
        await this.providerFor(role).chat(
          [{ role: 'user', content: 'ok' }],
          () => {},
          { num_predict: 1, keep_alive: -1 },
        );
        this.assertCurrent(generation);
        const loaded = await this.vram.waitForModel(this.modelFor(role));
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
      if (generation === this.generation && !this.shuttingDown && !this.destroyed) {
        target.residency = 'error';
        target.message = errorMessage(value);
        this.current.activeRole = null;
        this.current.state = role === 'router' ? 'error' : 'degraded';
        this.onCapability?.(role, 'error', target.message);
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

  assumeRole(role: ModelRole): void {
    this.clearIdleTimer();
    const other: ModelRole = role === 'router' ? 'local_worker' : 'router';
    this.current.activeRole = role;
    this.current.roles[role].availability = 'available';
    this.current.roles[role].residency = 'loaded';
    this.current.roles[other].residency = 'unloaded';
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this.runDestroy();
    return this.destroyPromise;
  }

  private async runDestroy(): Promise<void> {
    if (this.destroyed) return;
    this.shuttingDown = true;
    this.generation += 1;
    this.clearIdleTimer();

    await this.waitForOperationDrain();
    const [routerReleased, workerReleased] = await Promise.all([
      this.vram.unloadModel(this.config.routerModel),
      this.vram.unloadModel(this.config.workerModel),
    ]);
    this.current.activeRole = null;
    this.current.roles.router.residency = 'unloaded';
    this.current.roles.local_worker.residency = 'unloaded';
    this.current.state = 'stopped';
    this.destroyed = true;
    if (this.eagerLoadTransitions && (!routerReleased || !workerReleased)) {
      throw new AggregateError(
        [
          ...(!routerReleased ? [new Error(`Router model could not be unloaded: ${this.config.routerModel}`)] : []),
          ...(!workerReleased ? [new Error(`Worker model could not be unloaded: ${this.config.workerModel}`)] : []),
        ],
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
      throw new Error('ModelRuntime operation became stale during shutdown');
    }
  }
}
