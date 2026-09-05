import type { AiProviderHubService } from '../integrations/ai-provider-hub-service.js';
import type { AiProviderOperationId } from '../../core/ai-provider-contract.js';
import { TextGenerationError, type TextGenerationAdapter } from './text-generation-adapter.js';
import { randomUUID } from 'node:crypto';
import type { AiUsageSink } from './ai-usage-store.js';
import type { SpecialistTaskUsage } from '../../core/specialist-task.js';

export type CloudTextGenerator = (text: string, signal: AbortSignal,
  onDelta: (text: string) => void) => Promise<{ fullText: string; tookMs: number }>;

/** Selects only explicitly opted-in cloud text and never retries a dispatched request. */
export function selectCloudText(hub: AiProviderHubService,
  adapters: ReadonlyMap<AiProviderOperationId, TextGenerationAdapter>, usageSink?: AiUsageSink): CloudTextGenerator | null {
  const binding = hub.resolveBinding('text');
  const adapter = binding ? adapters.get(binding.operationId) : undefined;
  if (!binding || !adapter || binding.authKind !== 'api_key') return null;
  return async (text, signal, onDelta) => {
    const started = Date.now();
    const current = hub.resolveBinding('text');
    if (!current || current.bindingId !== binding.bindingId || current.revision !== binding.revision
      || current.credentialGeneration !== binding.credentialGeneration) throw new Error('cloud_binding_changed');
    const credential = hub.resolveCredential(binding.connectionId, binding.providerId, binding.credentialGeneration);
    if (!credential || signal.aborted) throw new Error('cloud_binding_unavailable');
    const requestId = randomUUID();
    let observedUsage: SpecialistTaskUsage | undefined;
    try {
      const result = await adapter.generate({text, model: binding.modelId, maxOutputTokens: 4096, signal},
        {resolveCredential: () => credential, onDelta});
      observedUsage = result.usage;
      const suffix = result.status === 'incomplete' ? '\nDie Antwort wurde unvollständig beendet.' : '';
      if (suffix) onDelta(suffix);
      return {fullText: result.fullText + suffix, tookMs: Date.now() - started};
    } catch (error) {
      if (error instanceof TextGenerationError) observedUsage = error.partial.usage;
      if (signal.aborted) throw error;
      const suffix = '\nDie externe Antwort wurde unterbrochen. Es wurde keine zweite Anfrage gestartet.';
      onDelta(suffix);
      return {fullText: (error instanceof TextGenerationError ? error.partial.fullText : '') + suffix,
        tookMs: Date.now() - started};
    } finally {
      try { usageSink?.({ requestId, providerId: binding.providerId, operationId: binding.operationId,
        role: 'text', authKind: binding.authKind, model: binding.modelId, usage: observedUsage }); }
      catch { /* Accounting failure must never rerun or discard a paid response. */ }
    }
  };
}
