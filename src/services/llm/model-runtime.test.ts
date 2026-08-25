import { describe, expect, it, vi } from 'vitest';
import type { LlmConfig } from '../../core/config-schema.js';
import type { ChatMessage, ChatOptions, LlmProvider } from './llm-provider.interface.js';
import { ModelRuntime } from './model-runtime.js';
import type { VramManager } from './vram-manager.js';

const config: LlmConfig = {
  baseUrl: 'http://ollama.test',
  routerModel: 'router:1b',
  workerModel: 'worker:9b',
  performanceProfile: 'normal',
  workerOptions: { num_ctx: 4096 },
  options: {},
};

function provider(name: string, available = true): LlmProvider {
  return {
    id: name,
    isAvailable: vi.fn(async () => available),
    chat: vi.fn(async (
      _messages: ChatMessage[],
      onChunk: (text: string) => void,
      options?: ChatOptions,
    ) => {
      const text = options?.num_predict === 1 ? 'ok' : name;
      onChunk(text);
      return text;
    }),
  };
}

function vram(loaded = true): VramManager {
  return {
    unloadModel: vi.fn(async () => true),
    waitForModel: vi.fn(async () => loaded),
  } as unknown as VramManager;
}

describe('ModelRuntime', () => {
  it('checks both roles and verifies the warmed router before reporting ready', async () => {
    const router = provider('router');
    const worker = provider('worker');
    const memory = vram();
    const runtime = new ModelRuntime({
      config,
      routerProvider: router,
      workerProvider: worker,
      vramManager: memory,
    });

    const snapshot = await runtime.init();

    expect(router.isAvailable).toHaveBeenCalledOnce();
    expect(worker.isAvailable).toHaveBeenCalledOnce();
    expect(memory.waitForModel).toHaveBeenCalledWith('router:1b');
    expect(snapshot.state).toBe('ready');
    expect(snapshot.activeRole).toBe('router');
    expect(snapshot.roles.router.residency).toBe('loaded');
    expect(snapshot.roles.local_worker.residency).toBe('unloaded');
  });

  it('keeps router operation available while reporting a missing worker as degraded', async () => {
    const capability = vi.fn();
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: provider('worker', false),
      vramManager: vram(),
      onCapability: capability,
    });

    const snapshot = await runtime.init();

    expect(snapshot.state).toBe('degraded');
    expect(snapshot.roles.local_worker.availability).toBe('unavailable');
    expect(capability).toHaveBeenCalledWith(
      'local_worker',
      'unavailable',
      expect.stringContaining('worker:9b'),
    );
    await expect(runtime.generateWorkerText('hello')).rejects.toThrow(/worker:9b/);
  });

  it('does not claim a role as loaded when residency verification fails', async () => {
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: provider('worker'),
      vramManager: vram(false),
    });

    await expect(runtime.init()).rejects.toThrow(/could not be verified/);
    expect(runtime.snapshot.activeRole).toBeNull();
    expect(runtime.snapshot.roles.router.residency).toBe('error');
  });

  it('serializes worker inference and a concurrently requested router operation', async () => {
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const order: string[] = [];
    const router = provider('router');
    const worker = provider('worker');
    (router.chat as ReturnType<typeof vi.fn>).mockImplementation(async (
      _messages: ChatMessage[],
      _onChunk: (text: string) => void,
      options?: ChatOptions,
    ) => {
      order.push(options?.num_predict === 1 ? 'warm-router' : 'route');
      return options?.num_predict === 1 ? 'ok' : '[ROUTE:self]';
    });
    (worker.chat as ReturnType<typeof vi.fn>).mockImplementation(async (
      _messages: ChatMessage[],
      onChunk: (text: string) => void,
      options?: ChatOptions,
    ) => {
      if (options?.num_predict === 1) {
        order.push('warm-worker');
        return 'ok';
      }
      order.push('worker-start');
      await workerGate;
      order.push('worker-end');
      onChunk('answer');
      return 'answer';
    });
    const runtime = new ModelRuntime({
      config,
      routerProvider: router,
      workerProvider: worker,
      vramManager: vram(),
    });
    await runtime.init();
    order.length = 0;

    const workerRun = runtime.streamWorker([{ role: 'user', content: 'question' }], 'kurz', () => {});
    const routeRun = runtime.route('open spotify');
    await vi.waitFor(() => expect(order).toContain('worker-start'));
    expect(order).not.toContain('route');
    releaseWorker();
    await Promise.all([workerRun, routeRun]);

    expect(order.indexOf('worker-end')).toBeLessThan(order.indexOf('route'));
    expect(runtime.snapshot.activeRole).toBe('router');
  });

  it('unloads both Sarah models during idempotent shutdown', async () => {
    const memory = vram();
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: provider('worker'),
      vramManager: memory,
    });
    await runtime.init();

    await Promise.all([runtime.destroy(), runtime.destroy()]);

    expect(memory.unloadModel).toHaveBeenCalledWith('router:1b');
    expect(memory.unloadModel).toHaveBeenCalledWith('worker:9b');
    expect(memory.unloadModel).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot.state).toBe('stopped');
  });

  it('rejects a late model transition without restoring loaded state after shutdown', async () => {
    let releaseWorkerWarmup!: () => void;
    const workerWarmupGate = new Promise<void>((resolve) => { releaseWorkerWarmup = resolve; });
    const worker = provider('worker');
    (worker.chat as ReturnType<typeof vi.fn>).mockImplementation(async (
      _messages: ChatMessage[],
      _onChunk: (text: string) => void,
      options?: ChatOptions,
    ) => {
      if (options?.num_predict === 1) await workerWarmupGate;
      return 'worker';
    });
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: worker,
      vramManager: vram(),
      operationDrainTimeoutMs: 0,
    });
    await runtime.init();

    const running = runtime.generateWorkerText('late');
    await vi.waitFor(() => expect(worker.chat).toHaveBeenCalled());
    await runtime.destroy();
    releaseWorkerWarmup();

    await expect(running).rejects.toThrow(/stale during shutdown/);
    expect(runtime.snapshot.state).toBe('stopped');
    expect(runtime.snapshot.activeRole).toBeNull();
    expect(runtime.snapshot.roles.local_worker.residency).toBe('unloaded');
  });
});
