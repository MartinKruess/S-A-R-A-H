import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import { buildRoutingPrompt } from './routing-prompt.js';
import { parseRouteTag, type ParsedRoute } from './route-parser.js';
import { chatWithTimeout } from './chat-with-timeout.js';
import { runWithTimeout } from '../../core/abort-utils.js';

export const ROUTER_NUM_PREDICT = 64;
export const ROUTER_DEADLINE_MS = 15_000;

export interface RoutingResult {
  parsed: ParsedRoute;
  tookMs: number;
  hadTag: boolean;
}

export class RoutingService {
  constructor(private provider: LlmProvider) {}

  async route(text: string, signal?: AbortSignal): Promise<RoutingResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildRoutingPrompt() },
      { role: 'user', content: text },
    ];
    const start = performance.now();
    const response = await runWithTimeout(
      (deadlineSignal) => chatWithTimeout(this.provider, messages, () => {}, {
        keep_alive: -1,
        num_predict: ROUTER_NUM_PREDICT,
        temperature: 0,
        signal: deadlineSignal,
      }),
      ROUTER_DEADLINE_MS,
      'Router classification timed out',
      signal,
    );
    const tookMs = Math.round(performance.now() - start);
    const parsed = parseRouteTag(response);
    const hadTag = /^\s*\[(?:ROUTE:\w+|ACTION:[a-z_]+(?::[^\]]*)?)]\s*$/.test(response);
    // Never log raw model output or action parameters: both may contain private
    // user text, including during one-shot or multi-turn incognito requests.
    const decision = parsed.kind === 'action' ? `ACTION ${parsed.action}` : `ROUTE ${parsed.route}`;
    console.log(`[Router] ${decision} (hadTag=${hadTag})`);
    return { parsed, tookMs, hadTag };
  }

  async warmup(signal?: AbortSignal): Promise<void> {
    await this.provider.chat(
      [{ role: 'user', content: 'ok' }],
      () => {},
      { num_predict: 1, keep_alive: -1, signal },
    );
  }
}
