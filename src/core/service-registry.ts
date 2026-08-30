import type { MessageBus } from './message-bus.js';
import type { SarahService } from './service.interface.js';
import { abortError, runWithTimeout, waitForSettlement } from './abort-utils.js';
import { traceBootPerformance } from './boot-performance-trace.js';

export interface ServiceInitResult {
  id: string;
  ok: boolean;
  error?: Error;
  cleanupError?: Error;
}

export interface ServiceInitReport {
  services: ServiceInitResult[];
  ok: boolean;
}

export interface ServiceDestroyResult {
  id: string;
  ok: boolean;
  error?: Error;
}

export interface ServiceDestroyReport {
  services: ServiceDestroyResult[];
  ok: boolean;
}

export interface ServiceRegistryOptions {
  initTimeoutMs?: number;
  initDrainTimeoutMs?: number;
  destroyTimeoutMs?: number;
}

export interface ServiceRegistrationOptions {
  /** Start this service after the delay while earlier services continue initializing. */
  startDelayMs?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 120_000;
const DEFAULT_INIT_DRAIN_TIMEOUT_MS = 2_000;
const DEFAULT_DESTROY_TIMEOUT_MS = 10_000;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class ServiceRegistry {
  private services: SarahService[] = [];
  private serviceMap = new Map<string, SarahService>();
  private unsubscribers = new Map<string, (() => void)[]>();
  private initialized = new Set<string>();
  private initPromise: Promise<ServiceInitReport> | null = null;
  private initReport: ServiceInitReport | null = null;
  private destroyPromise: Promise<ServiceDestroyReport> | null = null;
  private initAbort = new AbortController();
  private initializing = new Set<string>();
  private cleanupPromises = new Map<string, Promise<ServiceDestroyResult>>();
  private delayedStart: { serviceId: string; delayMs: number } | null = null;
  private destroyed = false;

  private readonly initTimeoutMs: number;
  private readonly initDrainTimeoutMs: number;
  private readonly destroyTimeoutMs: number;

  constructor(private bus: MessageBus, options: ServiceRegistryOptions = {}) {
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.initDrainTimeoutMs = options.initDrainTimeoutMs ?? DEFAULT_INIT_DRAIN_TIMEOUT_MS;
    this.destroyTimeoutMs = options.destroyTimeoutMs ?? DEFAULT_DESTROY_TIMEOUT_MS;
  }

  /** Register a service. Must be called before initAll(). */
  register(service: SarahService, options: ServiceRegistrationOptions = {}): void {
    if (this.initPromise || this.destroyed) {
      throw new Error('Services can only be registered before initialization');
    }
    if (this.serviceMap.has(service.id)) {
      throw new Error(`Service "${service.id}" already registered`);
    }
    const startDelayMs = options.startDelayMs ?? 0;
    if (!Number.isFinite(startDelayMs) || startDelayMs < 0) {
      throw new Error(`Invalid start delay for service "${service.id}"`);
    }
    if (startDelayMs > 0) {
      if (this.delayedStart) {
        throw new Error('Only one delayed service start is supported');
      }
      this.delayedStart = { serviceId: service.id, delayMs: startDelayMs };
    }
    this.services.push(service);
    this.serviceMap.set(service.id, service);
  }

  /** Get a registered service by ID. */
  get(id: string): SarahService | undefined {
    return this.serviceMap.get(id);
  }

  /**
   * Initialize every registered service exactly once.
   *
   * - Independent services continue after an earlier init failure.
   * - Failed services lose their subscriptions and receive best-effort cleanup.
   * - Concurrent/repeated calls share the same result.
   *
   * @returns Per-service initialization outcome.
   *
   * @category Service
   */
  initAll(onResult?: (result: ServiceInitResult) => void): Promise<ServiceInitReport> {
    if (this.destroyed) {
      return Promise.reject(new Error('Cannot initialize a destroyed ServiceRegistry'));
    }
    if (this.initReport) return Promise.resolve(this.initReport);
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.runInit(onResult);
    return this.initPromise;
  }

  private async runInit(onResult?: (result: ServiceInitResult) => void): Promise<ServiceInitReport> {
    const results = new Map<string, ServiceInitResult>();
    const initialize = async (service: SarahService): Promise<void> => {
      if (this.initAbort.signal.aborted || this.destroyed) return;
      const serviceStartedAt = performance.now();
      traceBootPerformance(`service:${service.id}`, 'start');
      const serviceUnsubscribers = service.subscriptions.map((topic) =>
        this.bus.on(topic, (msg) => service.onMessage(msg)),
      );
      this.unsubscribers.set(service.id, serviceUnsubscribers);
      this.initializing.add(service.id);

      try {
        await runWithTimeout(
          (signal) => service.init(signal),
          this.initTimeoutMs,
          `Service initialization timed out: ${service.id}`,
          this.initAbort.signal,
        );
        if (this.initAbort.signal.aborted || this.destroyed) throw abortError('Service initialization aborted');
        if (service.status === 'error') {
          throw new Error(`Service "${service.id}" entered error state during initialization`);
        }
        this.initialized.add(service.id);
        const result = { id: service.id, ok: true } satisfies ServiceInitResult;
        results.set(service.id, result);
        traceBootPerformance(`service:${service.id}`, 'ready', {
          durationMs: performance.now() - serviceStartedAt,
        });
        onResult?.(result);
      } catch (value) {
        for (const unsubscribe of serviceUnsubscribers) unsubscribe();
        this.unsubscribers.delete(service.id);

        const result: ServiceInitResult = {
          id: service.id,
          ok: false,
          error: toError(value),
        };
        const cleanup = await this.destroyServiceOnce(service);
        if (!cleanup.ok) result.cleanupError = cleanup.error;
        results.set(service.id, result);
        traceBootPerformance(`service:${service.id}`, 'failed', {
          durationMs: performance.now() - serviceStartedAt,
        });
        onResult?.(result);
      } finally {
        this.initializing.delete(service.id);
      }
    };
    const initializeSequentially = async (services: SarahService[]): Promise<void> => {
      for (const service of services) {
        if (this.initAbort.signal.aborted || this.destroyed) break;
        await initialize(service);
      }
    };

    const delayed = this.delayedStart;
    if (!delayed) {
      await initializeSequentially(this.services);
    } else {
      const delayedIndex = this.services.findIndex((service) => service.id === delayed.serviceId);
      const delayedService = this.services[delayedIndex];
      const delayedInitialization = this.waitForStartDelay(delayed.delayMs)
        .then((elapsed) => elapsed && delayedService ? initialize(delayedService) : undefined);

      await initializeSequentially(this.services.slice(0, delayedIndex));
      await delayedInitialization;
      await initializeSequentially(this.services.slice(delayedIndex + 1));
    }

    const orderedResults = this.services
      .map((service) => results.get(service.id))
      .filter((result): result is ServiceInitResult => result !== undefined);

    const report = {
      services: orderedResults,
      ok: orderedResults.every((result) => result.ok),
    } satisfies ServiceInitReport;
    this.initReport = report;
    return report;
  }

  private waitForStartDelay(delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const signal = this.initAbort.signal;
      if (signal.aborted || this.destroyed) {
        resolve(false);
        return;
      }
      const finish = (elapsed: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(elapsed);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(true), delayMs);
      timer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Destroy initialized services in reverse registration order.
   *
   * - Unsubscribes before provider/process cleanup.
   * - Continues after individual cleanup failures.
   * - Concurrent/repeated calls share one idempotent result.
   *
   * @returns Per-service cleanup outcome.
   *
   * @category Service
   */
  destroyAll(): Promise<ServiceDestroyReport> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this.runDestroy();
    return this.destroyPromise;
  }

  private async runDestroy(): Promise<ServiceDestroyReport> {
    this.destroyed = true;
    this.initAbort.abort();

    if (this.initPromise) {
      await waitForSettlement(this.initPromise, this.initDrainTimeoutMs);
    }

    for (const serviceUnsubscribers of this.unsubscribers.values()) {
      for (const unsubscribe of serviceUnsubscribers) unsubscribe();
    }
    this.unsubscribers.clear();

    const results: ServiceDestroyResult[] = [];
    for (const service of [...this.services].reverse()) {
      if (!this.initialized.has(service.id) && !this.initializing.has(service.id)) continue;
      results.push(await this.destroyServiceOnce(service));
    }
    this.initialized.clear();

    return {
      services: results,
      ok: results.every((result) => result.ok),
    };
  }

  private destroyServiceOnce(service: SarahService): Promise<ServiceDestroyResult> {
    const existing = this.cleanupPromises.get(service.id);
    if (existing) return existing;
    const attempt = runWithTimeout(
      (signal) => service.destroy(signal),
      this.destroyTimeoutMs,
      `Service cleanup timed out: ${service.id}`,
    )
      .then(
        () => ({ id: service.id, ok: true }) satisfies ServiceDestroyResult,
        (value) => ({ id: service.id, ok: false, error: toError(value) }) satisfies ServiceDestroyResult,
      );
    // Retain the terminal attempt for the registry lifetime. A timeout settles
    // only our wait; a non-cooperative destroy() may still be running and must
    // never be started a second time against the same native resources.
    this.cleanupPromises.set(service.id, attempt);
    return attempt;
  }
}
