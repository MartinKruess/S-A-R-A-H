import { describe, expect, it, vi } from 'vitest';
import { AppLifecycleController } from './app-lifecycle-controller.js';
import { MessageBus } from './message-bus.js';
import { ServiceRegistry } from './service-registry.js';
import type { SarahService } from './service.interface.js';

function service(id: string, initError?: Error): SarahService {
  return {
    id,
    status: 'pending',
    subscriptions: [],
    init: vi.fn(async () => {
      if (initError) throw initError;
    }),
    destroy: vi.fn(async () => {}),
    onMessage: vi.fn(),
  };
}

describe('AppLifecycleController', () => {
  it('publishes ready only after successful service initialization', async () => {
    const registry = new ServiceRegistry(new MessageBus());
    registry.register(service('router'));
    const lifecycle = new AppLifecycleController(registry);
    const states: string[] = [];
    lifecycle.subscribe((snapshot) => states.push(snapshot.state));

    const snapshot = await lifecycle.start();

    expect(snapshot.state).toBe('ready');
    expect(snapshot.capabilities.router.state).toBe('ready');
    expect(states[0]).toBe('registered');
    expect(states.at(-1)).toBe('ready');
    expect(states.slice(1, -1).every((state) => state === 'starting')).toBe(true);
    expect(lifecycle.acceptingWork).toBe(true);
  });

  it('publishes degraded with the failed capability while keeping healthy ones ready', async () => {
    const registry = new ServiceRegistry(new MessageBus());
    registry.register(service('router', new Error('offline')));
    registry.register(service('actions'));
    const lifecycle = new AppLifecycleController(registry);

    const snapshot = await lifecycle.start();

    expect(snapshot.state).toBe('degraded');
    expect(snapshot.capabilities.router).toEqual({ state: 'error', message: 'offline' });
    expect(snapshot.capabilities.actions.state).toBe('ready');
  });

  it('publishes a completed service capability while later services are still starting', async () => {
    let releaseVoice!: () => void;
    const voiceGate = new Promise<void>((resolve) => { releaseVoice = resolve; });
    const router = service('router');
    const voice = service('voice');
    voice.init = vi.fn(async () => { await voiceGate; });
    const registry = new ServiceRegistry(new MessageBus());
    registry.register(router);
    registry.register(voice);
    const lifecycle = new AppLifecycleController(registry);
    const snapshots: Array<{ state: string; router?: string }> = [];
    lifecycle.subscribe((snapshot) => snapshots.push({
      state: snapshot.state,
      router: snapshot.capabilities.router?.state,
    }));

    const starting = lifecycle.start();
    await vi.waitFor(() => expect(snapshots).toContainEqual({ state: 'starting', router: 'ready' }));
    releaseVoice();
    await starting;

    expect(lifecycle.snapshot.state).toBe('ready');
  });

  it('runs external cleanups in reverse order and continues after errors', async () => {
    const registry = new ServiceRegistry(new MessageBus());
    const lifecycle = new AppLifecycleController(registry);
    const order: string[] = [];
    lifecycle.registerCleanup('first', () => { order.push('first'); });
    lifecycle.registerCleanup('broken', () => {
      order.push('broken');
      throw new Error('failed');
    });
    lifecycle.registerCleanup('last', async () => { order.push('last'); });

    const report = await lifecycle.shutdown();

    expect(order).toEqual(['last', 'broken', 'first']);
    expect(report.ok).toBe(false);
    expect(report.cleanups.find((result) => result.label === 'broken')).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(lifecycle.snapshot.state).toBe('stopped');
    expect(lifecycle.acceptingWork).toBe(false);
  });

  it('detaches inbound bridges before services and closes resources afterwards', async () => {
    const order: string[] = [];
    const registry = new ServiceRegistry(new MessageBus());
    const owned = service('owned');
    owned.destroy = vi.fn(async () => { order.push('service'); });
    registry.register(owned);
    const lifecycle = new AppLifecycleController(registry);
    lifecycle.registerCleanup('storage', () => { order.push('after'); });
    lifecycle.registerCleanup('bridge', () => { order.push('before'); }, 'before_services');
    await lifecycle.start();

    await lifecycle.shutdown();

    expect(order).toEqual(['before', 'service', 'after']);
  });

  it('shares one idempotent shutdown across concurrent callers', async () => {
    const registry = new ServiceRegistry(new MessageBus());
    const lifecycle = new AppLifecycleController(registry);
    const cleanup = vi.fn(async () => {});
    lifecycle.registerCleanup('once', cleanup);

    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();
    const [firstReport, secondReport] = await Promise.all([first, second]);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(firstReport).toBe(secondReport);
  });

  it('ignores late capability updates after shutdown begins', async () => {
    const registry = new ServiceRegistry(new MessageBus());
    const lifecycle = new AppLifecycleController(registry);
    const shutdown = lifecycle.shutdown();
    lifecycle.setCapability('router', 'ready');
    await shutdown;

    expect(lifecycle.snapshot.capabilities).toEqual({});
    expect(lifecycle.snapshot.state).toBe('stopped');
  });

  it('never re-enters ready when shutdown races an in-flight start', async () => {
    let releaseInit!: () => void;
    const gate = new Promise<void>((resolve) => { releaseInit = resolve; });
    const slow = service('slow');
    slow.init = vi.fn(async () => { await gate; });
    const registry = new ServiceRegistry(new MessageBus());
    registry.register(slow);
    const lifecycle = new AppLifecycleController(registry);
    const states: string[] = [];
    lifecycle.subscribe((snapshot) => states.push(snapshot.state));

    const starting = lifecycle.start();
    const stopping = lifecycle.shutdown();
    releaseInit();
    await Promise.all([starting, stopping]);

    const stoppingIndex = states.indexOf('stopping');
    expect(stoppingIndex).toBeGreaterThanOrEqual(0);
    expect(states.slice(stoppingIndex + 1)).not.toContain('ready');
    expect(lifecycle.snapshot.state).toBe('stopped');
  });
});
