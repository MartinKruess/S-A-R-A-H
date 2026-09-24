import OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import type { SpecialistTaskUsage } from '../../../core/specialist-task.js';

export type OpenAiClientFactory = (apiKey: string) => OpenAI;
/** Fixed official endpoint and selected credential, isolated from SDK environment headers. */
export function createOpenAiClient(apiKey: string,
  options: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {}): OpenAI {
  if (!apiKey.trim()) throw new Error('openai_credential_unavailable');
  const transport = options.fetchImpl ?? globalThis.fetch;
  return new OpenAI({
    apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: options.timeoutMs ?? 30_000,
    logLevel: 'off', organization: null, project: null,
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'https://api.openai.com') throw new Error('provider_origin_denied');
      // The chosen Sarah credential is authoritative; host headers cannot select another account or project.
      const headers = new Headers({ authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json', accept: 'application/json' });
      return transport(input, { ...init, headers, redirect: 'error' });
    },
  });
}

/** Normalizes documented cumulative response usage; absent usage stays absent. */
export function responseUsage(response: Response): SpecialistTaskUsage | undefined {
  if (!response.usage) return undefined;
  return {
    inputTokens: response.usage.input_tokens,
    cachedInputTokens: response.usage.input_tokens_details.cached_tokens,
    outputTokens: response.usage.output_tokens,
    reasoningTokens: response.usage.output_tokens_details.reasoning_tokens,
    toolCalls: response.output.filter((item) => item.type === 'web_search_call').length,
  };
}

/** Identifies a provider refusal independently of the response transport's completed status. */
export function responseHasRefusal(response: Response): boolean {
  return response.output.some((item) => item.type === 'message'
    && item.content.some((part) => part.type === 'refusal'));
}

/** Keeps results bounded, gives refusals visible priority, and drops unsafe citations. */
export function responseResult(response: Response) {
  const citations: { url: string; title: string }[] = [];
  let text = '';
  let refusal = '';
  let refused = false;
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'refusal') {
        refused = true;
        refusal += `${refusal ? '\n' : ''}${part.refusal}`.slice(0, 100_000 - refusal.length);
        continue;
      }
      if (part.type !== 'output_text') continue;
      text += part.text.slice(0, 100_000 - text.length);
      for (const annotation of part.annotations) {
        if (annotation.type !== 'url_citation' || citations.length >= 100) continue;
        try {
          const url = new URL(annotation.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
            || url.href.length > 2_048 || citations.some((item) => item.url === url.href)) continue;
          citations.push({ url: url.href, title: annotation.title.slice(0, 300) || url.hostname });
        } catch { /* Untrusted malformed citation is omitted. */ }
      }
    }
  }
  if (refused) {
    const explanation = refusal.trim() || 'Der Anbieter hat diese Anfrage abgelehnt.';
    text = `${explanation}${text ? `\n\n${text}` : ''}`;
  }
  return { text: text.slice(0, 100_000), citations };
}
