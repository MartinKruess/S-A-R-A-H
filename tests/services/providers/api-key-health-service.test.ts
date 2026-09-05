import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyHealthService } from '../../../src/services/providers/api-key-health-service.js';
import type { AiProviderConnectionMetadata } from '../../../src/services/integrations/ai-provider-hub-store.js';

const connection: AiProviderConnectionMetadata = {
  connectionId: '11111111-1111-4111-8111-111111111111', providerId: 'anthropic', authKind: 'api_key',
  credentialGeneration: 1, displayLabel: 'Anthropic API', acknowledgement: { generalWarningVersion: 'test' },
  createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z',
};
function page(ids: string[], more = false): Response {
  return Response.json({ data: ids.map((id) => ({ id, type: 'model' })), has_more: more,
    first_id: ids[0], last_id: ids.at(-1) });
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('API model health discovery', () => {
  it('ignores hostile ambient auth, custom headers and debug logging', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-secret');
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'Authorization: Bearer ambient-secret\nX-Injected: ambient');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    vi.stubEnv('OPENAI_LOG', 'debug');
    vi.stubEnv('OPENAI_ORG_ID', 'ambient-org');
    vi.stubEnv('OPENAI_PROJECT_ID', 'ambient-project');
    const requests: Headers[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requests.push(new Headers(init?.headers));
      return page(['claude-first']);
    };
    const service = new ApiKeyHealthService(fetch);
    expect(await service.check(connection, 'fixture-secret')).toMatchObject({ state: 'healthy' });
    expect(requests[0]!.get('authorization')).toBeNull();
    expect(requests[0]!.get('x-api-key')).toBe('fixture-secret');
    expect(requests[0]!.get('x-injected')).toBeNull();
    await service.check({ ...connection, providerId: 'openai' }, 'openai-fixture');
    expect(requests[1]!.get('openai-organization')).toBeNull();
    expect(requests[1]!.get('openai-project')).toBeNull();
    expect(requests[1]!.get('authorization')).toBe('Bearer openai-fixture');
  });
  it('discovers every bounded page and binds models to the exact account generation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(page(['claude-first'], true))
      .mockResolvedValueOnce(page(['claude-second']));
    const service = new ApiKeyHealthService(fetch);
    expect(await service.check(connection, 'fixture-secret')).toMatchObject({ state: 'healthy' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]![0])).toContain('after_id=claude-first');
    expect(service.isModelSupported('anthropic_messages_text', 'claude-second', connection)).toBe(true);
    expect(service.isModelSupported('anthropic_messages_text', 'claude-second', { ...connection, credentialGeneration: 2 })).toBe(false);
    expect(service.isModelSupported('anthropic_messages_text', 'claude-second', { ...connection, connectionId: 'other' })).toBe(false);
    expect(service.isModelSupported('anthropic_claude_agent', 'claude-second', connection)).toBe(false);
    expect(service.isModelSupported('openai_responses_text', 'claude-second', connection)).toBe(false);
    service.invalidate(connection.connectionId);
    expect(service.isModelSupported('anthropic_messages_text', 'claude-second', connection)).toBe(false);
  });

  it('sanitizes authentication failures without retrying or retaining old capabilities', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(page(['claude-first']))
      .mockResolvedValueOnce(Response.json({ error: { type: 'authentication_error', message: 'fixture-secret' } }, { status: 401 }));
    const service = new ApiKeyHealthService(fetch);
    await service.check(connection, 'fixture-secret');
    const result = await service.check(connection, 'replacement');
    expect(result).toEqual({ state: 'invalid_credentials' });
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.isModelSupported('anthropic_messages_text', 'claude-first', connection)).toBe(false);
  });

  it('returns before the hub deadline and never publishes a late response', async () => {
    vi.useFakeTimers();
    let release: (response: Response) => void = () => {};
    const service = new ApiKeyHealthService(() => new Promise<Response>((resolve) => { release = resolve; }));
    const result = service.check(connection, 'fixture-secret');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await result).toEqual({ state: 'temporarily_unavailable' });
    release(page(['claude-late']));
    await vi.advanceTimersByTimeAsync(1);
    expect(service.isModelSupported('anthropic_messages_text', 'claude-late', connection)).toBe(false);
  });

  it('keeps OpenAI models separate and refuses managed-session discovery', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ object: 'list', data: [
      { id: 'gpt-test', object: 'model' }, { id: 'o3-deep-research', object: 'model' },
    ] }));
    const service = new ApiKeyHealthService(fetch);
    const openai = { ...connection, providerId: 'openai' as const };
    expect(await service.check(openai, 'fixture-secret')).toMatchObject({ state: 'healthy' });
    expect(service.isModelSupported('openai_responses_text', 'gpt-test', openai)).toBe(true);
    expect(service.isModelSupported('openai_deep_research', 'o3-deep-research', openai)).toBe(true);
    expect(await service.check({ ...openai, authKind: 'codex_managed_chatgpt' }, null)).toMatchObject({ state: 'temporarily_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete discovery instead of activating only the first twenty pages', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => page(['claude-first'], true));
    const service = new ApiKeyHealthService(fetch);
    expect(await service.check(connection, 'fixture-secret')).toMatchObject({ state: 'temporarily_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(20);
    expect(service.isModelSupported('anthropic_messages_text', 'claude-first', connection)).toBe(false);
  });
});
