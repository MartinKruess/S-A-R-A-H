import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OllamaContainerManager,
  type ContainerManagerOptions,
} from '../../../src/services/llm/ollama-container-manager';

const BASE_URL = 'http://localhost:11434';
const COMPOSE_PATH = 'G:\\fake\\docker-compose.yml';

type ExecCall = { cmd: string; args: string[] };

function enoentError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('spawn docker ENOENT');
  err.code = 'ENOENT';
  return err;
}

function execError(stderr: string): Error & { stderr: string } {
  const err = new Error('docker exited 1') as Error & { stderr: string };
  err.stderr = stderr;
  return err;
}

function createManager(
  options: Partial<ContainerManagerOptions> & {
    execResults?: Array<{ stdout: string } | Error>;
  } = {},
): { manager: OllamaContainerManager; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const results = [...(options.execResults ?? [])];
  const manager = new OllamaContainerManager(BASE_URL, COMPOSE_PATH, {
    execFn: async (cmd, args) => {
      calls.push({ cmd, args });
      const next = results.shift();
      if (next === undefined) return { stdout: '', stderr: '' };
      if (next instanceof Error) throw next;
      return { stdout: next.stdout, stderr: '' };
    },
    existsFn: options.existsFn ?? (() => false),
    healthTimeoutMs: options.healthTimeoutMs ?? 50,
    healthPollMs: options.healthPollMs ?? 1,
    gpuRetryDelayMs: options.gpuRetryDelayMs ?? 1,
  });
  return { manager, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OllamaContainerManager.getStatus', () => {
  it('reports running container', async () => {
    const { manager, calls } = createManager({ execResults: [{ stdout: 'true\n' }] });
    expect(await manager.getStatus()).toEqual({ docker: 'ok', container: 'running' });
    expect(calls[0]).toEqual({
      cmd: 'docker',
      args: ['inspect', '--format', '{{.State.Running}}', 'sarah-ollama'],
    });
  });

  it('reports stopped container', async () => {
    const { manager } = createManager({ execResults: [{ stdout: 'false\n' }] });
    expect(await manager.getStatus()).toEqual({ docker: 'ok', container: 'stopped' });
  });

  it('reports missing container when inspect says no such object', async () => {
    const { manager } = createManager({
      execResults: [execError('Error: No such object: sarah-ollama')],
    });
    expect(await manager.getStatus()).toEqual({ docker: 'ok', container: 'missing' });
  });

  it('distinguishes docker-not-installed via ENOENT + missing install path', async () => {
    const { manager } = createManager({
      execResults: [enoentError()],
      existsFn: () => false,
    });
    expect(await manager.getStatus()).toEqual({ docker: 'not-installed', container: 'unknown' });
  });

  it('distinguishes docker-not-on-path via ENOENT + existing install path', async () => {
    const { manager } = createManager({
      execResults: [enoentError()],
      existsFn: () => true,
    });
    expect(await manager.getStatus()).toEqual({ docker: 'not-on-path', container: 'unknown' });
  });

  it('reports docker daemon not running on other CLI errors', async () => {
    const { manager } = createManager({
      execResults: [execError('error during connect: the docker daemon is not running')],
    });
    expect(await manager.getStatus()).toEqual({ docker: 'not-running', container: 'unknown' });
  });
});

describe('OllamaContainerManager.ensureRunning', () => {
  function mockHealthyApi(): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"models":[]}', { status: 200 }),
    );
  }

  it('resolves without docker start when container already runs', async () => {
    mockHealthyApi();
    const { manager, calls } = createManager({ execResults: [{ stdout: 'true\n' }] });
    await manager.ensureRunning();
    expect(calls).toHaveLength(1); // inspect only
  });

  it('starts a stopped container and waits for the API', async () => {
    mockHealthyApi();
    const { manager, calls } = createManager({
      execResults: [{ stdout: 'false\n' }, { stdout: '' }],
    });
    await manager.ensureRunning();
    expect(calls[1]).toEqual({ cmd: 'docker', args: ['start', 'sarah-ollama'] });
  });

  it('creates a missing container via docker compose up', async () => {
    mockHealthyApi();
    const { manager, calls } = createManager({
      execResults: [execError('Error: No such object: sarah-ollama'), { stdout: '' }],
    });
    await manager.ensureRunning();
    expect(calls[1]).toEqual({
      cmd: 'docker',
      args: ['compose', '-f', COMPOSE_PATH, 'up', '-d'],
    });
  });

  it('throws a German message when docker is not installed', async () => {
    const { manager } = createManager({ execResults: [enoentError()], existsFn: () => false });
    await expect(manager.ensureRunning()).rejects.toThrow(/Docker Desktop ist nicht installiert/);
  });

  it('throws a German message when docker is installed but not on PATH', async () => {
    const { manager } = createManager({ execResults: [enoentError()], existsFn: () => true });
    await expect(manager.ensureRunning()).rejects.toThrow(/nicht im PATH/);
  });

  it('throws a timeout error when the API never becomes healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const { manager } = createManager({
      execResults: [{ stdout: 'false\n' }, { stdout: '' }],
      healthTimeoutMs: 10,
      healthPollMs: 1,
    });
    await expect(manager.ensureRunning()).rejects.toThrow(/antwortet nicht/);
  });

  it('wraps docker start failures in a German message with the original output', async () => {
    const { manager } = createManager({
      execResults: [{ stdout: 'false\n' }, execError('Bind for 127.0.0.1:11434 failed: port is already allocated')],
    });
    await expect(manager.ensureRunning()).rejects.toThrow(
      /Ollama-Container konnte nicht gestartet werden: .*port is already allocated/,
    );
  });
});

describe('OllamaContainerManager.checkGpu', () => {
  function psResponse(sizeVram: number): Response {
    return new Response(
      JSON.stringify({ models: [{ model: 'phi4-mini:3.8b', size_vram: sizeVram }] }),
      { status: 200 },
    );
  }

  it('returns gpu when a loaded model resides in VRAM', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(psResponse(2_000_000_000));
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('gpu');
  });

  it('returns cpu only after the retry also reports zero VRAM', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(psResponse(0)),
    );
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('cpu');
    expect(spy).toHaveBeenCalledTimes(2); // first read + one retry
  });

  it('returns gpu when the retry sees the model arrive in VRAM (no false alarm)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(psResponse(0))
      .mockResolvedValueOnce(psResponse(2_000_000_000));
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('gpu');
  });

  it('returns unknown when no model is loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"models":[]}', { status: 200 }),
    );
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('unknown');
  });

  it('returns unknown when the API is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('unknown');
  });

  it('returns unknown when the API responds non-ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('error', { status: 500 })),
    );
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('unknown');
  });

  it('returns unknown when models is not an array', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('{"models":null}', { status: 200 })),
    );
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('unknown');
  });
});
