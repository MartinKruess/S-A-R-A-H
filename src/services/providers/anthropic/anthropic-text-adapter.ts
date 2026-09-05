import Anthropic from '@anthropic-ai/sdk';
import type { MessageDeltaUsage, Usage } from '@anthropic-ai/sdk/resources/messages';
import type { SpecialistTaskUsage } from '../../../core/specialist-task.js';
import { TextGenerationError, type TextGenerationAdapter, type TextGenerationContext,
  type TextGenerationRequest, type TextGenerationResult } from '../text-generation-adapter.js';

export type AnthropicClientFactory = (apiKey: string) => Anthropic;
/** Main-only API client: explicit credentials, fixed endpoint and no charged retries. */
export function createAnthropicClient(apiKey: string,
  options: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {}): Anthropic {
  const transport = options.fetchImpl ?? globalThis.fetch;
  return new Anthropic({
    apiKey, authToken: null, logLevel: 'off', baseURL: 'https://api.anthropic.com',
    maxRetries: 0, timeout: options.timeoutMs ?? 30_000,
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'https://api.anthropic.com') throw new Error('provider_origin_denied');
      // SDK environment custom headers are not Sarah configuration or authority.
      const headers = new Headers({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
        'content-type': 'application/json', accept: 'application/json' });
      return transport(input, { ...init, headers, redirect: 'error' });
    },
  });
}

/** Races a body read against the whole-request deadline, not merely response headers. */
async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  let rejectAbort: (() => void) | undefined;
  const abort = new Promise<IteratorResult<T>>((_, reject) => {
    rejectAbort = () => reject(new Error('provider_stream_aborted'));
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try { return await Promise.race([iterator.next(), abort]); }
  finally { if (rejectAbort) signal.removeEventListener('abort', rejectAbort); }
}

/** Text-only Messages implementation; the shared cloud lane owns privacy, lease and accounting. */
export class AnthropicTextAdapter implements TextGenerationAdapter {
  constructor(private readonly clientFactory: AnthropicClientFactory = createAnthropicClient,
    private readonly streamTimeoutMs = 30_000) {}

  async generate(request: TextGenerationRequest, context: TextGenerationContext): Promise<TextGenerationResult> {
    let fullText = '';
    let usage: SpecialistTaskUsage | undefined;
    let uncachedInput: number | undefined;
    let cacheRead: number | undefined;
    let cacheWrite: number | undefined;
    let output: number | undefined;
    let reasoning: number | undefined;
    let started = false;
    let stopReason: string | null = null;
    const blocks = new Set<number>();
    const deadline = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), this.streamTimeoutMs);
    timer.unref?.();
    const updateUsage = (value: Usage | MessageDeltaUsage) => {
      const count = (number: number | null | undefined): number | undefined => {
        if (number === null || number === undefined) return undefined;
        if (!Number.isSafeInteger(number) || number < 0) throw new Error('invalid_usage');
        return number;
      };
      uncachedInput = count(value.input_tokens) ?? uncachedInput;
      cacheRead = count(value.cache_read_input_tokens) ?? cacheRead;
      cacheWrite = count(value.cache_creation_input_tokens) ?? cacheWrite;
      output = count(value.output_tokens) ?? output;
      reasoning = count(value.output_tokens_details?.thinking_tokens) ?? reasoning;
      if (uncachedInput !== undefined && output !== undefined) usage = {
        inputTokens: uncachedInput + (cacheRead ?? 0) + (cacheWrite ?? 0), outputTokens: output,
        ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
        ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}), toolCalls: 0,
      };
    };
    const emit = (text: string) => {
      if (typeof text !== 'string' || fullText.length + text.length > 100_000) throw new Error('invalid_output');
      fullText += text;
      if (text) context.onDelta(text);
    };
    try {
      const credential = context.resolveCredential();
      if (!credential || !/^claude-[a-z0-9.-]{1,190}$/u.test(request.model)
        || !request.text.trim() || request.text.length > 100_000
        || !Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1
        || request.maxOutputTokens > 32_768) throw new Error('invalid_request');
      signal.throwIfAborted();
      const stream = await this.clientFactory(credential).messages.create({
        model: request.model, max_tokens: request.maxOutputTokens, stream: true,
        messages: [{ role: 'user', content: request.text }],
      }, { signal });
      try {
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const next = await nextWithAbort(iterator, signal);
          if (next.done) break;
          const event = next.value;
          signal.throwIfAborted();
          switch (event.type) {
            case 'message_start':
              if (started || event.message.role !== 'assistant') throw new Error('invalid_start');
              started = true;
              updateUsage(event.message.usage);
              break;
            case 'content_block_start':
              if (!started || stopReason || blocks.has(event.index) || event.content_block.type !== 'text') throw new Error('unsupported_content');
              blocks.add(event.index);
              emit(event.content_block.text);
              break;
            case 'content_block_delta':
              if (!blocks.has(event.index) || stopReason || event.delta.type !== 'text_delta') throw new Error('invalid_delta');
              emit(event.delta.text);
              break;
            case 'content_block_stop':
              if (!blocks.delete(event.index)) throw new Error('invalid_block_stop');
              break;
            case 'message_delta':
              if (!started || blocks.size > 0) throw new Error('invalid_message_delta');
              updateUsage(event.usage);
              if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
              break;
            case 'message_stop':
              if (!started || blocks.size > 0 || !stopReason) throw new Error('missing_completion');
              return { fullText, usage, status: ['end_turn', 'stop_sequence'].includes(stopReason) ? 'completed' : 'incomplete' };
            default: break; // Additive events never substitute for a terminal event.
          }
        }
        throw new Error('missing_completion');
      } finally { stream.controller.abort(); }
    } catch { throw new TextGenerationError({ fullText, status: 'incomplete', usage }); }
    finally { clearTimeout(timer); deadline.abort(); }
  }
}
