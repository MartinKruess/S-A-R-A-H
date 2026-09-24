import type { AiProviderHubService } from '../integrations/ai-provider-hub-service.js';
import type { AiProviderOperationId } from '../../core/ai-provider-contract.js';
import { abortError, linkAbortSignals, throwIfAborted, waitForSettlement } from '../../core/abort-utils.js';
import { TextGenerationError, type TextGenerationAdapter, type TextGenerationResult } from './text-generation-adapter.js';
import { randomUUID } from 'node:crypto';
import type { AiUsageSink } from './ai-usage-store.js';
import type { SpecialistTaskUsage } from '../../core/specialist-task.js';

export interface CloudTextResult {
  readonly fullText: string;
  readonly tookMs: number;
  readonly status: TextGenerationResult['status'] | 'failed';
}

export type CloudTextGenerator = (text: string, signal: AbortSignal,
  onDelta: (text: string) => void) => Promise<CloudTextResult>;

type CloudTextHub = Pick<AiProviderHubService, 'resolveBinding' | 'resolveCredential'>;

interface ActiveCloudTextRequest {
  readonly connectionId: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

/** Owns active cloud requests so connection revocation and shutdown also stop text. */
export class CloudTextService {
  private readonly active = new Set<ActiveCloudTextRequest>();
  private stopped = false;

  constructor(
    private readonly hub: CloudTextHub,
    private readonly adapters: ReadonlyMap<AiProviderOperationId, TextGenerationAdapter>,
    private readonly usageSink?: AiUsageSink,
    private readonly drainTimeoutMs = 2_000,
  ) {}

  /** Selects an explicit current lease; every invocation revalidates it before dispatch. */
  select(): CloudTextGenerator | null {
    if (this.stopped) return null;
    const binding = this.hub.resolveBinding('text');
    const adapter = binding ? this.adapters.get(binding.operationId) : undefined;
    if (!binding || !adapter || binding.authKind !== 'api_key') return null;
    const isCurrent = (): boolean => {
      const current = this.hub.resolveBinding('text');
      return !this.stopped && current !== null
        && current.bindingId === binding.bindingId && current.revision === binding.revision
        && current.connectionId === binding.connectionId && current.providerId === binding.providerId
        && current.operationId === binding.operationId && current.modelId === binding.modelId
        && current.authKind === binding.authKind
        && current.credentialGeneration === binding.credentialGeneration;
    };

    return async (text, callerSignal, onDelta) => {
      throwIfAborted(callerSignal);
      if (!isCurrent()) throw abortError('Cloud binding changed');
      const started = Date.now();
      const controller = new AbortController();
      const linked = linkAbortSignals(callerSignal, controller.signal);
      let settle = (): void => {};
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      const active = { connectionId: binding.connectionId, controller, settled };
      this.active.add(active);
      const requestId = randomUUID();
      let observedUsage: SpecialistTaskUsage | undefined;
      let dispatched = false;
      const requireCurrent = (): void => {
        if (!isCurrent()) controller.abort(abortError('Cloud binding changed'));
        throwIfAborted(linked.signal);
      };
      const resolveCredential = (): string | null => linked.signal.aborted || !isCurrent()
        ? null
        : this.hub.resolveCredential(binding.connectionId, binding.providerId, binding.credentialGeneration);
      const publish = (chunk: string): void => {
        if (!isCurrent()) controller.abort(abortError('Cloud binding changed'));
        if (!linked.signal.aborted) onDelta(chunk);
      };
      try {
        requireCurrent();
        if (!resolveCredential()) throw abortError('Cloud credential unavailable');
        dispatched = true;
        const result = await adapter.generate({ text, model: binding.modelId, maxOutputTokens: 4096,
          signal: linked.signal }, { resolveCredential, onDelta: publish });
        observedUsage = result.usage;
        requireCurrent();
        const suffix = result.status === 'incomplete' ? '\nDie Antwort wurde unvollständig beendet.' : '';
        if (suffix) publish(suffix);
        return { fullText: result.fullText + suffix, tookMs: Date.now() - started, status: result.status };
      } catch (error) {
        if (error instanceof TextGenerationError) observedUsage = error.partial.usage;
        requireCurrent();
        if (!dispatched) throw error;
        const suffix = '\nDie externe Antwort wurde unterbrochen. Es wurde keine zweite Anfrage gestartet.';
        publish(suffix);
        return { fullText: (error instanceof TextGenerationError ? error.partial.fullText : '') + suffix,
          tookMs: Date.now() - started, status: 'failed' };
      } finally {
        linked.dispose();
        this.active.delete(active);
        settle();
        if (dispatched) {
          try { this.usageSink?.({ requestId, providerId: binding.providerId, operationId: binding.operationId,
            role: 'text', authKind: binding.authKind, model: binding.modelId, usage: observedUsage }); }
          catch { /* Accounting failure must never rerun or discard a paid response. */ }
        }
      }
    };
  }

  /** Abort the selected connection and confirm only a locally settled request drain. */
  async cancelConnection(connectionId: string): Promise<boolean> {
    return this.drain([...this.active].filter((request) => request.connectionId === connectionId));
  }

  /** Reject new selections immediately and bound shutdown even if a transport fails to settle. */
  async destroy(): Promise<boolean> {
    this.stopped = true;
    return this.drain([...this.active]);
  }

  private async drain(requests: readonly ActiveCloudTextRequest[]): Promise<boolean> {
    for (const request of requests) request.controller.abort(abortError('Cloud connection stopped'));
    return waitForSettlement(Promise.all(requests.map((request) => request.settled)), this.drainTimeoutMs);
  }
}

/** Standalone selector; the application retains a CloudTextService to own its lifecycle. */
export function selectCloudText(hub: CloudTextHub,
  adapters: ReadonlyMap<AiProviderOperationId, TextGenerationAdapter>, usageSink?: AiUsageSink): CloudTextGenerator | null {
  return new CloudTextService(hub, adapters, usageSink).select();
}
