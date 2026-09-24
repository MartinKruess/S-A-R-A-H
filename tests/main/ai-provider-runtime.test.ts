import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAiProviderRuntime } from '../../src/main/ai-provider-runtime.js';
import { KeyManager } from '../../src/core/crypto/key-manager.js';
import { AiCredentialStore } from '../../src/services/integrations/ai-credential-store.js';
import { AiProviderHubStore } from '../../src/services/integrations/ai-provider-hub-store.js';
import { AI_GENERAL_COST_WARNING } from '../../src/services/integrations/ai-provider-catalog.js';
import { ApiKeyHealthService } from '../../src/services/providers/api-key-health-service.js';
import { OpenAiTextAdapter } from '../../src/services/providers/openai/openai-text-adapter.js';
import type { TextGenerationContext, TextGenerationRequest } from '../../src/services/providers/text-generation-adapter.js';

let directory: string;
let providers: ReturnType<typeof createAiProviderRuntime>;
let credentials: AiCredentialStore;
const acknowledgement = { generalWarningVersion: AI_GENERAL_COST_WARNING.version };
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-provider-runtime-'));
  credentials = new AiCredentialStore(directory, new KeyManager(directory, { testWrappingKey: Buffer.alloc(32, 51) }));
  providers = createAiProviderRuntime(directory, new AiProviderHubStore(directory), credentials, () => true);
  vi.spyOn(ApiKeyHealthService.prototype, 'check').mockResolvedValue({ state: 'healthy' });
  vi.spyOn(ApiKeyHealthService.prototype, 'isModelSupported').mockReturnValue(true);
});
afterEach(async () => {
  await providers.cloudText.destroy();
  await providers.runtime.destroy();
  providers.codex.close();
  providers.hub.destroy();
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each(['delete', 'rotate', 'shutdown'] as const)('aborts live cloud text before %s completes', async (operation) => {
  let captured: { request: TextGenerationRequest; context: TextGenerationContext } | undefined;
  const generate = vi.spyOn(OpenAiTextAdapter.prototype, 'generate').mockImplementation(async (request, context) => {
    captured = { request, context };
    await new Promise<void>((resolve) => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
    context.onDelta('Late provider output');
    return { fullText: 'Late provider output', status: 'completed' };
  });
  expect((await providers.hub.saveApiKey({ providerId: 'openai', apiKey: 'fixture-old-key', acknowledgement })).ok).toBe(true);
  const connectionId = providers.hub.snapshot().connections[0]!.connectionId;
  expect((await providers.hub.checkHealth({ connectionId })).ok).toBe(true);
  expect((await providers.hub.replaceBindings({ expectedRevision: 0, bindings: [{ bindingId: randomUUID(), connectionId,
    role: 'text', operationId: 'openai_responses_text', modelProfile: 'provider_default', modelId: 'test-model',
    cloudTextOptIn: true, enabled: true, position: 0, revision: 1 }] })).ok).toBe(true);
  const run = providers.selectCloudText()!;
  expect(run).toBeTypeOf('function');
  const chunks = vi.fn();
  const pending = run('A goal', new AbortController().signal, chunks);
  const aborted = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(captured?.context.resolveCredential()).toBe('fixture-old-key');
  if (operation === 'delete') {
    expect((await providers.hub.deleteConnection({ connectionId })).ok).toBe(true);
    expect(providers.hub.snapshot().connections).toHaveLength(0);
    expect(credentials.read({ connectionId, providerId: 'openai', authKind: 'api_key' })).toBeUndefined();
  } else if (operation === 'rotate') {
    expect((await providers.hub.saveApiKey({ providerId: 'openai', apiKey: 'fixture-new-key', acknowledgement })).ok).toBe(true);
    expect(credentials.read({ connectionId, providerId: 'openai', authKind: 'api_key' })).toBe('fixture-new-key');
    expect(providers.hub.snapshot().connections[0]!.credentialGeneration).toBe(2);
  } else {
    expect(await providers.cloudText.destroy()).toBe(true);
  }
  await aborted;
  expect(captured?.request.signal?.aborted).toBe(true);
  expect(captured?.context.resolveCredential()).toBeNull();
  expect(chunks).not.toHaveBeenCalled();
  expect(generate).toHaveBeenCalledOnce();
});
