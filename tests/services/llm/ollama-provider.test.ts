import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from '../../../src/services/llm/providers/ollama-provider';

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider('http://localhost:11434', 'mistral-nemo');
  });

  it('has id "ollama"', () => {
    expect(provider.id).toBe('ollama');
  });

  it('isAvailable returns false when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await provider.isAvailable();
    expect(result).toBe(false);
    vi.restoreAllMocks();
  });

  it('isAvailable returns false when model not in list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3:latest' }] }),
    } as Response);
    const result = await provider.isAvailable();
    expect(result).toBe(false);
    vi.restoreAllMocks();
  });

  it('isAvailable returns true when model found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'mistral-nemo:latest' }] }),
    } as Response);
    const result = await provider.isAvailable();
    expect(result).toBe(true);
    vi.restoreAllMocks();
  });

  it('chat streams chunks and returns full response', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      JSON.stringify({ message: { content: 'Hello' }, done: false }) + '\n',
      JSON.stringify({ message: { content: ' world' }, done: true }) + '\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      body: stream,
    } as Response);

    const received: string[] = [];
    const result = await provider.chat(
      [{ role: 'user', content: 'Hi' }],
      (text) => received.push(text),
    );

    expect(received).toEqual(['Hello', ' world']);
    expect(result).toBe('Hello world');
    vi.restoreAllMocks();
  });

  it('chat throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    await expect(
      provider.chat([{ role: 'user', content: 'Hi' }], () => {}),
    ).rejects.toThrow('Ollama error: 500 Internal Server Error');
    vi.restoreAllMocks();
  });
});
