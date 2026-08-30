import type { ChatMessage, ChatOptions, LlmProvider } from '../llm-provider.interface.js';
import type { OllamaOptions } from '../llm-types.js';
import { linkAbortSignals, throwIfAborted } from '../../../core/abort-utils.js';

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';

  constructor(
    private baseUrl: string,
    private model: string,
    private options?: OllamaOptions,
  ) {}

  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const linked = linkAbortSignals(signal, controller.signal);
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: linked.signal });
      if (!res.ok) return false;
      const data = (await res.json()) as { models: { name: string }[] };
      const requested = this.model.toLowerCase();
      const hasExplicitTag = requested.includes(':');
      const requestedBase = requested.split(':')[0];
      return data.models.some((entry) => {
        const available = entry.name.toLowerCase();
        return hasExplicitTag
          ? available === requested
          : available.split(':')[0] === requestedBase;
      });
    } catch {
      throwIfAborted(signal);
      return false;
    } finally {
      clearTimeout(timeout);
      linked.dispose();
    }
  }

  async chat(
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    options?: ChatOptions,
  ): Promise<string> {
    const requestStartedAt = performance.now();
    let firstChunkAt: number | null = null;
    const mergedOptions = {
      ...this.options,
      ...(options?.num_predict != null && { num_predict: options.num_predict }),
      ...(options?.temperature != null && { temperature: options.temperature }),
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      signal: options?.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        think: false,
        ...(options?.keep_alive != null && { keep_alive: options.keep_alive }),
        ...(Object.keys(mergedOptions).length > 0 && { options: mergedOptions }),
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    }

    if (!res.body) {
      throw new Error('Ollama returned empty response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    let terminalFrameReceived = false;

    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          total_duration?: number;
          load_duration?: number;
          prompt_eval_count?: number;
          prompt_eval_duration?: number;
          eval_count?: number;
          eval_duration?: number;
        };
        const chunk = parsed.message?.content ?? '';
        if (chunk) {
          firstChunkAt ??= performance.now();
          fullText += chunk;
          onChunk(chunk);
        }
        if (parsed.done === true) {
          terminalFrameReceived = true;
          if (process.env.SARAH_PERF_TRACE === '1') {
            const generatedTokens = parsed.eval_count ?? 0;
            const evalSeconds = (parsed.eval_duration ?? 0) / 1_000_000_000;
            console.log(
              '[OllamaPerf]',
              JSON.stringify({
                model: this.model,
                generatedTokens,
                tokensPerSecond: evalSeconds > 0 ? generatedTokens / evalSeconds : null,
                timeToFirstChunkMs:
                  firstChunkAt === null ? null : firstChunkAt - requestStartedAt,
                wallMs: performance.now() - requestStartedAt,
                totalDurationMs: (parsed.total_duration ?? 0) / 1_000_000,
                loadDurationMs: (parsed.load_duration ?? 0) / 1_000_000,
                promptTokens: parsed.prompt_eval_count ?? 0,
                promptEvalMs: (parsed.prompt_eval_duration ?? 0) / 1_000_000,
              }),
            );
          }
        }
      } catch {
        // Ignore malformed intermediate frames. A missing terminal frame still
        // fails the complete response below, so partial output is never accepted.
      }
    };

    while (!terminalFrameReceived) {
      if (options?.signal?.aborted) {
        await reader.cancel();
        throw new Error('aborted');
      }
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        consumeLine(buffer);
        buffer = '';
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        consumeLine(line);
        if (terminalFrameReceived) break;
      }
    }

    if (!terminalFrameReceived) {
      throw new Error('Ollama stream ended before the terminal done frame');
    }

    return fullText;
  }
}
