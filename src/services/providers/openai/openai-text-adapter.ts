import type { TextGenerationAdapter, TextGenerationContext, TextGenerationRequest, TextGenerationResult } from '../text-generation-adapter.js';
import { TextGenerationError } from '../text-generation-adapter.js';
import { createOpenAiClient, responseUsage, type OpenAiClientFactory } from './responses-common.js';

/** Streams only the explicitly supplied current text; no provider conversation or tool access. */
export class OpenAiTextAdapter implements TextGenerationAdapter {
  constructor(private readonly clientFactory: OpenAiClientFactory = createOpenAiClient) {}

  async generate(request: TextGenerationRequest, context: TextGenerationContext): Promise<TextGenerationResult> {
    let fullText = '';
    let usage: TextGenerationResult['usage'];
    try {
      const key = context.resolveCredential();
      if (!key || !request.model || !request.text.trim() || request.text.length > 100_000
        || !Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1
        || request.maxOutputTokens > 32_768) throw new Error('invalid_request');
      request.signal?.throwIfAborted();
      const stream = await this.clientFactory(key).responses.create({
        model: request.model, input: request.text, store: false, stream: true,
        max_output_tokens: request.maxOutputTokens,
      }, { signal: request.signal });
      try {
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') {
            if (fullText.length + event.delta.length > 100_000) throw new Error('output_limit');
            fullText += event.delta;
            context.onDelta(event.delta);
          } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            usage = responseUsage(event.response);
            return { fullText, status: event.type === 'response.completed' ? 'completed' : 'incomplete', usage };
          } else if (event.type === 'response.failed') {
            usage = responseUsage(event.response);
            throw new Error('provider_failed');
          } else if (event.type === 'error') throw new Error('provider_failed');
        }
        throw new Error('stream_ended_without_completion');
      } finally { stream.controller.abort(); }
    } catch {
      throw new TextGenerationError({ fullText, status: 'incomplete', usage });
    }
  }
}
