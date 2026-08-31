import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from './providers/ollama-provider.js';
import {
  ROUTER_DEADLINE_MS,
  ROUTER_NUM_CTX,
  ROUTER_NUM_PREDICT,
  RoutingService,
} from './routing-service.js';

describe('RoutingService productive request contract', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends the tag-only output cap through the real Ollama options path', async () => {
    let requestBody: Record<string, object | string | boolean> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      const frame = `${JSON.stringify({ message: { content: '[ROUTE:9b]' }, done: true })}\n`;
      return new Response(frame, { status: 200 });
    }));
    const routing = new RoutingService(new OllamaProvider(
      'http://localhost:11434',
      'phi4-mini:3.8b',
      { num_predict: 12_000, temperature: 0.9, num_ctx: ROUTER_NUM_CTX },
    ));

    const result = await routing.route('Erkläre mir, warum der Himmel blau ist.');

    expect(result).toMatchObject({ parsed: { kind: 'route', route: '9b' }, hadTag: true });
    expect(requestBody).toMatchObject({
      model: 'phi4-mini:3.8b',
      stream: true,
      think: false,
      keep_alive: -1,
      options: {
        num_predict: ROUTER_NUM_PREDICT,
        temperature: 0,
        num_ctx: ROUTER_NUM_CTX,
      },
    });
  });

  it('fits the complete routing prompt plus the maximum accepted user message', async () => {
    let requestBody: { messages?: Array<{ role: string; content: string }>; options?: { num_ctx?: number } } = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      const frame = `${JSON.stringify({ message: { content: '[ROUTE:9b]' }, done: true })}\n`;
      return new Response(frame, { status: 200 });
    }));
    const routing = new RoutingService(new OllamaProvider(
      'http://localhost:11434',
      'phi4-mini:3.8b',
      { num_ctx: ROUTER_NUM_CTX },
    ));
    const userText = 'x'.repeat(4_000);

    await expect(routing.route(userText)).resolves.toMatchObject({
      parsed: { kind: 'route', route: '9b' },
    });

    expect(requestBody.messages?.at(-1)).toEqual({ role: 'user', content: userText });
    expect(requestBody.options?.num_ctx).toBe(ROUTER_NUM_CTX);
  });

  it('aborts a streaming router classification at its hard total deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const routing = new RoutingService(
      new OllamaProvider('http://localhost:11434', 'phi4-mini:3.8b'),
    );
    const result = routing.route('Erkläre den Himmel.');
    const rejection = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(ROUTER_DEADLINE_MS);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
