import type { LlmProvider, ChatMessage, ChatOptions } from './llm-provider.interface.js';

export const STREAM_TIMEOUT_MS = 120_000;

async function attempt(
  provider: LlmProvider,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options: ChatOptions | undefined,
  onFirstChunk: () => void,
): Promise<string> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout>;
  let rejectTimeout: (err: Error) => void;

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, STREAM_TIMEOUT_MS);
  });

  const guardedChunk = (chunk: string) => {
    // Chunks from an attempt that already timed out must never reach the user.
    if (controller.signal.aborted) return;
    onFirstChunk();
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      controller.abort();
      rejectTimeout(new Error('timeout'));
    }, STREAM_TIMEOUT_MS);
    onChunk(chunk);
  };

  try {
    return await Promise.race([
      provider.chat(messages, guardedChunk, { ...options, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

export async function chatWithTimeout(
  provider: LlmProvider,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options?: ChatOptions,
): Promise<string> {
  let streamedToUser = false;
  const markStreamed = () => {
    streamedToUser = true;
  };
  try {
    return await attempt(provider, messages, onChunk, options, markStreamed);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'timeout';
    // Retry exactly once, and only if the user has not seen partial output —
    // the first attempt is aborted, its late chunks are ignored.
    if (!isTimeout || streamedToUser) throw err;
    return attempt(provider, messages, onChunk, options, markStreamed);
  }
}
