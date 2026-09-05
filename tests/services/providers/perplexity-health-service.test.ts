import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerplexityHealthService } from '../../../src/services/providers/perplexity-health-service.js';
import { PERPLEXITY_PAID_PROBE } from '../../../src/core/perplexity-policy.js';
import type { AiProviderConnectionMetadata } from '../../../src/services/integrations/ai-provider-hub-store.js';

const connection: AiProviderConnectionMetadata = {
  connectionId: '11111111-1111-4111-8111-111111111111', providerId: 'perplexity', authKind: 'api_key',
  credentialGeneration: 2, displayLabel: 'Perplexity', acknowledgement: { generalWarningVersion: 'test' },
  createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z',
};
const consent = { connectionId: connection.connectionId, expectedCredentialGeneration: 2,
  paidProbeConsentVersion: PERPLEXITY_PAID_PROBE.version };
function response(status = 'completed'): Response {
  return Response.json({ id: 'probe-1', model: 'perplexity/sonar', status,
    usage: { input_tokens: 3, output_tokens: 1 } });
}
afterEach(() => vi.useRealTimers());

describe('Perplexity paid authentication probe', () => {
  it('never sends a paid request without exact consent, generation and provider', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const usage = vi.fn();
    const service = new PerplexityHealthService(usage, fetch);
    for (const input of [{ connectionId: connection.connectionId }, { ...consent, expectedCredentialGeneration: 1 },
      { ...consent, paidProbeConsentVersion: 'old' }, { ...consent, connectionId: 'other' }]) {
      expect(await service.check(connection, 'fixture-secret', input)).toMatchObject({ state: 'credential_saved_unverified' });
    }
    expect(await service.check({ ...connection, providerId: 'openai' }, 'fixture-secret', consent))
      .toMatchObject({ state: 'credential_saved_unverified' });
    expect(fetch).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
  });

  it.each(['completed', 'incomplete'])('uses one tiny no-tools native request and records %s usage', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(status));
    const usage = vi.fn();
    const service = new PerplexityHealthService(usage, fetch);
    expect(await service.check(connection, 'fixture-secret', consent)).toMatchObject({ state: 'healthy' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      model: 'perplexity/sonar', tools: [], max_output_tokens: 8, max_steps: 1, background: false, store: false,
    });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage.mock.calls[0]![0]).toMatchObject({ model: 'perplexity/sonar', usage: { inputTokens: 3, outputTokens: 1 } });
    expect(service.isModelSupported('perplexity/sonar', connection)).toBe(true);
    expect(service.isModelSupported('perplexity/sonar', { ...connection, credentialGeneration: 3 })).toBe(false);
    service.invalidate(connection.connectionId);
    expect(service.isModelSupported('perplexity/sonar', connection)).toBe(false);
  });

  it('sanitizes rejected credentials and does not retry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ error: 'fixture-secret' }, { status: 401 }));
    const service = new PerplexityHealthService(vi.fn(), fetch);
    const result = await service.check(connection, 'fixture-secret', consent);
    expect(result.state).toBe('invalid_credentials');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains measured failed-probe usage without marking the connection healthy', async () => {
    const usage = vi.fn();
    const service = new PerplexityHealthService(usage, vi.fn<typeof fetch>().mockResolvedValue(response('failed')));
    expect((await service.check(connection, 'fixture-secret', consent)).state).toBe('temporarily_unavailable');
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({usage:expect.objectContaining({inputTokens:3,outputTokens:1})}));
    expect(service.isModelSupported('perplexity/sonar', connection)).toBe(false);
  });

  it('aborts before the hub deadline, records unknown usage and never activates late success', async () => {
    vi.useFakeTimers();
    let release: (value: Response) => void = () => {};
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const usage = vi.fn();
    const service = new PerplexityHealthService(usage, fetch);
    const check = service.check(connection, 'fixture-secret', consent);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await check).toMatchObject({ state: 'temporarily_unavailable' });
    release(response());
    await vi.advanceTimersByTimeAsync(1);
    expect(service.isModelSupported('perplexity/sonar', connection)).toBe(false);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage.mock.calls[0]![0]).not.toHaveProperty('usage');
  });

  it('usage storage failure never reruns an accepted probe', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const service = new PerplexityHealthService(() => { throw new Error('disk'); }, fetch);
    expect(await service.check(connection, 'fixture-secret', consent)).toMatchObject({ state: 'healthy' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not authenticate a queued job or a different model', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response('queued'))
      .mockResolvedValueOnce(Response.json({ id: 'probe-1', model: 'other/model', status: 'completed' }));
    const service = new PerplexityHealthService(vi.fn(), fetch);
    expect((await service.check(connection, 'fixture-secret', consent)).state).toBe('temporarily_unavailable');
    expect((await service.check(connection, 'fixture-secret', consent)).state).toBe('temporarily_unavailable');
    expect(service.isModelSupported('perplexity/sonar', connection)).toBe(false);
  });
});
