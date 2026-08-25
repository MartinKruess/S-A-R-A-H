import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatWithTimeout, STREAM_TIMEOUT_MS } from '../../../src/services/llm/chat-with-timeout';
import type { LlmProvider, ChatMessage, ChatOptions } from '../../../src/services/llm/llm-provider.interface';

type ChatImpl = (msgs: ChatMessage[], onChunk: (t: string) => void, options?: ChatOptions) => Promise<string>;

function providerWith(chatImpl: ChatImpl): LlmProvider & { chat: ReturnType<typeof vi.fn> } {
  return {
    id: 'fake',
    isAvailable: vi.fn().mockResolvedValue(true),
    chat: vi.fn(chatImpl),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('chatWithTimeout abort + retry', () => {
  it('aborts the first attempt on timeout and retries exactly once', async () => {
    vi.useFakeTimers();
    let firstSignal: AbortSignal | undefined;
    const provider = providerWith(async (_m, _cb, opts) => {
      if (!firstSignal) {
        firstSignal = opts?.signal;
        return new Promise<string>(() => {}); // hangs forever, never streams
      }
      return 'second attempt result';
    });

    const resultP = chatWithTimeout(provider, [], () => {});
    await vi.advanceTimersByTimeAsync(STREAM_TIMEOUT_MS + 1);
    await expect(resultP).resolves.toBe('second attempt result');
    expect(firstSignal?.aborted).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it('does not retry when chunks were already streamed', async () => {
    vi.useFakeTimers();
    const provider = providerWith(async (_m, cb) => {
      cb('partial ');
      return new Promise<string>(() => {}); // hangs after first chunk
    });

    const resultP = chatWithTimeout(provider, [], () => {});
    resultP.catch(() => {}); // assertion below consumes the rejection
    await vi.advanceTimersByTimeAsync(STREAM_TIMEOUT_MS + 1);
    await expect(resultP).rejects.toThrow('timeout');
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('ignores late chunks from the aborted first attempt', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    let lateCb: ((t: string) => void) | null = null;
    let calls = 0;
    const provider = providerWith(async (_m, cb) => {
      calls++;
      if (calls === 1) {
        lateCb = cb;
        return new Promise<string>(() => {});
      }
      cb('fresh');
      return 'fresh';
    });

    const resultP = chatWithTimeout(provider, [], (t) => seen.push(t));
    await vi.advanceTimersByTimeAsync(STREAM_TIMEOUT_MS + 1);
    lateCb!('stale'); // late chunk from the aborted attempt
    await expect(resultP).resolves.toBe('fresh');
    expect(seen).toEqual(['fresh']);
  });

  it('does not retry on connection errors', async () => {
    const provider = providerWith(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(chatWithTimeout(provider, [], () => {})).rejects.toThrow('ECONNREFUSED');
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('propagates an external lifecycle abort and does not retry', async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const provider = providerWith(async (_messages, _onChunk, options) => {
      providerSignal = options?.signal;
      return new Promise<string>(() => {});
    });

    const running = chatWithTimeout(provider, [], () => {}, { signal: controller.signal });
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal?.aborted).toBe(true);
    expect(provider.chat).toHaveBeenCalledOnce();
  });
});
