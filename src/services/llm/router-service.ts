// src/services/llm/router-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { buildRoutingPrompt } from './routing-prompt.js';
import { parseRouteTag } from './route-parser.js';
import { VramManager } from './vram-manager.js';
import { NUM_PREDICT_MAP } from './llm-types.js';

const MAX_CONTEXT_TOKENS = 120_000;
const CHARS_PER_TOKEN = 4;
const STREAM_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const ERROR_MESSAGES: Record<string, string> = {
  unavailable: 'Sarah träumt noch... Einen Moment.',
  timeout: 'Sarah hat den Faden verloren... Versuch es nochmal.',
  connection: 'Sarah ist kurz weggedriftet. Einen Moment...',
};

export class RouterService implements SarahService {
  readonly id = 'router';
  readonly subscriptions = ['chat:message'] as const;
  status: ServiceStatus = 'pending';
  activeModel: '2b' | '9b' = '2b';

  private history: ChatMessage[] = [];
  private vramManager: VramManager;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private context: AppContext,
    private routerProvider: LlmProvider,
    private workerProvider: LlmProvider,
  ) {
    this.vramManager = new VramManager(context.parsedConfig.llm.baseUrl);
  }

  async init(): Promise<void> {
    const available = await this.routerProvider.isAvailable();
    if (!available) {
      this.status = 'error';
      return;
    }
    this.status = 'running';
  }

  async destroy(): Promise<void> {
    this.clearIdleTimer();
    this.history = [];
    this.status = 'stopped';
  }

  onMessage(msg: TypedBusMessage): void {
    if (msg.topic === 'chat:message') {
      const { text, mode } = msg.data;
      this.handleChatMessage(text, mode).catch(() => {
        this.context.bus.emit(this.id, 'llm:error', { message: ERROR_MESSAGES.connection });
      });
    }
  }

  async handleChatMessage(text: string, mode: 'chat' | 'voice' = 'chat'): Promise<void> {
    if (this.status !== 'running') {
      this.context.bus.emit(this.id, 'llm:error', { message: ERROR_MESSAGES.unavailable });
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: text };
    this.history.push(userMsg);
    await this.context.db.insert('messages', { conversation_id: 1, role: 'user', content: text });

    try {
      if (this.activeModel === '9b') {
        this.resetIdleTimer();
        await this.sendToWorker(text, mode);
      } else {
        await this.routeViaRouter(text, mode);
      }
    } catch (err) {
      const errorKey = err instanceof Error && err.message === 'timeout' ? 'timeout' : 'connection';
      this.context.bus.emit(this.id, 'llm:error', { message: ERROR_MESSAGES[errorKey] });
    }
  }

  private async routeViaRouter(text: string, mode: 'chat' | 'voice'): Promise<void> {
    const routingPrompt = buildRoutingPrompt();
    const messages: ChatMessage[] = [
      { role: 'system', content: routingPrompt },
      { role: 'user', content: text },
    ];

    // Routing calls are NOT stored — we just need the route decision
    const routerResponse = await this.chatWithTimeout(this.routerProvider, messages, () => {});
    const { route, feedback } = parseRouteTag(routerResponse);

    // No-tag fallback: parseRouteTag returns 'self' when no tag found
    if (!routerResponse.trimStart().startsWith('[ROUTE:')) {
      console.warn('[Router] No route tag in 2B response, falling back to self');
    }

    if (route === 'self') {
      // Emit feedback as the response
      this.context.bus.emit(this.id, 'llm:chunk', { text: feedback });
      this.context.bus.emit(this.id, 'llm:done', { fullText: feedback });

      // Store in history and db
      this.history.push({ role: 'assistant', content: feedback });
      await this.context.db.insert('messages', { conversation_id: 1, role: 'assistant', content: feedback });
    } else {
      // Routes: 9b, backend, extern, vision — all go to 9B for now
      // Map 'vision' to '9b' for the bus event (vision not yet a valid routing target)
      const busTarget = route === 'vision' ? '9b' as const : route;
      this.context.bus.emit(this.id, 'llm:routing', {
        from: '2b',
        to: busTarget,
        feedback,
      });

      // Swap VRAM: unload 2B, 9B loads on next chat call
      const llmConfig = this.context.parsedConfig.llm;
      await this.vramManager.swapModels(llmConfig.routerModel, llmConfig.workerModel);
      this.context.bus.emit(this.id, 'llm:model-swap', {
        loading: llmConfig.workerModel,
        unloading: llmConfig.routerModel,
      });

      this.activeModel = '9b';
      this.resetIdleTimer();

      await this.sendToWorker(text, mode);
    }
  }

  private async sendToWorker(text: string, mode: 'chat' | 'voice'): Promise<void> {
    const systemPrompt = buildSystemPrompt(this.context.parsedConfig, mode);
    const messages = this.buildMessages(systemPrompt);
    const responseStyle = this.context.parsedConfig.personalization.responseStyle;
    const numPredict = NUM_PREDICT_MAP[responseStyle] ?? NUM_PREDICT_MAP.mittel;

    const fullText = await this.chatWithTimeout(
      this.workerProvider,
      messages,
      (chunk) => {
        this.context.bus.emit(this.id, 'llm:chunk', { text: chunk });
      },
      { num_predict: numPredict },
    );

    this.history.push({ role: 'assistant', content: fullText });
    await this.context.db.insert('messages', { conversation_id: 1, role: 'assistant', content: fullText });
    this.context.bus.emit(this.id, 'llm:done', { fullText });
  }

  private async chatWithTimeout(
    provider: LlmProvider,
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    options?: { num_predict?: number },
  ): Promise<string> {
    let timeoutId: ReturnType<typeof setTimeout>;
    let rejectTimeout: (err: Error) => void;

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
      timeoutId = setTimeout(() => reject(new Error('timeout')), STREAM_TIMEOUT_MS);
    });

    const chatPromise = provider.chat(messages, (chunk) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => rejectTimeout(new Error('timeout')), STREAM_TIMEOUT_MS);
      onChunk(chunk);
    }, options);

    const result = await Promise.race([chatPromise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  }

  private buildMessages(systemPrompt: string): ChatMessage[] {
    const system: ChatMessage = { role: 'system', content: systemPrompt };
    const systemTokens = this.estimateTokens(systemPrompt);
    const budget = MAX_CONTEXT_TOKENS - systemTokens;
    const trimmed: ChatMessage[] = [];
    let usedTokens = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      const tokens = this.estimateTokens(msg.content);
      if (usedTokens + tokens > budget) break;
      usedTokens += tokens;
      trimmed.unshift(msg);
    }
    return [system, ...trimmed];
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(async () => {
      const llmConfig = this.context.parsedConfig.llm;
      await this.vramManager.unloadModel(llmConfig.workerModel);
      this.activeModel = '2b';
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
