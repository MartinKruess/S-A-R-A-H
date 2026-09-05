import OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import type { SpecialistTaskUsage } from '../../../core/specialist-task.js';

export type OpenAiClientFactory = (apiKey: string) => OpenAI;
/** Fixed official endpoint, bounded calls and no automatic retries after dispatch. */
export const createOpenAiClient: OpenAiClientFactory = (apiKey) => new OpenAI({
  apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: 30_000,
  logLevel: 'off', organization: null, project: null,
});

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

/** Keeps result content ephemeral and bounded; citations cannot contain executable schemes. */
export function responseResult(response: Response) {
  const citations: { url: string; title: string }[] = [];
  let text = '';
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type !== 'output_text') continue;
      text += part.text;
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
  return { text: text.slice(0, 100_000), citations };
}
