import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServiceRegistry } from './service-registry.js';
import { MessageBus } from './message-bus.js';
import type { SarahService } from './service.interface.js';
import type { BusTopic } from './bus-events.js';
import type { TypedBusMessage, ServiceStatus } from './types.js';

const transcript = { turnId: 'turn-1', captureId: 'capture-1', text: 'hello' };

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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('registers and initializes a service', async () => {
    const svc = createMockService('test');
    registry.register(svc);

    await registry.initAll();

    expect(svc.init).toHaveBeenCalledOnce();
  });

  it('keeps boot performance diagnostics disabled by default', async () => {
    vi.stubEnv('SARAH_BOOT_TRACE', '0');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    registry.register(createMockService('quiet'));

    await registry.initAll();

    expect(log).not.toHaveBeenCalledWith('[BootPerf]', expect.any(String));
  });

  it('logs structured start and ready markers when boot diagnostics are enabled', async () => {
    vi.stubEnv('SARAH_BOOT_TRACE', '1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    registry.register(createMockService('voice'));

    await registry.initAll();

    expect(log).toHaveBeenCalledTimes(2);
    const start = JSON.parse(String(log.mock.calls[0]?.[1])) as Record<string, string | number>;
    const ready = JSON.parse(String(log.mock.calls[1]?.[1])) as Record<string, string | number>;
    expect(log.mock.calls[0]?.[0]).toBe('[BootPerf]');
    expect(start).toMatchObject({ component: 'service:voice', event: 'start' });
    expect(start.atMs).toEqual(expect.any(Number));
    expect(log.mock.calls[1]?.[0]).toBe('[BootPerf]');
    expect(ready).toMatchObject({ component: 'service:voice', event: 'ready' });
    expect(ready.atMs).toEqual(expect.any(Number));
    expect(ready.durationMs).toEqual(expect.any(Number));
  });

  it('logs a structured failed marker for an unsuccessful service start', async () => {
    vi.stubEnv('SARAH_BOOT_TRACE', '1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const service = createMockService('broken');
    service.init = vi.fn(async () => { throw new Error('cannot start'); });
    registry.register(service);

    await registry.initAll();

    expect(log).toHaveBeenCalledTimes(2);
    const failed = JSON.parse(String(log.mock.calls[1]?.[1])) as Record<string, string | number>;
    expect(log.mock.calls[1]?.[0]).toBe('[BootPerf]');
    expect(failed).toMatchObject({ component: 'service:broken', event: 'failed' });
    expect(failed.atMs).toEqual(expect.any(Number));
    expect(failed.durationMs).toEqual(expect.any(Number));
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
    bus.emit('voice', 'voice:transcript', transcript);

    expect(svc.init).toHaveBeenCalledOnce();
    expect(svc.onMessage).toHaveBeenCalledOnce();
    expect(firstReport).toBe(secondReport);
  });

  it('starts one service after its delay while earlier services are still initializing', async () => {
    vi.useFakeTimers();
    let releaseRouter!: () => void;
    const routerGate = new Promise<void>((resolve) => { releaseRouter = resolve; });
    const router = createMockService('router');
    router.init = vi.fn(async () => routerGate);
    const voice = createMockService('voice');
    const reminder = createMockService('reminder');
    registry.register(router);
    registry.register(voice, { startDelayMs: 3_000 });
    registry.register(reminder);

    const starting = registry.initAll();
    await Promise.resolve();
    expect(router.init).toHaveBeenCalledOnce();
    expect(voice.init).not.toHaveBeenCalled();
    expect(reminder.init).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_999);
    expect(voice.init).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(voice.init).toHaveBeenCalledOnce();
    expect(reminder.init).not.toHaveBeenCalled();

    releaseRouter();
    const report = await starting;

    expect(reminder.init).toHaveBeenCalledOnce();
    expect(report.ok).toBe(true);
    expect(report.services.map((result) => result.id)).toEqual(['router', 'voice', 'reminder']);
  });

  it('continues with later services when the delayed service fails', async () => {
    vi.useFakeTimers();
    const router = createMockService('router');
    const voice = createMockService('voice');
    voice.init = vi.fn(async () => { throw new Error('voice unavailable'); });
    const reminder = createMockService('reminder');
    registry.register(router);
    registry.register(voice, { startDelayMs: 3_000 });
    registry.register(reminder);

    const starting = registry.initAll();
    await vi.advanceTimersByTimeAsync(3_000);
    const report = await starting;

    expect(voice.destroy).toHaveBeenCalledOnce();
    expect(reminder.init).toHaveBeenCalledOnce();
    expect(report.ok).toBe(false);
    expect(report.services).toEqual([
      { id: 'router', ok: true },
      expect.objectContaining({ id: 'voice', ok: false }),
      { id: 'reminder', ok: true },
    ]);
  });

  it('cancels a delayed service start when shutdown begins', async () => {
    vi.useFakeTimers();
    const router = createMockService('router');
    const voice = createMockService('voice');
    const reminder = createMockService('reminder');
    registry.register(router);
    registry.register(voice, { startDelayMs: 3_000 });
    registry.register(reminder);

    const starting = registry.initAll();
    await Promise.resolve();
    const stopping = registry.destroyAll();
    await Promise.all([starting, stopping]);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(router.destroy).toHaveBeenCalledOnce();
    expect(voice.init).not.toHaveBeenCalled();
    expect(voice.destroy).not.toHaveBeenCalled();
    expect(reminder.init).not.toHaveBeenCalled();
  });

  it('wires up subscriptions on init', async () => {
    const svc = createMockService('listener', ['voice:transcript']);
    registry.register(svc);
    await registry.initAll();

    bus.emit('voice', 'voice:transcript', transcript);

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
    bus.emit('voice', 'voice:transcript', { ...transcript, text: 'ignored' });

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
    expect(svc.destroy).toHaveBeenCalledOnce();
  });

  it('terminates initAll when a service ignores its initialization deadline', async () => {
    registry = new ServiceRegistry(bus, { initTimeoutMs: 5, destroyTimeoutMs: 5 });
    const blocked = createMockService('blocked-init');
    blocked.init = vi.fn(async () => new Promise<void>(() => {}));
    registry.register(blocked);

    const report = await registry.initAll();

    expect(report.ok).toBe(false);
    expect(report.services[0]).toMatchObject({
      id: 'blocked-init',
      ok: false,
      error: { name: 'TimeoutError' },
    });
    expect(blocked.destroy).toHaveBeenCalledOnce();
  });

  it('continues cleanup after a service destroy exceeds its deadline', async () => {
    registry = new ServiceRegistry(bus, { destroyTimeoutMs: 5 });
    const healthy = createMockService('healthy');
    const blocked = createMockService('blocked');
    blocked.destroy = vi.fn(async () => new Promise<void>(() => {}));
    registry.register(healthy);
    registry.register(blocked);
    await registry.initAll();

    const report = await registry.destroyAll();

    expect(healthy.destroy).toHaveBeenCalledOnce();
    expect(report.ok).toBe(false);
    expect(report.services.find((result) => result.id === 'blocked')).toMatchObject({
      ok: false,
      error: { name: 'TimeoutError' },
    });
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
