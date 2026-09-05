import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { OpenAiTextAdapter } from '../../../../src/services/providers/openai/openai-text-adapter.js';
import { OpenAiResearchAdapter } from '../../../../src/services/providers/openai/openai-research-adapter.js';
import type { AcceptedSpecialistTaskMetadata, SpecialistTaskRequest } from '../../../../src/core/specialist-task.js';

const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 14 };
function response(status = 'completed') {
  return { id: 'resp_test', status, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer',
    annotations: [{ type: 'url_citation', url: 'https://example.com/source', title: 'Source' },
      { type: 'url_citation', url: 'javascript:alert(1)', title: 'Unsafe' }] }] }], usage };
}
function client(fetcher: typeof fetch) { return new OpenAI({ apiKey: 'test-key', maxRetries: 0, fetch: fetcher }); }
const request = { taskId: 'test', providerId: 'openai', operationId: 'openai_deep_research', role: 'research',
  modelId: 'o3-deep-research', backgroundConsent: true, goal: 'Research topic', accessMode: 'none',
  dataEgress: ['goal'], budget: { maxOutputTokens: 500, maxToolCalls: 3 } } as SpecialistTaskRequest;
const task = { remoteRef: 'resp_test', status: 'running' } as AcceptedSpecialistTaskMetadata;
afterEach(() => vi.useRealTimers());

describe('OpenAI text adapter', () => {
  it('streams current text with no storage or tools and normalizes usage', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new globalThis.Response([
      { type: 'response.output_text.delta', delta: 'Answer' },
      { type: 'response.completed', response: response() },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
    const onDelta = vi.fn();
    const result = await new OpenAiTextAdapter(() => client(fetcher)).generate({ text: 'Hello', model: 'gpt-4.1-mini', maxOutputTokens: 100 },
      { resolveCredential: () => 'test', onDelta });
    expect(result).toMatchObject({ fullText: 'Answer', status: 'completed', usage: { inputTokens: 10, cachedInputTokens: 3 } });
    expect(onDelta).toHaveBeenCalledWith('Answer');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ model: 'gpt-4.1-mini', input: 'Hello', store: false, stream: true, max_output_tokens: 100 });
  });

  it('reports partial output and never retries broken streams', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new globalThis.Response('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } }));
    await expect(new OpenAiTextAdapter(() => client(fetcher)).generate({ text: 'Hello', model: 'x', maxOutputTokens: 100 },
      { resolveCredential: () => 'test', onDelta: vi.fn() })).rejects.toMatchObject({ message: 'provider_generation_failed', partial: { fullText: 'Partial' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects absent credentials before dispatch', async () => {
    const factory = vi.fn();
    await expect(new OpenAiTextAdapter(factory).generate({ text: 'Hello', model: 'x', maxOutputTokens: 100 },
      { resolveCredential: () => null, onDelta: vi.fn() })).rejects.toThrow('provider_generation_failed');
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('OpenAI research adapter', () => {
  it.each(['failed', 'cancelled', 'incomplete'])('retains measured usage for %s research', async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => globalThis.Response.json(response(status)));
    const adapter = new OpenAiResearchAdapter(() => client(fetcher));
    const context = { resolveCredential: () => 'test', emit: vi.fn(), publishResult: vi.fn() };
    await adapter.start(request, context);
    await adapter.activate(task, context);
    expect(context.emit).toHaveBeenLastCalledWith(expect.objectContaining({
      type: status === 'cancelled' ? 'canceled' : status,
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 4 }),
    }));
  });

  it('waits for activation before publishing immediate completion and strips unsafe citations', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => globalThis.Response.json(response()));
    const adapter = new OpenAiResearchAdapter(() => client(fetcher));
    const context = { resolveCredential: () => 'test', emit: vi.fn(), publishResult: vi.fn() };
    expect(await adapter.start(request, context)).toEqual({ remoteRef: 'resp_test', status: 'running' });
    expect(context.emit).not.toHaveBeenCalled();
    expect(context.publishResult).not.toHaveBeenCalled();
    await adapter.activate(task, context);
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed' }));
    expect(context.publishResult).toHaveBeenCalledWith({ text: 'Answer', citations: [{ url: 'https://example.com/source', title: 'Source' }] });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ background: true, store: false, max_tool_calls: 3, tools: [{ type: 'web_search_preview' }] });
  });

  it('requires explicit background consent and configured budget', async () => {
    const factory = vi.fn();
    const adapter = new OpenAiResearchAdapter(factory);
    await expect(adapter.start({ ...request, backgroundConsent: false }, { resolveCredential: () => 'test', emit: vi.fn() })).rejects.toThrow('research_policy_denied');
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not recreate unavailable remote work and sanitizes provider failures', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => globalThis.Response.json({ error: { message: 'secret prompt and key', type: 'not_found' } }, { status: 404 }));
    const adapter = new OpenAiResearchAdapter(() => client(fetcher));
    const context = { resolveCredential: () => 'test', emit: vi.fn() };
    expect(await adapter.retrieve(task, context)).toEqual({ eventId: 'research.retrieve_failed', type: 'incomplete', code: 'research_unretrievable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
    await expect(adapter.resume()).rejects.toThrow('research_resume_unsupported');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not claim cancellation succeeded on transport failure', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('secret network details'); });
    const adapter = new OpenAiResearchAdapter(() => client(fetcher));
    const context = { resolveCredential: () => 'test', emit: vi.fn() };
    await expect(adapter.cancel(task, context)).rejects.toThrow('research_cancel_unconfirmed');
    expect(context.emit).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('polls the accepted ID and cancels without resubmitting', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(globalThis.Response.json(response('queued')))
      .mockResolvedValueOnce(globalThis.Response.json(response('in_progress')))
      .mockResolvedValueOnce(globalThis.Response.json(response('cancelled')));
    const adapter = new OpenAiResearchAdapter(() => client(fetcher), 10);
    const context = { resolveCredential: () => 'test', emit: vi.fn(), publishResult: vi.fn() };
    await adapter.start(request, context);
    await adapter.activate(task, context);
    await vi.advanceTimersByTimeAsync(11);
    expect(String(fetcher.mock.calls[1][0])).toContain('/responses/resp_test');
    await adapter.cancel({ ...task, status: 'cancel_requested' }, context);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2][0])).toContain('/responses/resp_test/cancel');
    expect(context.emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'canceled' }));
  });
});
