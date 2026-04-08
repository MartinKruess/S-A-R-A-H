import type { MessageBus } from './message-bus.js';
import type { SarahService } from './service.interface.js';

export class ServiceRegistry {
  private services: SarahService[] = [];
  private serviceMap = new Map<string, SarahService>();
  private unsubscribers: (() => void)[] = [];

  constructor(private bus: MessageBus) {}

  /** Register a service. Must be called before initAll(). */
  register(service: SarahService): void {
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

  /** Initialize all registered services and wire up their subscriptions. */
  async initAll(): Promise<void> {
    for (const service of this.services) {
      for (const topic of service.subscriptions) {
        const unsub = this.bus.on(topic, (msg) => service.onMessage(msg));
        this.unsubscribers.push(unsub);
      }
      await service.init();
    }
  }

  /** Destroy all services in reverse registration order. */
  async destroyAll(): Promise<void> {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    for (const service of [...this.services].reverse()) {
      await service.destroy();
    }
  }
}
