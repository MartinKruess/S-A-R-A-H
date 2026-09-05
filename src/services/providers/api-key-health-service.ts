import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { AiConnectionHealth, AiProviderOperationId } from '../../core/ai-provider-contract.js';
import type { AiProviderConnectionMetadata } from '../integrations/ai-provider-hub-store.js';
import { createAnthropicClient } from './anthropic/anthropic-text-adapter.js';

interface ModelPage {
  data: { id: string }[];
  hasNextPage(): boolean;
  getNextPage(): Promise<ModelPage>;
}
interface VerifiedModels {
  providerId: string;
  generation: number;
  models: ReadonlySet<string>;
}

/** Discovers models without generation calls and binds the complete result to one credential lease. */
export class ApiKeyHealthService {
  private readonly models = new Map<string, VerifiedModels>();
  private readonly checks = new Map<string, AbortController>();

  constructor(private readonly fetchImpl?: typeof fetch) {}

  /** Revocation aborts pending discovery and clears all cached capabilities for this connection. */
  invalidate(connectionId: string): void {
    this.checks.get(connectionId)?.abort();
    this.checks.delete(connectionId);
    this.models.delete(connectionId);
  }

  isModelSupported(operation: AiProviderOperationId, model: string, connection: AiProviderConnectionMetadata): boolean {
    const known = this.models.get(connection.connectionId);
    if (connection.authKind !== 'api_key' || !known || known.providerId !== connection.providerId
      || known.generation !== (connection.credentialGeneration ?? 1) || !known.models.has(model)) return false;
    if (operation === 'openai_responses_text') return connection.providerId === 'openai' && /^gpt-/u.test(model);
    if (operation === 'openai_deep_research') return connection.providerId === 'openai'
      && ['o3-deep-research', 'o4-mini-deep-research'].includes(model);
    return operation === 'anthropic_messages_text' && connection.providerId === 'anthropic' && /^claude-/u.test(model);
  }

  async check(connection: AiProviderConnectionMetadata, key: string | null): Promise<AiConnectionHealth> {
    this.invalidate(connection.connectionId);
    if (connection.authKind !== 'api_key' || !key || !['openai', 'anthropic'].includes(connection.providerId)) {
      return { state: 'temporarily_unavailable' };
    }
    const controller = new AbortController();
    this.checks.set(connection.connectionId, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, 8_000);
      });
      const models = await Promise.race([this.discover(connection, key, controller.signal), deadline]);
      if (!models || controller.signal.aborted || this.checks.get(connection.connectionId) !== controller) {
        return { state: 'temporarily_unavailable' };
      }
      this.models.set(connection.connectionId, { providerId: connection.providerId,
        generation: connection.credentialGeneration ?? 1, models });
      return { state: 'healthy', message: 'API-Schlüssel geprüft. Modellzugriff wird bei der Anfrage geprüft.' };
    } catch (error) {
      return { state: (error instanceof OpenAI.APIError || error instanceof Anthropic.APIError)
        && [401, 403].includes(error.status ?? 0) ? 'invalid_credentials' : 'temporarily_unavailable' };
    } finally {
      if (timer) clearTimeout(timer);
      if (this.checks.get(connection.connectionId) === controller) this.checks.delete(connection.connectionId);
    }
  }

  private async discover(connection: AiProviderConnectionMetadata, key: string, signal: AbortSignal): Promise<ReadonlySet<string>> {
    const options = { apiKey: key, maxRetries: 0, timeout: 8_000,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}) };
    let page: ModelPage = connection.providerId === 'openai'
      ? await new OpenAI({ ...options, baseURL: 'https://api.openai.com/v1',
        logLevel: 'off', organization: null, project: null }).models.list({ signal })
      : await createAnthropicClient(key, { fetchImpl: this.fetchImpl, timeoutMs: 8_000 }).models.list({ limit: 100 }, { signal });
    const models = new Set<string>();
    for (let count = 0; count < 20; count++) {
      if (signal.aborted) throw new Error('Discovery aborted');
      for (const entry of page.data) {
        if (typeof entry.id !== 'string' || entry.id.length > 100 || models.size >= 2_000) throw new Error('Invalid discovery');
        models.add(entry.id);
      }
      if (!page.hasNextPage()) return models;
      if (count === 19) throw new Error('Incomplete discovery');
      page = await page.getNextPage();
    }
    throw new Error('Incomplete discovery');
  }
}
