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
    expect(memory.waitForModel).toHaveBeenCalledWith(
      'router:1b',
      10,
      100,
      expect.any(AbortSignal),
    );
    expect(snapshot.state).toBe('ready');
    expect(snapshot.activeRole).toBe('router');
    expect(snapshot.roles.router.residency).toBe('loaded');
    expect(snapshot.roles.local_worker.residency).toBe('unloaded');
  });

  it('keeps the non-loading legacy adapter independent from a real VRAM runtime', async () => {
    const memory = vram(false);
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: provider('worker'),
      vramManager: memory,
      eagerLoadTransitions: false,
    });
    await runtime.init();

    await expect(runtime.generateWorkerText('question')).resolves.toBe('worker');

    expect(memory.waitForModel).not.toHaveBeenCalled();
    expect(memory.unloadModel).not.toHaveBeenCalled();
    expect(runtime.snapshot.activeRole).toBe('local_worker');
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

  it('lets an aborted queued turn reject immediately and releases the queue after a transition deadline', async () => {
    const memory = vram();
    (memory.unloadModel as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => new Promise<boolean>(() => {}))
      .mockResolvedValue(true);
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: provider('worker'),
      vramManager: memory,
      transitionTimeoutMs: 20,
      runtimeRecheckDelayMs: 60_000,
    });
    await runtime.init();

    const blocked = runtime.generateWorkerText('blocked');
    await vi.waitFor(() => expect(memory.unloadModel).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const queued = runtime.route('queued', controller.signal);
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await expect(blocked).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(runtime.route('after deadline')).resolves.toMatchObject({
      parsed: { kind: 'route' },
    });
    await runtime.destroy();
  });

  it('publishes a runtime outage and recovers capability through one controlled recheck', async () => {
    const router = provider('router');
    (router.chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('ok')
      .mockRejectedValueOnce(new Error('Ollama connection lost'))
      .mockResolvedValue('ok');
    const capability = vi.fn();
    const runtime = new ModelRuntime({
      config,
      routerProvider: router,
      workerProvider: provider('worker'),
      vramManager: vram(),
      onCapability: capability,
      runtimeRecheckDelayMs: 5,
    });
    await runtime.init();

    await expect(runtime.route('hello')).rejects.toThrow('Ollama connection lost');
    expect(capability).toHaveBeenCalledWith('router', 'error', 'Ollama connection lost');
    await vi.waitFor(() => {
      expect(router.isAvailable).toHaveBeenCalledTimes(2);
      expect(capability).toHaveBeenCalledWith('router', 'ready');
    });
    expect(runtime.snapshot.state).toBe('ready');
    await runtime.destroy();
  });

  it('keeps retrying after initial runtime failures until the router becomes available', async () => {
    const router = provider('router');
    (router.isAvailable as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const runtime = new ModelRuntime({
      config,
      routerProvider: router,
      workerProvider: provider('worker'),
      vramManager: vram(),
      runtimeRecheckDelayMs: 5,
    });

    await expect(runtime.init()).rejects.toThrow('Router model unavailable');
    await vi.waitFor(() => {
      expect(router.isAvailable).toHaveBeenCalledTimes(3);
      expect(runtime.snapshot.roles.router.availability).toBe('available');
      expect(runtime.snapshot.activeRole).toBe('router');
    });
    expect(runtime.snapshot.state).toBe('ready');
    await runtime.destroy();
  });

  it('keeps rechecking an initially missing worker without taking the router offline', async () => {
    const worker = provider('worker');
    (worker.isAvailable as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const capability = vi.fn();
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: worker,
      vramManager: vram(),
      onCapability: capability,
      runtimeRecheckDelayMs: 5,
    });

    const initial = await runtime.init();
    expect(initial.state).toBe('degraded');
    expect(initial.activeRole).toBe('router');
    await vi.waitFor(() => {
      expect(worker.isAvailable).toHaveBeenCalledTimes(3);
      expect(runtime.snapshot.roles.local_worker.availability).toBe('available');
    });
    expect(runtime.snapshot.state).toBe('ready');
    const routerStates = capability.mock.calls
      .filter(([role]) => role === 'router')
      .map(([, state]) => state);
    expect(routerStates.at(-1)).toBe('ready');
    await runtime.destroy();
  });

  it('degrades availability and rechecks after an eager-load connection failure', async () => {
    const worker = provider('worker');
    (worker.chat as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'))
      .mockResolvedValue('ok');
    const capability = vi.fn();
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: worker,
      vramManager: vram(),
      onCapability: capability,
      runtimeRecheckDelayMs: 5,
    });
    await runtime.init();

    await expect(runtime.generateWorkerText('question')).rejects.toThrow('ECONNREFUSED');
    expect(runtime.snapshot.roles.local_worker.availability).toBe('error');
    expect(capability).toHaveBeenCalledWith(
      'local_worker',
      'error',
      'connect ECONNREFUSED 127.0.0.1:11434',
    );
    await vi.waitFor(() => {
      expect(worker.isAvailable).toHaveBeenCalledTimes(2);
      expect(capability).toHaveBeenCalledWith('local_worker', 'ready', undefined);
    });
    expect(runtime.snapshot.roles.local_worker.availability).toBe('available');
    expect(runtime.snapshot.state).toBe('ready');
    await runtime.destroy();
  });

  it('restores the router immediately when worker inference fails', async () => {
    const worker = provider('worker');
    (worker.chat as ReturnType<typeof vi.fn>).mockImplementation(async (
      _messages: ChatMessage[],
      _onChunk: (text: string) => void,
      options?: ChatOptions,
    ) => {
      if (options?.num_predict === 1) return 'ok';
      throw new Error('worker failed');
    });
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: worker,
      vramManager: vram(),
    });
    await runtime.init();

    await expect(runtime.generateWorkerText('question')).rejects.toThrow('worker failed');

    expect(runtime.snapshot.activeRole).toBe('router');
    expect(runtime.snapshot.roles.router.residency).toBe('loaded');
    expect(runtime.snapshot.roles.local_worker.residency).toBe('unloaded');
  });

  it('marks a blocked idle router restore unavailable and recovers it through recheck', async () => {
    vi.useFakeTimers();
    try {
      const memory = vram();
      (memory.unloadModel as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      const capability = vi.fn();
      const runtime = new ModelRuntime({
        config,
        routerProvider: provider('router'),
        workerProvider: provider('worker'),
        vramManager: memory,
        onCapability: capability,
        idleTimeoutMs: 5,
        runtimeRecheckDelayMs: 5,
      });
      await runtime.init();

      await runtime.generateWorkerText('question');
      expect(runtime.snapshot.activeRole).toBe('local_worker');

      await vi.advanceTimersByTimeAsync(5);
      await vi.waitFor(() => {
        expect(runtime.snapshot.roles.router.availability).toBe('error');
      });
      expect(capability).toHaveBeenCalledWith(
        'router',
        'error',
        expect.stringContaining('worker:9b'),
      );

      await vi.advanceTimersByTimeAsync(5);
      await vi.waitFor(() => {
        expect(runtime.snapshot.activeRole).toBe('router');
        expect(runtime.snapshot.roles.router.residency).toBe('loaded');
        expect(runtime.snapshot.roles.router.availability).toBe('available');
      });
      expect(capability).toHaveBeenLastCalledWith('router', 'ready');
      await runtime.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to load the next role and restores the current role when it cannot be unloaded', async () => {
    const worker = provider('worker');
    const memory = vram();
    (memory.unloadModel as ReturnType<typeof vi.fn>).mockImplementation(async (model: string) => (
      model !== 'router:1b'
    ));
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: worker,
      vramManager: memory,
    });
    await runtime.init();

    await expect(runtime.generateWorkerText('question')).rejects.toThrow(/could not be unloaded/);

    expect(worker.chat).not.toHaveBeenCalled();
    expect(runtime.snapshot.activeRole).toBe('router');
    expect(runtime.snapshot.roles.router.residency).toBe('loaded');
    expect(runtime.snapshot.roles.local_worker.residency).toBe('unloaded');
  });

  it('reports the router honestly when rollback after a worker failure also fails', async () => {
    const worker = provider('worker');
    (worker.chat as ReturnType<typeof vi.fn>).mockImplementation(async (
      _messages: ChatMessage[],
      _onChunk: (text: string) => void,
      options?: ChatOptions,
    ) => {
      if (options?.num_predict === 1) return 'ok';
      throw new Error('worker failed');
    });
    const memory = vram();
    (memory.unloadModel as ReturnType<typeof vi.fn>).mockImplementation(async (model: string) => (
      model !== 'worker:9b'
    ));
    const capability = vi.fn();
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: worker,
      vramManager: memory,
      onCapability: capability,
    });
    await runtime.init();

    await expect(runtime.generateWorkerText('question')).rejects.toThrow(
      /Worker operation and router restore failed/,
    );

    expect(runtime.snapshot.roles.router.residency).toBe('error');
    expect(capability).toHaveBeenCalledWith(
      'router',
      'error',
      expect.stringContaining('Router restore failed'),
    );
  });

  it('aborts an active provider request before unloading models on shutdown', async () => {
    let operationSignal: AbortSignal | undefined;
    const worker = provider('worker');
    (worker.chat as ReturnType<typeof vi.fn>).mockImplementation(async (
      _messages: ChatMessage[],
      _onChunk: (text: string) => void,
      options?: ChatOptions,
    ) => {
      if (options?.num_predict === 1) return 'ok';
      operationSignal = options?.signal;
      return new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
      });
    });
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: worker,
      vramManager: vram(),
    });
    await runtime.init();

    const running = runtime.generateWorkerText('long request');
    await vi.waitFor(() => expect(operationSignal).toBeDefined());
    await runtime.destroy();

    expect(operationSignal?.aborted).toBe(true);
    await expect(running).rejects.toThrow();
    expect(runtime.snapshot.state).toBe('stopped');
  });

  it('cleans up a cancelled worker load and restores the router', async () => {
    let workerLoadStarted = false;
    const memory = vram();
    (memory.waitForModel as ReturnType<typeof vi.fn>).mockImplementation(async (
      _model: string,
      _attempts?: number,
      _intervalMs?: number,
      signal?: AbortSignal,
    ) => {
      if (!workerLoadStarted) {
        workerLoadStarted = true;
        return true;
      }
      if ((memory.waitForModel as ReturnType<typeof vi.fn>).mock.calls.length === 2) {
        return new Promise<boolean>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return true;
    });
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: provider('worker'),
      vramManager: memory,
    });
    await runtime.init();
    const controller = new AbortController();

    const running = runtime.generateWorkerText('question', { signal: controller.signal });
    await vi.waitFor(() => expect(memory.waitForModel).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(running).rejects.toThrow();
    expect(memory.unloadModel).toHaveBeenCalledWith('worker:9b', expect.any(AbortSignal));
    expect(runtime.snapshot.activeRole).toBe('router');
    expect(runtime.snapshot.roles.router.residency).toBe('loaded');
    expect(runtime.snapshot.roles.local_worker.residency).toBe('unloaded');
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

    expect(memory.unloadModel).toHaveBeenCalledWith('router:1b', expect.any(AbortSignal));
    expect(memory.unloadModel).toHaveBeenCalledWith('worker:9b', expect.any(AbortSignal));
    expect(memory.unloadModel).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot.state).toBe('stopped');
  });

  it('finishes shutdown honestly when Ollama model cleanup hangs', async () => {
    const memory = vram();
    (memory.unloadModel as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Promise<boolean>(() => {}),
    );
    const runtime = new ModelRuntime({
      config,
      routerProvider: provider('router'),
      workerProvider: provider('worker'),
      vramManager: memory,
      cleanupTimeoutMs: 5,
    });
    await runtime.init();

    await expect(runtime.destroy()).rejects.toThrow('Model cleanup failed');

    expect(runtime.snapshot.state).toBe('stopped');
    expect(runtime.snapshot.activeRole).toBeNull();
    expect(runtime.snapshot.roles.router.residency).toBe('error');
    expect(runtime.snapshot.roles.local_worker.residency).toBe('error');
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

    await expect(running).rejects.toThrow(/aborted|stale/i);
    expect(runtime.snapshot.state).toBe('stopped');
    expect(runtime.snapshot.activeRole).toBeNull();
    expect(runtime.snapshot.roles.local_worker.residency).toBe('unloaded');
  });
});
