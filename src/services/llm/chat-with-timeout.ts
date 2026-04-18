import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';

export const STREAM_TIMEOUT_MS = 120_000;

export async function chatWithTimeout(
  provider: LlmProvider,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  options?: { num_predict?: number },
): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout>;
  let rejectTimeout: (err: Error) => void;

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    timeoutId = setTimeout(() => reject(new Error('timeout')), STREAM_TIMEOUT_MS);
  });

  const chatPromise = provider.chat(messages, (chunk) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => rejectTimeout(new Error('timeout')), STREAM_TIMEOUT_MS);
    onChunk(chunk);
  }, options);

  const result = await Promise.race([chatPromise, timeoutPromise]);
  clearTimeout(timeoutId!);
  return result;
}
