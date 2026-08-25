import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceRegistry } from './service-registry.js';
import { MessageBus } from './message-bus.js';
import type { SarahService } from './service.interface.js';
import type { BusTopic } from './bus-events.js';
import type { TypedBusMessage, ServiceStatus } from './types.js';

function createMockService(id: string, subs: BusTopic[] = []): SarahService {
  return {
    id,
    status: 'pending' as ServiceStatus,
    subscriptions: subs,
    init: vi.fn(async function (this: { status: ServiceStatus }) { this.status = 'running'; }),
    destroy: vi.fn(async function (this: { status: ServiceStatus }) { this.status = 'stopped'; }),
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

  it('shares concurrent and repeated initialization without duplicate subscriptions', async () => {
    let releaseInit!: () => void;
    const initGate = new Promise<void>((resolve) => { releaseInit = resolve; });
    const svc = createMockService('single-flight', ['voice:transcript']);
    svc.init = vi.fn(async () => { await initGate; });
    registry.register(svc);

    const first = registry.initAll();
    const second = registry.initAll();
    releaseInit();
    const [firstReport, secondReport] = await Promise.all([first, second]);

    await registry.initAll();
    bus.emit('voice', 'voice:transcript', { text: 'hello' });

    expect(svc.init).toHaveBeenCalledOnce();
    expect(svc.onMessage).toHaveBeenCalledOnce();
    expect(firstReport).toBe(secondReport);
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

  it('cleans a failed service and continues initializing independent services', async () => {
    const failed = createMockService('failed', ['voice:transcript']);
    failed.init = vi.fn(async () => { throw new Error('cannot start'); });
    const healthy = createMockService('healthy');
    registry.register(failed);
    registry.register(healthy);

    const report = await registry.initAll();
    bus.emit('voice', 'voice:transcript', { text: 'ignored' });

    expect(report.ok).toBe(false);
    expect(report.services).toEqual([
      expect.objectContaining({ id: 'failed', ok: false }),
      { id: 'healthy', ok: true },
    ]);
    expect(failed.destroy).toHaveBeenCalledOnce();
    expect(failed.onMessage).not.toHaveBeenCalled();
    expect(healthy.init).toHaveBeenCalledOnce();
  });

  it('continues reverse cleanup after an individual destroy failure', async () => {
    const order: string[] = [];
    const first = createMockService('first');
    first.destroy = vi.fn(async () => { order.push('first'); });
    const broken = createMockService('broken');
    broken.destroy = vi.fn(async () => {
      order.push('broken');
      throw new Error('cleanup failed');
    });
    const last = createMockService('last');
    last.destroy = vi.fn(async () => { order.push('last'); });
    registry.register(first);
    registry.register(broken);
    registry.register(last);
    await registry.initAll();

    const report = await registry.destroyAll();

    expect(order).toEqual(['last', 'broken', 'first']);
    expect(report.ok).toBe(false);
    expect(report.services.find((result) => result.id === 'broken')).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it('shares repeated shutdown and destroys every initialized service once', async () => {
    const svc = createMockService('once');
    registry.register(svc);
    await registry.initAll();

    const first = registry.destroyAll();
    const second = registry.destroyAll();
    const [firstReport, secondReport] = await Promise.all([first, second]);

    expect(svc.destroy).toHaveBeenCalledOnce();
    expect(firstReport).toBe(secondReport);
  });

  it('aborts a cooperative service start before cleanup', async () => {
    const svc = createMockService('aborting');
    let receivedSignal: AbortSignal | undefined;
    svc.init = vi.fn((signal?: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('start aborted')), { once: true });
      });
    });
    registry.register(svc);

    const starting = registry.initAll();
    await Promise.resolve();
    await registry.destroyAll();
    await starting;

    expect(receivedSignal?.aborted).toBe(true);
    expect(svc.destroy).toHaveBeenCalledOnce();
  });

  it('does not block shutdown indefinitely on a non-cooperative service start', async () => {
    registry = new ServiceRegistry(bus, { initDrainTimeoutMs: 5 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const svc = createMockService('blocked');
    svc.init = vi.fn(async () => gate);
    registry.register(svc);

    const starting = registry.initAll();
    await Promise.resolve();
    await registry.destroyAll();

    expect(svc.destroy).toHaveBeenCalledOnce();
    release();
    await starting;
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
