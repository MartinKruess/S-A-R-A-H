import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import { buildRoutingPrompt } from './routing-prompt.js';
import { parseRouteTag, type ParsedRoute } from './route-parser.js';
import { chatWithTimeout } from './chat-with-timeout.js';

export interface RoutingResult {
  parsed: ParsedRoute;
  tookMs: number;
  hadTag: boolean;
}

export class RoutingService {
  constructor(private provider: LlmProvider) {}

  async route(text: string): Promise<RoutingResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildRoutingPrompt() },
      { role: 'user', content: text },
    ];
    const start = performance.now();
    const response = await chatWithTimeout(this.provider, messages, () => {}, { keep_alive: -1 });
    const tookMs = Math.round(performance.now() - start);
    const parsed = parseRouteTag(response);
    const trimmed = response.trimStart();
    const hadTag = trimmed.startsWith('[ROUTE:') || trimmed.startsWith('[ACTION:');
    return { parsed, tookMs, hadTag };
  }

  async warmup(): Promise<void> {
    await this.provider.chat(
      [{ role: 'user', content: 'ok' }],
      () => {},
      { num_predict: 1, keep_alive: -1 },
    );
  }
}
