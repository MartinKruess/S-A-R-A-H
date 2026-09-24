import type { TextGenerationAdapter, TextGenerationContext, TextGenerationRequest, TextGenerationResult } from '../text-generation-adapter.js';
import { nextTextGenerationEvent, TextGenerationError } from '../text-generation-adapter.js';
import { createOpenAiClient, responseUsage, type OpenAiClientFactory } from './responses-common.js';

/** Streams only the explicitly supplied current text; no provider conversation or tool access. */
export class OpenAiTextAdapter implements TextGenerationAdapter {
  constructor(private readonly clientFactory: OpenAiClientFactory = createOpenAiClient,
    private readonly streamTimeoutMs = 30_000) {}

  async generate(request: TextGenerationRequest, context: TextGenerationContext): Promise<TextGenerationResult> {
    let fullText = '';
    let usage: TextGenerationResult['usage'];
    const refusals = new Map<string, string>();
    const deadline = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), this.streamTimeoutMs);
    timer.unref?.();
    const emit = (text: string) => {
      if (fullText.length + text.length > 100_000) throw new Error('output_limit');
      fullText += text;
      if (text) context.onDelta(text);
    };
    const emitRefusal = (outputIndex: number, contentIndex: number, text: string, delta = false) => {
      const id = `${outputIndex}:${contentIndex}`;
      const previous = refusals.get(id) ?? '';
      if (!delta && !text.startsWith(previous)) throw new Error('invalid_refusal');
      refusals.set(id, delta ? previous + text : text);
      emit(delta ? text : text.slice(previous.length));
    };
    try {
      const key = context.resolveCredential();
      if (!key || !request.model || !request.text.trim() || request.text.length > 100_000
        || !Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1
        || request.maxOutputTokens > 32_768) throw new Error('invalid_request');
      signal.throwIfAborted();
      const stream = await this.clientFactory(key).responses.create({
        model: request.model, input: request.text, store: false, stream: true,
        max_output_tokens: request.maxOutputTokens,
      }, { signal });
      try {
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const next = await nextTextGenerationEvent(iterator, signal);
          if (next.done) break;
          signal.throwIfAborted();
          const event = next.value;
          if (event.type === 'response.output_text.delta') {
            emit(event.delta);
          } else if (event.type === 'response.refusal.delta') {
            emitRefusal(event.output_index, event.content_index, event.delta, true);
          } else if (event.type === 'response.refusal.done') {
            emitRefusal(event.output_index, event.content_index, event.refusal);
          } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            usage = responseUsage(event.response);
            for (const [outputIndex, item] of event.response.output.entries()) {
              if (item.type !== 'message') continue;
              for (const [contentIndex, part] of item.content.entries()) {
                if (part.type === 'refusal') emitRefusal(outputIndex, contentIndex, part.refusal);
              }
            }
            if (refusals.size > 0 && !fullText.trim()) emit('Der Anbieter hat diese Anfrage abgelehnt.');
            const status = refusals.size > 0 ? 'refused'
              : event.type === 'response.completed' ? 'completed' : 'incomplete';
            return { fullText, status, usage };
          } else if (event.type === 'response.failed') {
            usage = responseUsage(event.response);
            throw new Error('provider_failed');
          } else if (event.type === 'error') throw new Error('provider_failed');
        }
        throw new Error('stream_ended_without_completion');
      } finally { stream.controller.abort(); }
    } catch {
      throw new TextGenerationError({ fullText, status: 'incomplete', usage });
    } finally { clearTimeout(timer); deadline.abort(); }
  }
}
