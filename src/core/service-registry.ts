import type { MessageBus } from './message-bus.js';
import type { SarahService } from './service.interface.js';

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
  private destroyed = false;

  constructor(private bus: MessageBus) {}

  /** Register a service. Must be called before initAll(). */
  register(service: SarahService): void {
    if (this.initPromise || this.destroyed) {
      throw new Error('Services can only be registered before initialization');
    }
    if (this.serviceMap.has(service.id)) {
      throw new Error(`Service "${service.id}" already registered`);
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
    const results: ServiceInitResult[] = [];

    for (const service of this.services) {
      const serviceUnsubscribers = service.subscriptions.map((topic) =>
        this.bus.on(topic, (msg) => service.onMessage(msg)),
      );
      this.unsubscribers.set(service.id, serviceUnsubscribers);

      try {
        await service.init();
        if (service.status === 'error') {
          throw new Error(`Service "${service.id}" entered error state during initialization`);
        }
        this.initialized.add(service.id);
        const result = { id: service.id, ok: true } satisfies ServiceInitResult;
        results.push(result);
        onResult?.(result);
      } catch (value) {
        for (const unsubscribe of serviceUnsubscribers) unsubscribe();
        this.unsubscribers.delete(service.id);

        const result: ServiceInitResult = {
          id: service.id,
          ok: false,
          error: toError(value),
        };
        try {
          await service.destroy();
        } catch (cleanupValue) {
          result.cleanupError = toError(cleanupValue);
        }
        results.push(result);
        onResult?.(result);
      }
    }

    const report = {
      services: results,
      ok: results.every((result) => result.ok),
    } satisfies ServiceInitReport;
    this.initReport = report;
    return report;
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
    if (this.initPromise) await this.initPromise;
    this.destroyed = true;

    for (const serviceUnsubscribers of this.unsubscribers.values()) {
      for (const unsubscribe of serviceUnsubscribers) unsubscribe();
    }
    this.unsubscribers.clear();

    const results: ServiceDestroyResult[] = [];
    for (const service of [...this.services].reverse()) {
      if (!this.initialized.has(service.id)) continue;
      try {
        await service.destroy();
        results.push({ id: service.id, ok: true });
      } catch (value) {
        results.push({ id: service.id, ok: false, error: toError(value) });
      }
    }
    this.initialized.clear();

    return {
      services: results,
      ok: results.every((result) => result.ok),
    };
  }
}
