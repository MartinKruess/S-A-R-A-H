import Perplexity from '@perplexity-ai/perplexity_ai';
import { z } from 'zod';
import type { SpecialistTaskUsage, SpecialistTaskResult } from '../../../core/specialist-task.js';

export const PERPLEXITY_NATIVE_MODEL = 'perplexity/sonar';
const Count = z.number().int().nonnegative();
const Annotation = z.object({ type: z.string(), url: z.string().max(4096).optional(), title: z.string().max(1000).optional() });
export const PerplexityResponseSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9._:-]+$/iu),
  model: z.literal(PERPLEXITY_NATIVE_MODEL),
  status: z.enum(['queued', 'in_progress', 'cancelling', 'completed', 'cancelled', 'failed', 'incomplete']),
  output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(),
    text: z.string().max(200_000).optional(), annotations: z.array(Annotation).max(1000).optional() })).max(1000).optional() })).max(1000).default([]),
  usage: z.object({ input_tokens: Count, output_tokens: Count,
    input_tokens_details: z.object({ cache_read_input_tokens: Count.optional(), cache_creation_input_tokens: Count.optional(), cached_tokens: Count.optional() }).optional(),
    output_tokens_details: z.object({ reasoning_tokens: Count.optional() }).optional(),
    tool_calls_details: z.record(z.string(), z.object({ invocation: Count.optional() })).optional(),
    cost: z.object({ total_cost: z.number().nonnegative(), currency: z.string().length(3) }).optional(),
  }).optional(),
});
export type PerplexityResponse = z.infer<typeof PerplexityResponseSchema>;
export type PerplexityClientFactory = (apiKey: string) => Perplexity;

/** Fixed official origin; explicit secret only, no inherited endpoint/logging or redirect leakage. */
export function createPerplexityClient(apiKey: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Perplexity {
  if (!apiKey.trim()) throw new Error('perplexity_credential_unavailable');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return new Perplexity({ apiKey, baseURL: 'https://api.perplexity.ai', maxRetries: 0,
    timeout: options.timeoutMs ?? 30_000, logLevel: 'off',
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'https://api.perplexity.ai') throw new Error('perplexity_origin_denied');
      return fetchImpl(input, { ...init, redirect: 'error' });
    },
  });
}

/** Preserve absence of provider usage; normalize one cumulative checkpoint, never sum polls. */
export function perplexityUsage(response: PerplexityResponse): SpecialistTaskUsage | undefined {
  if (!response.usage) return undefined;
  const usage = response.usage;
  const cached = usage.input_tokens_details?.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens;
  const toolCounts = usage.tool_calls_details ? Object.values(usage.tool_calls_details) : undefined;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(usage.input_tokens_details?.cache_creation_input_tokens !== undefined ? { cacheWriteInputTokens: usage.input_tokens_details.cache_creation_input_tokens } : {}),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens } : {}),
    ...(toolCounts?.every((item) => item.invocation !== undefined) ? { toolCalls: toolCounts.reduce((sum, item) => sum + item.invocation!, 0) } : {}),
    ...(usage.cost ? { providerReportedCost: { amount: usage.cost.total_cost, currency: usage.cost.currency.toUpperCase() } } : {}) };
}

/** Render data only; discard executable/credential-bearing/duplicate source URLs. */
export function perplexityResult(response: PerplexityResponse): SpecialistTaskResult {
  let text = '';
  const citations: { url: string; title: string }[] = [];
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type !== 'output_text') continue;
      text += part.text ?? '';
      if (text.length > 200_000) text = text.slice(0, 200_000);
      for (const source of part.annotations ?? []) {
        if (source.type !== 'url_citation' || !source.url || citations.length >= 100) continue;
        try { const url = new URL(source.url);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || citations.some((entry) => entry.url === url.href)) continue;
          citations.push({ url: url.href, title: (source.title ?? url.hostname).slice(0, 500) });
        } catch { /* Invalid source annotations are not links. */ }
      }
    }
  }
  return { text, citations };
}
