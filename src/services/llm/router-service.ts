// src/services/llm/router-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { VramManager } from './vram-manager.js';
import { RoutingService } from './routing-service.js';
import { WorkerService } from './worker-service.js';
import { ConversationStore, FALLBACK_CONVERSATION_ID } from '../../core/storage/conversation-store.js';
import { buildContextWindow } from './context-window.js';
import { NUM_PREDICT_MAP } from './llm-types.js';

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
  private conversationId: number = FALLBACK_CONVERSATION_ID;
  private startContext: ChatMessage[] = [];
  private persistenceWarned = false;

  constructor(
    private context: AppContext,
    private routerProvider: LlmProvider,
    workerProvider: LlmProvider,
  ) {
    this.vramManager = new VramManager(context.parsedConfig.llm.baseUrl);
    this.routing = new RoutingService(routerProvider);
    this.worker = new WorkerService(workerProvider);
  }

  private initPromise: Promise<void> | null = null;

  // init() is single-flight (A8): repeated calls return the same promise,
  // so the eager boot call and registry.initAll() cannot double-initialize.
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const boot = await new ConversationStore(this.context.db).boot();
    this.conversationId = boot.conversationId;
    this.startContext = boot.startContext.map((row) => ({
      role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: row.content,
    }));

    const available = await this.routerProvider.isAvailable();
    if (!available) {
      this.status = 'error';
      return;
    }
    // Warm router model into VRAM so the first real prompt doesn't pay cold-load cost.
    // Failures are non-fatal — status stays 'running', first real call will retry.
    await this.routing.warmup().catch((err) => {
      console.warn('[Router] Warmup failed (non-fatal):', err);
    });
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
    await this.persistMessage('user', text);

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

    if (result.parsed.kind === 'action') {
      // Task 4 wires the real action branch; until then behave like self-route.
      console.warn('[Router] ACTION tag before action branch exists:', result.parsed.action);
      this.context.bus.emit(this.id, 'llm:chunk', { text: result.parsed.feedback });
      this.context.bus.emit(this.id, 'llm:done', { fullText: result.parsed.feedback });
      this.history.push({ role: 'assistant', content: result.parsed.feedback });
      await this.persistMessage('assistant', result.parsed.feedback);
      return;
    }

    if (result.parsed.route === 'self') {
      this.context.bus.emit(this.id, 'llm:chunk', { text: result.parsed.feedback });
      this.context.bus.emit(this.id, 'llm:done', { fullText: result.parsed.feedback });
      this.history.push({ role: 'assistant', content: result.parsed.feedback });
      await this.persistMessage('assistant', result.parsed.feedback);
      return;
    }

    // Routes: 9b, backend, extern, vision — all go to 9B for now
    const busTarget = result.parsed.route === 'vision' ? '9b' as const : result.parsed.route;
    this.context.bus.emit(this.id, 'llm:routing', {
      from: '2b',
      to: busTarget,
      feedback: result.parsed.feedback,
    });

    const llmConfig = this.context.parsedConfig.llm;
    await this.vramManager.swapModels(llmConfig.routerModel);
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
    const responseStyle = this.context.parsedConfig.personalization.responseStyle;
    const messages = this.buildMessages(systemPrompt, responseStyle);

    const { fullText, tookMs } = await this.worker.stream(messages, responseStyle, (chunk) => {
      this.context.bus.emit(this.id, 'llm:chunk', { text: chunk });
    });
    this.context.bus.emit(this.id, 'perf:timing', { label: 'worker', ms: tookMs });

    this.history.push({ role: 'assistant', content: fullText });
    await this.persistMessage('assistant', fullText);
    this.context.bus.emit(this.id, 'llm:done', { fullText });
  }

  private buildMessages(systemPrompt: string, responseStyle: string): ChatMessage[] {
    return buildContextWindow({
      systemPrompt,
      startContext: this.startContext,
      history: this.history,
      numCtx: this.context.parsedConfig.llm.workerOptions.num_ctx,
      numPredict: NUM_PREDICT_MAP[responseStyle] ?? NUM_PREDICT_MAP.mittel,
    });
  }

  /**
   * Persist a turn message without ever disturbing the answer flow (Spec B, H4):
   * failures are caught, inserts are skipped in in-memory mode, and the user
   * sees exactly one visible warning per run.
   */
  private async persistMessage(role: 'user' | 'assistant', content: string): Promise<void> {
    if (this.conversationId === FALLBACK_CONVERSATION_ID) {
      this.warnPersistenceOnce();
      return;
    }
    try {
      await this.context.db.insert('messages', {
        conversation_id: this.conversationId,
        role,
        content,
      });
    } catch (err) {
      console.warn('[Router] Message persist failed (non-fatal):', err);
      this.warnPersistenceOnce();
    }
  }

  private warnPersistenceOnce(): void {
    if (this.persistenceWarned) return;
    this.persistenceWarned = true;
    this.context.bus.emit(this.id, 'storage:degraded', {
      message: 'Speichern nicht möglich — diese Unterhaltung wird nach einem Neustart vergessen.',
    });
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(async () => {
      const llmConfig = this.context.parsedConfig.llm;
      await this.vramManager.unloadModel(llmConfig.workerModel);
      this.activeModel = '2b';
      // Router was unloaded during the swap to worker — re-warm it so the
      // next prompt doesn't pay another cold-load.
      await this.routing.warmup().catch((err) => {
        console.warn('[Router] Re-warmup after idle swap failed:', err);
      });
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
