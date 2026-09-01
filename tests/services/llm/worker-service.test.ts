import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, LlmProvider } from '../../../src/services/llm/llm-provider.interface.js';
import { WorkerService } from '../../../src/services/llm/worker-service.js';

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

  it('forwards an explicit effective response cap instead of the style default', async () => {
    const provider = providerReturning('Antwort');
    const worker = new WorkerService(provider);

    await worker.stream(messages, 'ausführlich', () => {}, undefined, 640);

    expect(provider.chat).toHaveBeenCalledWith(
      messages,
      expect.any(Function),
      expect.objectContaining({ num_predict: 640 }),
    );
  });
});
