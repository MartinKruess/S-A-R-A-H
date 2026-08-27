import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { FasterWhisperProvider } from '../../../src/services/voice/providers/faster-whisper-provider.js';

class MockWhisperProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  autoExitOnKill = true;
  kill = vi.fn(() => {
    if (this.autoExitOnKill && this.exitCode === null && this.signalCode === null) {
      this.signalCode = 'SIGTERM';
      this.emit('exit', null, 'SIGTERM');
    }
    return true;
  });

  crash(code = 1): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  exitBySignal(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.signalCode = signal;
    this.emit('exit', null, signal);
  }
}

function response(ok: boolean, text = '', status = ok ? 200 : 500): Response {
  return { ok, status, text: async () => text } as Response;
}

describe('FasterWhisperProvider runtime ownership', () => {
  const spawnMock = vi.mocked(spawn);

  beforeEach(() => {
    spawnMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('kills the process when its graceful shutdown endpoint hangs', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Promise<Response>(() => {}));
    const provider = new FasterWhisperProvider('C:/fake/resources');
    const process = { kill: vi.fn() } as unknown as ChildProcess;
    (provider as unknown as { serverProcess: ChildProcess | null }).serverProcess = process;

    const destroying = provider.destroy();
    await vi.advanceTimersByTimeAsync(1_500);
    await destroying;

    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('degrades after a ready server crashes and recovers through one controlled restart', async () => {
    vi.useFakeTimers();
    const first = new MockWhisperProcess();
    const second = new MockWhisperProcess();
    spawnMock
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/health')) return response(true);
      throw new Error('no previous server');
    });
    const provider = new FasterWhisperProvider('C:/fake/resources');
    const states: Array<{ available: boolean; message?: string }> = [];
    provider.onAvailabilityChange((state) => states.push(state));

    await provider.init();
    expect(states).toEqual([{ available: true }]);

    first.crash();
    expect(states.at(-1)).toMatchObject({ available: false });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toEqual({ available: true });
    await provider.destroy();
  });

  it('kills timed-out server work before a following transcription starts', async () => {
    vi.useFakeTimers();
    const first = new MockWhisperProcess();
    const second = new MockWhisperProcess();
    spawnMock
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);
    let transcriptionCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(response(true));
      if (url.includes('/transcribe')) {
        transcriptionCalls += 1;
        if (transcriptionCalls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
          });
        }
        return Promise.resolve(response(true, 'Hallo Martin'));
      }
      return Promise.reject(new Error('no previous server'));
    });
    const provider = new FasterWhisperProvider('C:/fake/resources');
    await provider.init();
    const controller = new AbortController();
    const timedOut = provider.transcribe(new Float32Array([0.2]), 16_000, 'de', controller.signal);
    for (let step = 0; step < 10 && transcriptionCalls === 0; step += 1) await Promise.resolve();
    expect(transcriptionCalls).toBe(1);
    const timeout = new Error('Speech recognition timed out');
    timeout.name = 'TimeoutError';
    controller.abort(timeout);

    await expect(timedOut).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(first.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(provider.transcribe(new Float32Array([0.2]), 16_000)).resolves.toBe('Hallo Martin');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await provider.destroy();
  });

  it('kills native work on F9 cancellation before a following transcription starts', async () => {
    vi.useFakeTimers();
    const first = new MockWhisperProcess();
    const second = new MockWhisperProcess();
    spawnMock
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);
    let transcriptionCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(response(true));
      if (url.includes('/transcribe')) {
        transcriptionCalls += 1;
        if (transcriptionCalls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
          });
        }
        return Promise.resolve(response(true, 'Folgeturn'));
      }
      return Promise.reject(new Error('no previous server'));
    });
    const provider = new FasterWhisperProvider('C:/fake/resources');
    const states: Array<{ available: boolean; message?: string }> = [];
    provider.onAvailabilityChange((state) => states.push(state));
    await provider.init();
    const controller = new AbortController();
    const canceled = provider.transcribe(new Float32Array([0.2]), 16_000, 'de', controller.signal);
    for (let step = 0; step < 10 && transcriptionCalls === 0; step += 1) await Promise.resolve();
    expect(transcriptionCalls).toBe(1);

    controller.abort();

    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.kill).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ available: false });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(provider.transcribe(new Float32Array([0.2]), 16_000)).resolves.toBe('Folgeturn');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await provider.destroy();
  });

  it('retries a transient failure during the very first startup', async () => {
    vi.useFakeTimers();
    const first = new MockWhisperProcess();
    const second = new MockWhisperProcess();
    spawnMock
      .mockImplementationOnce(() => {
        setTimeout(() => first.crash(), 0);
        return first as unknown as ChildProcess;
      })
      .mockReturnValueOnce(second as unknown as ChildProcess);
    let healthCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        healthCalls += 1;
        return healthCalls === 1
          ? new Promise<Response>(() => {})
          : Promise.resolve(response(true));
      }
      return Promise.reject(new Error('no previous server'));
    });
    const provider = new FasterWhisperProvider('C:/fake/resources');
    const states: Array<{ available: boolean; message?: string }> = [];
    provider.onAvailabilityChange((state) => states.push(state));

    const firstStart = provider.init();
    const firstStartFailed = expect(firstStart).rejects.toThrow(/before becoming ready/);
    await vi.advanceTimersByTimeAsync(0);
    await firstStartFailed;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ available: true }));

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await provider.destroy();
  });

  it('lets an F9 turn stop waiting without aborting a shared recovery startup', async () => {
    vi.useFakeTimers();
    const first = new MockWhisperProcess();
    const second = new MockWhisperProcess();
    spawnMock
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);
    let healthCalls = 0;
    let resolveRecoveryHealth!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        healthCalls += 1;
        if (healthCalls === 1) return Promise.resolve(response(true));
        return new Promise<Response>((resolve) => { resolveRecoveryHealth = resolve; });
      }
      return Promise.reject(new Error('no previous server'));
    });
    const provider = new FasterWhisperProvider('C:/fake/resources');
    await provider.init();
    first.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    const canceled = provider.transcribe(new Float32Array([0.2]), 16_000, 'de', controller.signal);
    controller.abort();

    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    expect(second.kill).not.toHaveBeenCalled();
    resolveRecoveryHealth(response(true));
    await provider.init();
    expect(second.kill).not.toHaveBeenCalled();
    await provider.destroy();
  });

  it('ignores a late exit from a retired child after its replacement is ready', async () => {
    vi.useFakeTimers();
    const first = new MockWhisperProcess();
    first.autoExitOnKill = false;
    const second = new MockWhisperProcess();
    spawnMock
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);
    let transcriptionCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(response(true));
      if (url.includes('/transcribe')) {
        transcriptionCalls += 1;
        if (transcriptionCalls === 1) return Promise.reject(new Error('socket closed'));
        return Promise.resolve(response(true, 'Ersatz lebt'));
      }
      return Promise.reject(new Error('no previous server'));
    });
    const provider = new FasterWhisperProvider('C:/fake/resources');
    const states: Array<{ available: boolean; message?: string }> = [];
    provider.onAvailabilityChange((state) => states.push(state));
    await provider.init();

    const failed = provider.transcribe(new Float32Array([0.2]), 16_000);
    const failedAssertion = expect(failed).rejects.toThrow('socket closed');
    await vi.advanceTimersByTimeAsync(1_000);
    await failedAssertion;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states.at(-1)).toEqual({ available: true });

    first.exitBySignal();

    expect(states.at(-1)).toEqual({ available: true });
    await expect(provider.transcribe(new Float32Array([0.2]), 16_000)).resolves.toBe('Ersatz lebt');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await provider.destroy();
  });

  it('recycles the runtime after a server-side inference failure', async () => {
    vi.useFakeTimers();
    const first = new MockWhisperProcess();
    const second = new MockWhisperProcess();
    spawnMock
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);
    let transcriptionCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(response(true));
      if (url.includes('/transcribe')) {
        transcriptionCalls += 1;
        if (transcriptionCalls === 1) return Promise.resolve(response(false, 'CUDA failure', 500));
        return Promise.resolve(response(true, 'Wieder bereit'));
      }
      return Promise.reject(new Error('no previous server'));
    });
    const provider = new FasterWhisperProvider('C:/fake/resources');
    const states: Array<{ available: boolean; message?: string }> = [];
    provider.onAvailabilityChange((state) => states.push(state));
    await provider.init();

    await expect(provider.transcribe(new Float32Array([0.2]), 16_000)).rejects.toThrow('CUDA failure');
    expect(first.kill).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ available: false });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(states.at(-1)).toEqual({ available: true });
    await expect(provider.transcribe(new Float32Array([0.2]), 16_000)).resolves.toBe('Wieder bereit');
    await provider.destroy();
  });

  it('keeps the runtime for a request-specific client error', async () => {
    const process = new MockWhisperProcess();
    spawnMock.mockReturnValue(process as unknown as ChildProcess);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(response(true));
      if (url.includes('/transcribe')) return Promise.resolve(response(false, 'bad request', 400));
      return Promise.reject(new Error('no previous server'));
    });
    const provider = new FasterWhisperProvider('C:/fake/resources');
    await provider.init();

    await expect(provider.transcribe(new Float32Array([0.2]), 16_000)).rejects.toThrow('bad request');
    expect(process.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledOnce();
    await provider.destroy();
  });

  it('bounds a hanging previous-runtime shutdown probe during initialization', async () => {
    vi.useFakeTimers();
    const process = new MockWhisperProcess();
    spawnMock.mockReturnValue(process as unknown as ChildProcess);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/shutdown')) return new Promise<Response>(() => {});
      if (url.endsWith('/health')) return Promise.resolve(response(true));
      return Promise.reject(new Error('unexpected request'));
    });
    const provider = new FasterWhisperProvider('C:/fake/resources');

    const initializing = provider.init();
    await vi.advanceTimersByTimeAsync(2_500);

    await expect(initializing).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledOnce();
    const destroying = provider.destroy();
    await vi.advanceTimersByTimeAsync(1_500);
    await destroying;
  });

  it('enforces the total startup deadline even when each health request hangs', async () => {
    vi.useFakeTimers();
    const process = new MockWhisperProcess();
    spawnMock.mockReturnValue(process as unknown as ChildProcess);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/shutdown')) return Promise.reject(new Error('no previous server'));
      if (url.endsWith('/health')) return new Promise<Response>(() => {});
      return Promise.reject(new Error('unexpected request'));
    });
    const provider = new FasterWhisperProvider('C:/fake/resources');

    const initializing = provider.init();
    const timeoutAssertion = expect(initializing).rejects.toThrow(/did not start within 300s/);
    await vi.advanceTimersByTimeAsync(300_500);

    await timeoutAssertion;
    expect(process.kill).toHaveBeenCalledOnce();
    await provider.destroy();
  });
});
