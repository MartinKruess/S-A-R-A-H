import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, LlmProvider } from './llm-provider.interface.js';
import { WorkerService } from './worker-service.js';

function providerReturning(response: string): LlmProvider {
  return {
    id: 'worker-test',
    isAvailable: vi.fn().mockResolvedValue(true),
    chat: vi.fn().mockResolvedValue(response),
  };
}

describe('WorkerService', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'Antworte bitte.' }];

  it('returns a non-empty terminal response', async () => {
    const worker = new WorkerService(providerReturning('Antwort'));

    await expect(worker.stream(messages, 'kurz', () => {})).resolves.toMatchObject({
      fullText: 'Antwort',
    });
  });

  it('rejects an empty terminal response before it can complete a turn', async () => {
    const worker = new WorkerService(providerReturning(' \n\t '));

    await expect(worker.stream(messages, 'kurz', () => {})).rejects.toThrow(
      'Worker returned an empty response',
    );
  });
});
