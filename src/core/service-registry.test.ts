import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceRegistry } from './service-registry.js';
import { MessageBus } from './message-bus.js';
import type { SarahService } from './service.interface.js';
import type { BusMessage, ServiceStatus } from './types.js';

function createMockService(id: string, subs: string[] = []): SarahService {
  return {
    id,
    status: 'pending' as ServiceStatus,
    subscriptions: subs,
    init: vi.fn(async function (this: any) { this.status = 'running'; }),
    destroy: vi.fn(async function (this: any) { this.status = 'stopped'; }),
    onMessage: vi.fn(),
  };
}

describe('ServiceRegistry', () => {
  let bus: MessageBus;
  let registry: ServiceRegistry;

  beforeEach(() => {
    bus = new MessageBus();
    registry = new ServiceRegistry(bus);
  });

  it('registers and initializes a service', async () => {
    const svc = createMockService('test');
    registry.register(svc);

    await registry.initAll();

    expect(svc.init).toHaveBeenCalledOnce();
  });

  it('wires up subscriptions on init', async () => {
    const svc = createMockService('listener', ['voice:transcript']);
    registry.register(svc);
    await registry.initAll();

    bus.emit('voice', 'voice:transcript', { text: 'hello' });

    expect(svc.onMessage).toHaveBeenCalledOnce();
    expect(svc.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'voice:transcript' }),
    );
  });

  it('destroys all services in reverse order', async () => {
    const order: string[] = [];
    const svc1 = createMockService('first');
    svc1.destroy = vi.fn(async () => { order.push('first'); });
    const svc2 = createMockService('second');
    svc2.destroy = vi.fn(async () => { order.push('second'); });

    registry.register(svc1);
    registry.register(svc2);
    await registry.initAll();
    await registry.destroyAll();

    expect(order).toEqual(['second', 'first']);
  });

  it('throws on duplicate service ID', () => {
    registry.register(createMockService('dup'));
    expect(() => registry.register(createMockService('dup'))).toThrow('already registered');
  });

  it('returns a service by ID', () => {
    const svc = createMockService('finder');
    registry.register(svc);

    expect(registry.get('finder')).toBe(svc);
    expect(registry.get('nonexistent')).toBeUndefined();
  });
});
