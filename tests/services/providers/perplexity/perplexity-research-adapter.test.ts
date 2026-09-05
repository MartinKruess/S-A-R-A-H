import { describe, it, expect, vi } from 'vitest';
import { PerplexityResearchAdapter } from '../../../../src/services/providers/perplexity/perplexity-research-adapter.js';
import { createPerplexityClient, PerplexityResponseSchema, perplexityResult, perplexityUsage } from '../../../../src/services/providers/perplexity/perplexity-common.js';
import { PERPLEXITY_STORAGE_DISCLOSURE } from '../../../../src/core/perplexity-policy.js';
import { SpecialistTaskRequestSchema, AcceptedSpecialistTaskMetadataSchema } from '../../../../src/core/specialist-task.js';

const response = (status = 'completed') => ({ id: 'resp_test', model: 'perplexity/sonar', status, object: 'response', output: [
  { type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [{ type: 'url_citation', url: 'https://example.com', title: 'Source' }] }] },
] });
const request = () => SpecialistTaskRequestSchema.parse({ taskId: '123e4567-e89b-42d3-a456-426614174000', role: 'research', goal: 'Research bicycles',
  sourceTurnId: 'turn', planId: '123e4567-e89b-42d3-a456-426614174001', planRevision: 1, planFingerprint: 'a'.repeat(64), stepId: 'step',
  providerId: 'perplexity', operationId: 'perplexity_agent_research', connectionId: '123e4567-e89b-42d3-a456-426614174002',
  bindingId: '123e4567-e89b-42d3-a456-426614174003', bindingRevision: 1, credentialGeneration: 1, modelId: 'perplexity/sonar', authKind: 'api_key',
  backgroundConsent: true, storageDisclosureVersion: PERPLEXITY_STORAGE_DISCLOSURE.version, privateContext: false, originMode: 'chat',
  dataEgress: ['goal'], accessMode: 'none', budget: { maxTurns: 1, timeoutMs: 60000, maxOutputTokens: 100, maxSteps: 3 } });
const metadata = () => AcceptedSpecialistTaskMetadataSchema.parse({ taskId: request().taskId, role: 'research', providerId: 'perplexity',
  operationId: 'perplexity_agent_research', connectionId: request().connectionId, bindingId: request().bindingId, bindingRevision: 1,
  credentialGeneration: 1, modelId: 'perplexity/sonar', remoteRef: 'resp_test', status: 'running', sequence: 0,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), eventIds: [], maxTurns: 1, turnsUsed: 1 });
