import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { FasterWhisperProvider } from '../../../src/services/voice/providers/faster-whisper-provider.js';

describe('FasterWhisperProvider shutdown', () => {
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
});
