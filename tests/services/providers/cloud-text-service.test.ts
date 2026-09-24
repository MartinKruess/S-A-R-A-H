import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CloudTextService } from '../../../src/services/providers/cloud-text-service.js';
import { TextGenerationError, type TextGenerationAdapter, type TextGenerationContext, type TextGenerationRequest,
  type TextGenerationResult } from '../../../src/services/providers/text-generation-adapter.js';
import type { AiResolvedBinding } from '../../../src/services/integrations/ai-provider-hub-service.js';

function harness(generate: TextGenerationAdapter['generate'], drainTimeoutMs = 20) {
  const binding: AiResolvedBinding = { bindingId: randomUUID(), revision: 1, credentialGeneration: 1,
    connectionId: randomUUID(), providerId: 'openai', operationId: 'openai_responses_text',
    modelId: 'test-model', modelProfile: 'provider_default', authKind: 'api_key', role: 'text',
    enabled: true, position: 0, cloudTextOptIn: true };
  const hub = { resolveBinding: vi.fn((): AiResolvedBinding | null => binding),
    resolveCredential: vi.fn((): string | null => 'synthetic-credential') };
  const usage = vi.fn();
  const service = new CloudTextService(hub, new Map([['openai_responses_text', { generate }]]), usage, drainTimeoutMs);
  return { binding, hub, service, usage };
}

describe('CloudTextService lifecycle and outcome', () => {
  it.each(['completed', 'incomplete', 'refused'] as const)('preserves %s for the caller without retrying', async (status) => {
    const generate = vi.fn(async () => ({ fullText: 'Output', status }));
    const { service, usage } = harness(generate);
    const result = await service.select()!('Question', new AbortController().signal, vi.fn());
    expect(result.status).toBe(status);
    expect(result.fullText).toContain('Output');
    expect(generate).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledOnce();
    expect(await service.destroy()).toBe(true);
  });

  it('reports a failed generation with its partial text and only one accounting record', async () => {
    const generate = vi.fn(async () => { throw new TextGenerationError({ fullText: 'Partial', status: 'incomplete' }); });
    const { service, usage } = harness(generate);
    const result = await service.select()!('Question', new AbortController().signal, vi.fn());
    expect(result).toMatchObject({ status: 'failed', fullText: expect.stringContaining('Partial') });
    expect(generate).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledOnce();
  });

  it('revokes credential access and rejects late output from a canceled connection', async () => {
    let captured: { request: TextGenerationRequest; context: TextGenerationContext } | undefined;
    let finish = (): void => {};
    const { service, binding } = harness(async (request, context) => {
      captured = { request, context };
      await new Promise<void>((resolve) => { finish = resolve; });
      context.onDelta('Late output');
      return { fullText: 'Late output', status: 'completed' };
    });
    const chunks = vi.fn();
    const pending = service.select()!('Question', new AbortController().signal, chunks);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const drained = service.cancelConnection(binding.connectionId);
    expect(captured?.request.signal?.aborted).toBe(true);
    expect(captured?.context.resolveCredential()).toBeNull();
    finish();
    await rejected;
    expect(await drained).toBe(true);
    expect(chunks).not.toHaveBeenCalled();
  });

  it('does not claim a drain for an adapter that ignores cancellation', async () => {
    let finish = (): void => {};
    const { service, binding } = harness(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { fullText: 'Late output', status: 'completed' };
    });
    const pending = service.select()!('Question', new AbortController().signal, vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await service.cancelConnection(binding.connectionId)).toBe(false);
    finish();
    await rejected;
    expect(await service.cancelConnection(binding.connectionId)).toBe(true);
  });

  it('stops accepting selected closures and new work after shutdown', async () => {
    const generate = vi.fn(async (): Promise<TextGenerationResult> => ({ fullText: 'Output', status: 'completed' }));
    const { service } = harness(generate);
    const selected = service.select()!;
    expect(await service.destroy()).toBe(true);
    expect(service.select()).toBeNull();
    await expect(selected('Question', new AbortController().signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects a changed lease and does not record a request that was never dispatched', async () => {
    const generate = vi.fn(async (): Promise<TextGenerationResult> => ({ fullText: 'Output', status: 'completed' }));
    const { service, hub, binding, usage } = harness(generate);
    const selected = service.select()!;
    hub.resolveBinding.mockReturnValue({ ...binding, credentialGeneration: 2 });
    await expect(selected('Question', new AbortController().signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
    expect(generate).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
  });
});