function fixture(payloads: object[]) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payloads.shift() ?? response()), { headers: { 'content-type': 'application/json' } }));
  const adapter = new PerplexityResearchAdapter((key) => createPerplexityClient(key, { fetchImpl }), 1, 100);
  const context = { resolveCredential: () => 'test-secret', isAllowed: () => true, emit: vi.fn(), publishResult: vi.fn() };
  return { adapter, fetchImpl, context };
}
describe('Perplexity native research', () => {
  it('sends one native stored bounded request and publishes only after activation', async () => {
    const { adapter, fetchImpl, context } = fixture([response()]);
    expect(await adapter.start(request(), context)).toEqual({ remoteRef: 'resp_test', status: 'running' });
    expect(context.emit).not.toHaveBeenCalled(); expect(context.publishResult).not.toHaveBeenCalled();
    const calls = vi.mocked(fetchImpl).mock.calls as Parameters<typeof fetch>[];
    const body = JSON.parse(String(calls[0]![1]!.body));
    expect(body).toEqual({ model: 'perplexity/sonar', input: 'Research bicycles', tools: [{ type: 'web_search' }], background: true, store: true, max_output_tokens: 100, max_steps: 3 });
    expect(calls[0]![1]!.redirect).toBe('error');
    await adapter.activate(metadata(), context);
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed' }));
    expect(context.publishResult).toHaveBeenCalledWith({ text: 'Answer', citations: [{ url: 'https://example.com/', title: 'Source' }] });
  });
  it.each(['wrong-storage', 'denied-policy', 'foreign-model'])('rejects %s before any network call', async (kind) => {
    const { adapter, fetchImpl, context } = fixture([]);
    const input = { ...request(), ...(kind === 'wrong-storage' ? { storageDisclosureVersion: 'old' } : {}), ...(kind === 'foreign-model' ? { modelId: 'openai/gpt-test' } : {}) };
    await expect(adapter.start(input, { ...context, isAllowed: () => kind !== 'denied-policy' })).rejects.toThrow('perplexity_policy_denied');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('polls after cancelling acknowledgement and confirms only terminal cancelled', async () => {
    const { adapter, context, fetchImpl } = fixture([response('queued'), { response_id: 'resp_test', status: 'cancelling' }, response('cancelling'), response('cancelled')]);
    const accepted = await adapter.start(request(), context);
    await adapter.cancel(accepted, context);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(context.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'canceled' }));
  });
  it('rejects wrong cancellation ID rather than claiming success', async () => {
    const { adapter, context } = fixture([response('queued'), { response_id: 'other', status: 'cancelling' }]);
    const accepted = await adapter.start(request(), context);
    await expect(adapter.cancel(accepted, context)).rejects.toThrow('perplexity_cancel_unconfirmed');
    expect(context.emit).not.toHaveBeenCalled();
  });
  it('recovers existing ID without another create and marks wrong IDs incomplete', async () => {
    const { adapter, context, fetchImpl } = fixture([{ ...response(), id: 'wrong' }]);
    expect(await adapter.retrieve(metadata(), context)).toMatchObject({ type: 'incomplete' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(fetchImpl).mock.calls as Parameters<typeof fetch>[];
    expect(calls[0]![1]!.method).toBe('GET');
    expect(calls[1]![1]!.method).toBe('POST');
  });
  it('does not retry a rate limit after dispatch', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"limited"}', { status: 429 }));
    const adapter = new PerplexityResearchAdapter((key) => createPerplexityClient(key, { fetchImpl }));
    await expect(adapter.start(request(), fixture([]).context)).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('cancels an accepted job after failed recovery without resubmitting the goal', async () => {
    const seen: { url: string; method?: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), method: init?.method });
      if (seen.length === 1) return new Response('unavailable', { status: 503 });
      const payload = init?.method === 'POST' ? { response_id: 'resp_test', status: 'cancelling' } : response('cancelled');
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    };
    const adapter = new PerplexityResearchAdapter((key) => createPerplexityClient(key, { fetchImpl }), 1, 100);
    const context = fixture([]).context;
    expect(await adapter.retrieve(metadata(), context)).toMatchObject({ type: 'incomplete', code: 'perplexity_unretrievable' });
    expect(seen.map((item) => item.method)).toEqual(['GET', 'POST', 'GET']);
    expect(seen[1]!.url).toMatch(/\/resp_test\/cancel$/u);
    expect(context.publishResult).not.toHaveBeenCalled(); expect(context.emit).not.toHaveBeenCalled();
  });
  it.each(['retrieve', 'poll'])('drops a %s result when web permission is revoked while awaiting it', async (mode) => {
    let allowed = true;
    let release: ((value: Response) => void) | undefined;
    let calls = 0;
    const json = (value: object) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls += 1;
      if (mode === 'poll' && calls === 1) return json(response('queued'));
      if (!release) return new Promise<Response>((resolve) => { release = resolve; });
      if (init?.method === 'POST') return json({ response_id: 'resp_test', status: 'cancelling' });
      return json(response('completed'));
    });
    const adapter = new PerplexityResearchAdapter((key) => createPerplexityClient(key, { fetchImpl }), 1, 100);
    const context = { resolveCredential: () => 'test-secret', isAllowed: () => allowed, emit: vi.fn(), publishResult: vi.fn() };
    let retrieval: ReturnType<typeof adapter.retrieve> | undefined;
    if (mode === 'poll') { await adapter.start(request(), context); await adapter.activate(metadata(), context); }
    else retrieval = adapter.retrieve(metadata(), context);
    await vi.waitFor(() => expect(release).toBeDefined());
    allowed = false; release!(json(response('completed')));
    if (retrieval) expect(await retrieval).toMatchObject({ type: 'incomplete', code: 'policy_revoked' });
    else await vi.waitFor(() => expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'incomplete', code: 'policy_revoked' })));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(mode === 'poll' ? 4 : 3));
    expect(context.publishResult).not.toHaveBeenCalled();
    expect(context.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'completed' }));
  });
  it('does not publish a completed cancellation response after policy revocation', async () => {
    const { adapter, context } = fixture([response('queued'), { response_id: 'resp_test', status: 'cancelling' }, response('completed')]);
    const accepted = await adapter.start(request(), context);
    await adapter.cancel(accepted, { ...context, isAllowed: () => false });
    expect(context.publishResult).not.toHaveBeenCalled();
  });
  it('keeps absent usage absent and normalizes reported cost/calls', () => {
    expect(perplexityUsage(PerplexityResponseSchema.parse(response()))).toBeUndefined();
    expect(perplexityUsage(PerplexityResponseSchema.parse({ ...response(), usage: { input_tokens: 1, output_tokens: 2 } }))).toEqual({ inputTokens: 1, outputTokens: 2 });
    const parsed = PerplexityResponseSchema.parse({ ...response(), usage: { input_tokens: 5, output_tokens: 2,
      cost: { total_cost: 0.01, currency: 'USD' }, tool_calls_details: { web_search: { invocation: 2 } } } });
    expect(perplexityUsage(parsed)).toMatchObject({ inputTokens: 5, outputTokens: 2, toolCalls: 2, providerReportedCost: { amount: 0.01, currency: 'USD' } });
    expect(perplexityResult(PerplexityResponseSchema.parse({ ...response(), output: [{ type: 'message', content: [{ type: 'output_text', text: 'Safe', annotations: [
      { type: 'url_citation', url: 'javascript:alert(1)' }, { type: 'url_citation', url: 'https://user:pass@example.com' },
    ] }] }] })).citations).toEqual([]);
  });
});
