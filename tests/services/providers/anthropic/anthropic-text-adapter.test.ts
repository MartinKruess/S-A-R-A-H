import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicTextAdapter, createAnthropicClient } from '../../../../src/services/providers/anthropic/anthropic-text-adapter.js';
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const start = { type: 'message_start', message: { role: 'assistant', usage: {
  input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 1 } } };
const blockStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const delta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer' } };
const blockStop = { type: 'content_block_stop', index: 0 };
const messageDelta = { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } };
const stop = { type: 'message_stop' };
const request = { text: 'Current user text', model: 'claude-sonnet-5', maxOutputTokens: 100 };
const context = () => ({ resolveCredential: () => 'test-key', onDelta: vi.fn() });
function fixture(events: readonly object[]) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(events.map((event) => {
    const type = Reflect.get(event, 'type');
    return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join(''), { headers: { 'content-type': 'text/event-stream' } }));
  const adapter = new AnthropicTextAdapter((apiKey) => new Anthropic({ apiKey, fetch: fetcher, maxRetries: 0 }));
  return { adapter, fetcher };
}
describe('Anthropic text adapter', () => {
  it('sends only current text and preserves cumulative inclusive/cache usage', async () => {
    const { adapter, fetcher } = fixture([start, blockStart, delta, blockStop,
      { ...messageDelta, usage: { output_tokens: 3 } }, messageDelta, stop]);
    const ctx = context();
    expect(await adapter.generate(request, ctx)).toEqual({ fullText: 'Answer', status: 'completed',
      usage: { inputTokens: 16, cachedInputTokens: 4, cacheWriteInputTokens: 2, outputTokens: 5, toolCalls: 0 } });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ model: 'claude-sonnet-5', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: request.text }] });
    expect(ctx.onDelta).toHaveBeenCalledWith('Answer');
  });
  it('reports max-token stops as incomplete even with message_stop', async () => {
    const { adapter } = fixture([start, blockStart, delta, blockStop, { ...messageDelta, delta: { stop_reason: 'max_tokens' } }, stop]);
    expect(await adapter.generate(request, context())).toMatchObject({ status: 'incomplete', fullText: 'Answer' });
  });
  it('preserves partial text and known usage when stream errors occur without retries', async () => {
    const { adapter, fetcher } = fixture([start, blockStart, delta, { type: 'error', error: { type: 'overloaded_error', message: 'secret provider content' } }]);
    await expect(adapter.generate(request, context())).rejects.toMatchObject({ message: 'provider_generation_failed',
      partial: { fullText: 'Answer', usage: { inputTokens: 16, outputTokens: 1 } } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not treat additive events or missing stop reason as completion', async () => {
    for (const events of [[start, { type: 'future_event' }], [start, stop], [start, blockStart, delta, stop]]) {
      await expect(fixture(events).adapter.generate(request, context())).rejects.toThrow('provider_generation_failed');
    }
  });
  it('ignores additive events while requiring a genuine terminal sequence', async () => {
    const { adapter } = fixture([start, { type: 'future_event' }, blockStart, delta, blockStop, messageDelta, stop]);
    expect(await adapter.generate(request, context())).toMatchObject({ status: 'completed' });
  });
  it('does not invent cache or reasoning breakdowns but preserves reported reasoning', async () => {
    const bareStart = { ...start, message: { role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } } };
    const { adapter } = fixture([bareStart, { ...messageDelta, usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: 2 } } }, stop]);
    expect((await adapter.generate(request, context())).usage).toEqual({ inputTokens: 2, outputTokens: 5, reasoningTokens: 2, toolCalls: 0 });
  });
  it('rejects unrequested tool blocks and invalid input before dispatch', async () => {
    const { adapter } = fixture([start, { ...blockStart, content_block: { type: 'tool_use', name: 'shell' } }]);
    await expect(adapter.generate(request, context())).rejects.toThrow('provider_generation_failed');
    const factory = vi.fn();
    await expect(new AnthropicTextAdapter(factory).generate(request, { ...context(), resolveCredential: () => null })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it('aborts without dispatch when caller signal is already aborted', async () => {
    const { adapter, fetcher } = fixture([]);
    const controller = new AbortController(); controller.abort();
    await expect(adapter.generate({ ...request, signal: controller.signal }, context())).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('isolates auth, custom headers and SDK debug logging from host environment', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'host-subscription-secret');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'authorization: Bearer other-secret\nx-api-key: wrong-key\nanthropic-workspace-id: wrong-workspace\nx-secret: host-secret');
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [], has_more: false }));
    const client = createAnthropicClient('selected-key', { fetchImpl: fetcher, timeoutMs: 8000 });
    expect(client.logLevel).toBe('off');
    expect(client.authToken).toBeNull();
    await client.models.list();
    expect(Object.fromEntries(new Headers(fetcher.mock.calls[0][1]?.headers))).toEqual({
      'x-api-key': 'selected-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'application/json',
    });
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('ends a stalled SSE body at the overall deadline and preserves partial output', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) {
      for (const event of [start, blockStart, delta]) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      // Intentionally never close and ignore fetch abort: deadline must bound reader wait.
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    const adapter = new AnthropicTextAdapter((key) => createAnthropicClient(key, { fetchImpl: fetcher }), 20);
    const result = adapter.generate(request, context());
    const assertion = expect(result).rejects.toMatchObject({ partial: { fullText: 'Answer', usage: { inputTokens: 16 } } });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
