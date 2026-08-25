import type {
  ServiceDestroyReport,
  ServiceInitReport,
  ServiceRegistry,
} from './service-registry.js';
import { runWithTimeout } from './abort-utils.js';

export type RuntimeState =
  | 'registered'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'unavailable'
  | 'error'
  | 'stopping'
  | 'stopped';

export interface CapabilitySnapshot {
  state: RuntimeState;
  message?: string;
}

export interface RuntimeSnapshot {
  state: RuntimeState;
  generation: number;
  updatedAt: number;
  capabilities: Record<string, CapabilitySnapshot>;
}

export interface CleanupResult {
  label: string;
  ok: boolean;
  error?: Error;
}

export interface AppShutdownReport {
  services: ServiceDestroyReport;
  cleanups: CleanupResult[];
  ok: boolean;
}

type Cleanup = (signal?: AbortSignal) => void | Promise<void>;
type SnapshotListener = (snapshot: RuntimeSnapshot) => void;
type CleanupPhase = 'before_services' | 'after_services';

export interface AppLifecycleOptions {
  cleanupTimeoutMs?: number;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Owns the application-wide boot/readiness/shutdown lifecycle.
 *
 * - Starts the ServiceRegistry once and exposes truthful capability state.
 * - Runs non-service cleanup callbacks in reverse registration order.
 * - Makes shutdown idempotent and best-effort across individual failures.
 *
 * @category Service
 */
export class AppLifecycleController {
  private state: RuntimeState = 'registered';
  private generation = 0;
  private capabilities = new Map<string, CapabilitySnapshot>();
  private cleanups: Array<{ label: string; cleanup: Cleanup; phase: CleanupPhase }> = [];
  private listeners = new Set<SnapshotListener>();
  private startPromise: Promise<RuntimeSnapshot> | null = null;
  private shutdownPromise: Promise<AppShutdownReport> | null = null;
  private readonly cleanupTimeoutMs: number;

  constructor(
    private readonly registry: ServiceRegistry,
    options: AppLifecycleOptions = {},
  ) {
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  }

  get acceptingWork(): boolean {
    return this.state === 'ready' || this.state === 'degraded';
  }

  get snapshot(): RuntimeSnapshot {
    return {
      state: this.state,
      generation: this.generation,
      updatedAt: Date.now(),
      capabilities: Object.fromEntries(
        [...this.capabilities.entries()].map(([name, capability]) => [name, { ...capability }]),
      ),
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  registerCleanup(
    label: string,
    cleanup: Cleanup,
    phase: CleanupPhase = 'after_services',
  ): () => void {
    if (this.state === 'stopping' || this.state === 'stopped') {
      throw new Error(`Cannot register cleanup "${label}" after shutdown started`);
    }
    const entry = { label, cleanup, phase };
    this.cleanups.push(entry);
    return () => {
      const index = this.cleanups.indexOf(entry);
      if (index >= 0) this.cleanups.splice(index, 1);
    };
  }

  setCapability(name: string, state: RuntimeState, message?: string): void {
    if (this.state === 'stopping' || this.state === 'stopped') return;
    this.capabilities.set(name, message ? { state, message } : { state });
    if (this.state !== 'registered' && this.state !== 'starting') {
      this.state = this.deriveRunningState();
    }
    this.publish();
  }

  start(): Promise<RuntimeSnapshot> {
    if (this.shutdownPromise || this.state === 'stopped') {
      return Promise.reject(new Error('Cannot start the application after shutdown'));
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.runStart();
    return this.startPromise;
  }

  private async runStart(): Promise<RuntimeSnapshot> {
    this.generation += 1;
    this.state = 'starting';
    this.publish();

    let report: ServiceInitReport;
    try {
      report = await this.registry.initAll((result) => {
        if (this.shutdownPromise) return;
        this.applyServiceResult(result);
        this.publish();
      });
    } catch (value) {
      if (!this.shutdownPromise) {
        this.state = 'error';
        this.capabilities.set('services', { state: 'error', message: toError(value).message });
        this.publish();
      }
      throw value;
    }
    if (this.shutdownPromise) {
      return this.snapshot;
    }
    this.applyServiceReport(report);
    this.state = this.deriveRunningState();
    this.publish();
    return this.snapshot;
  }

  private applyServiceReport(report: ServiceInitReport): void {
    for (const service of report.services) this.applyServiceResult(service);
  }

  private applyServiceResult(service: ServiceInitReport['services'][number]): void {
    const existing = this.capabilities.get(service.id);
    this.capabilities.set(
      service.id,
      service.ok
        ? { state: 'ready' }
        : {
            state: 'error',
            message: existing?.message ?? service.error?.message ?? 'Initialisierung fehlgeschlagen',
          },
    );
  }

  private deriveRunningState(): RuntimeState {
    const values = [...this.capabilities.values()];
    if (values.length === 0) return 'ready';
    if (values.some((capability) =>
      capability.state === 'error'
      || capability.state === 'unavailable'
      || capability.state === 'degraded')) {
      return 'degraded';
    }
    if (values.some((capability) =>
      capability.state === 'registered' || capability.state === 'starting')) {
      return 'starting';
    }
    return 'ready';
  }

  shutdown(): Promise<AppShutdownReport> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<AppShutdownReport> {
    this.state = 'stopping';
    this.publish();

    const cleanups: CleanupResult[] = [];
    const runCleanups = async (phase: CleanupPhase): Promise<void> => {
      for (const entry of [...this.cleanups].reverse()) {
        if (entry.phase !== phase) continue;
        try {
          await runWithTimeout(
            (signal) => entry.cleanup(signal),
            this.cleanupTimeoutMs,
            `Lifecycle cleanup timed out: ${entry.label}`,
          );
          cleanups.push({ label: entry.label, ok: true });
        } catch (value) {
          cleanups.push({ label: entry.label, ok: false, error: toError(value) });
        }
      }
    };

    await runCleanups('before_services');
    const services = await this.registry.destroyAll();
    await runCleanups('after_services');
    /*
     * Clear only after both phases so unregister callbacks remain harmless
     * while shutdown is in progress.
     */
    this.cleanups = [];
    this.capabilities.clear();
    this.state = 'stopped';
    this.publish();
    this.listeners.clear();

    return {
      services,
      cleanups,
      ok: services.ok && cleanups.every((result) => result.ok),
    };
  }

  private publish(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[Lifecycle] Snapshot listener failed:', error);
      }
    }
  }
}
