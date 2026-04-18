// src/services/llm/router-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { VramManager } from './vram-manager.js';
import { RoutingService } from './routing-service.js';
import { WorkerService } from './worker-service.js';

const MAX_CONTEXT_TOKENS = 120_000;
const CHARS_PER_TOKEN = 4;
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
  private routing: RoutingService;
  private worker: WorkerService;

  constructor(
    private context: AppContext,
    private routerProvider: LlmProvider,
    workerProvider: LlmProvider,
  ) {
    this.vramManager = new VramManager(context.parsedConfig.llm.baseUrl);
    this.routing = new RoutingService(routerProvider);
    this.worker = new WorkerService(workerProvider);
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

    this.history.push({ role: 'user', content: text });
    await this.context.db.insert('messages', { conversation_id: 1, role: 'user', content: text });

    try {
      if (this.activeModel === '9b') {
        this.resetIdleTimer();
        await this.runWorker(mode);
      } else {
        await this.routeAndRespond(text, mode);
      }
    } catch (err) {
      const errorKey = err instanceof Error && err.message === 'timeout' ? 'timeout' : 'connection';
      this.context.bus.emit(this.id, 'llm:error', { message: ERROR_MESSAGES[errorKey] });
    }
  }

  private async routeAndRespond(text: string, mode: 'chat' | 'voice'): Promise<void> {
    const result = await this.routing.route(text);
    this.context.bus.emit(this.id, 'perf:timing', { label: 'router', ms: result.tookMs });

    if (!result.hadTag) {
      console.warn('[Router] No route tag in 2B response, falling back to self');
    }

    if (result.route === 'self') {
      this.context.bus.emit(this.id, 'llm:chunk', { text: result.feedback });
      this.context.bus.emit(this.id, 'llm:done', { fullText: result.feedback });
      this.history.push({ role: 'assistant', content: result.feedback });
      await this.context.db.insert('messages', { conversation_id: 1, role: 'assistant', content: result.feedback });
      return;
    }

    // Routes: 9b, backend, extern, vision — all go to 9B for now
    const busTarget = result.route === 'vision' ? '9b' as const : result.route;
    this.context.bus.emit(this.id, 'llm:routing', {
      from: '2b',
      to: busTarget,
      feedback: result.feedback,
    });

    const llmConfig = this.context.parsedConfig.llm;
    await this.vramManager.swapModels(llmConfig.routerModel, llmConfig.workerModel);
    this.context.bus.emit(this.id, 'llm:model-swap', {
      loading: llmConfig.workerModel,
      unloading: llmConfig.routerModel,
    });

    this.activeModel = '9b';
    this.resetIdleTimer();
    await this.runWorker(mode);
  }

  private async runWorker(mode: 'chat' | 'voice'): Promise<void> {
    const systemPrompt = buildSystemPrompt(this.context.parsedConfig, mode);
    const messages = this.buildMessages(systemPrompt);
    const responseStyle = this.context.parsedConfig.personalization.responseStyle;

    const { fullText, tookMs } = await this.worker.stream(messages, responseStyle, (chunk) => {
      this.context.bus.emit(this.id, 'llm:chunk', { text: chunk });
    });
    this.context.bus.emit(this.id, 'perf:timing', { label: 'worker', ms: tookMs });

    this.history.push({ role: 'assistant', content: fullText });
    await this.context.db.insert('messages', { conversation_id: 1, role: 'assistant', content: fullText });
    this.context.bus.emit(this.id, 'llm:done', { fullText });
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
