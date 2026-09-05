import { randomUUID } from 'node:crypto';
import { APIError } from '@perplexity-ai/perplexity_ai';
import type { AiConnectionHealth, CheckAiConnectionHealthInput } from '../../core/ai-provider-contract.js';
import { PERPLEXITY_PAID_PROBE } from '../../core/perplexity-policy.js';
import type { AiProviderConnectionMetadata } from '../integrations/ai-provider-hub-store.js';
import type { AiUsageSink } from './ai-usage-store.js';
import { createPerplexityClient, PERPLEXITY_NATIVE_MODEL, PerplexityResponseSchema,
  perplexityUsage } from './perplexity/perplexity-common.js';

/** A separately consented, bounded paid probe; never treats public model discovery as authentication. */
export class PerplexityHealthService {
  private readonly verified = new Map<string, number>();
  private readonly pending = new Map<string, AbortController>();
  constructor(private readonly onUsage: AiUsageSink, private readonly fetchImpl?: typeof fetch) {}

  invalidate(connectionId: string): void {
    this.pending.get(connectionId)?.abort();
    this.pending.delete(connectionId);
    this.verified.delete(connectionId);
  }

  isModelSupported(model: string, connection: AiProviderConnectionMetadata): boolean {
    return connection.providerId === 'perplexity' && connection.authKind === 'api_key'
      && model === PERPLEXITY_NATIVE_MODEL
      && this.verified.get(connection.connectionId) === (connection.credentialGeneration ?? 1);
  }

  async check(connection: AiProviderConnectionMetadata, key: string | null,
    input: CheckAiConnectionHealthInput): Promise<AiConnectionHealth> {
    if (connection.providerId !== 'perplexity' || connection.authKind !== 'api_key' || !key
      || input.connectionId !== connection.connectionId
      || input.expectedCredentialGeneration !== (connection.credentialGeneration ?? 1)
      || input.paidProbeConsentVersion !== PERPLEXITY_PAID_PROBE.version) {
      return { state: 'credential_saved_unverified', message: 'Die kostenpflichtige Prüfung erfordert eine gesonderte aktuelle Bestätigung.' };
    }
    this.invalidate(connection.connectionId);
    const controller = new AbortController();
    this.pending.set(connection.connectionId, controller);
    const requestId = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let recorded = false;
    const record = (usage?: ReturnType<typeof perplexityUsage>): void => {
      if (recorded) return;
      recorded = true;
      try {
        this.onUsage({ requestId, providerId: 'perplexity', operationId: 'perplexity_agent_research',
          role: 'research', model: PERPLEXITY_NATIVE_MODEL, authKind: 'api_key', ...(usage ? { usage } : {}) });
      } catch { /* A failed usage sink cannot repeat the paid probe. */ }
    };
    try {
      const client = createPerplexityClient(key, { fetchImpl: this.fetchImpl, timeoutMs: 8_000 });
      const result = await Promise.race([
        client.responses.create({ model: PERPLEXITY_NATIVE_MODEL, input: 'Reply OK.', tools: [],
          max_output_tokens: 8, max_steps: 1, background: false, store: false, stream: false }, { signal: controller.signal }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(null); }, 8_000);
        }),
      ]);
      if (controller.signal.aborted || this.pending.get(connection.connectionId) !== controller) throw new Error('Probe interrupted');
      const parsed = PerplexityResponseSchema.safeParse(result);
      if (!parsed.success || parsed.data.model !== PERPLEXITY_NATIVE_MODEL) throw new Error('Invalid probe response');
      record(perplexityUsage(parsed.data));
      if (!['completed', 'incomplete'].includes(parsed.data.status)) throw new Error('Invalid probe response');
      this.verified.set(connection.connectionId, connection.credentialGeneration ?? 1);
      return { state: 'healthy', message: 'Kostenpflichtige API-Prüfung abgeschlossen. Der tatsächliche Verbrauch wird separat erfasst.' };
    } catch (error) {
      record();
      if (error instanceof APIError && [401, 403].includes(error.status ?? 0)) {
        return { state: 'invalid_credentials', message: 'Der Anbieter hat die Zugangsdaten abgelehnt.' };
      }
      return { state: 'temporarily_unavailable', message: 'Die Prüfung konnte nicht sicher bestätigt werden. API-Kosten sind möglich. Sarah wiederholt sie nicht automatisch.' };
    } finally {
      if (timer) clearTimeout(timer);
      if (this.pending.get(connection.connectionId) === controller) this.pending.delete(connection.connectionId);
      controller.abort();
    }
  }
}
