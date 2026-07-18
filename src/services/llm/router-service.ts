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
import { isActionName, looksLikeActionCommand } from '../actions/action-schemas.js';
import { getFeedback } from './filler-phrases.js';
import { randomUUID } from 'crypto';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const ERROR_MESSAGES: Record<string, string> = {
  unavailable: 'Sarah träumt noch... Einen Moment.',
  timeout: 'Sarah hat den Faden verloren... Versuch es nochmal.',
  connection: 'Sarah ist kurz weggedriftet. Einen Moment...',
};

export class RouterService implements SarahService {
  readonly id = 'router';
  readonly subscriptions = ['chat:message', 'action:result', 'action:notify'] as const;
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
  private outputQueue: Promise<void> = Promise.resolve();
  private pendingActions = new Map<string, { action: string }>();
  private turnInFlight: Promise<void> | null = null;

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
    this.pendingActions.clear();
    this.history = [];
    this.status = 'stopped';
  }

  onMessage(msg: TypedBusMessage): void {
    if (msg.topic === 'chat:message') {
      const { text, mode } = msg.data;
      this.handleChatMessage(text, mode).catch(() => {
        this.context.bus.emit(this.id, 'llm:error', { message: ERROR_MESSAGES.connection });
      });
    } else if (msg.topic === 'action:result') {
      const { requestId, action, speak } = msg.data;
      const pending = this.pendingActions.get(requestId);
      if (!pending || pending.action !== action) {
        console.warn('[Router] Dropping unknown/stale action:result', requestId, action);
        return;
      }
      this.pendingActions.delete(requestId);
      if (speak) this.speakAfterCurrentTurn(speak);
    } else if (msg.topic === 'action:notify') {
      this.speakAfterCurrentTurn(msg.data.speak);
    }
  }

  /**
   * action:result/action:notify can race in from the bus while a chat turn
   * (routing decision + worker stream) is still running — e.g. a timer firing
   * mid-answer. Wait for the in-flight turn to settle before enqueueing so the
   * notification can never speak ahead of the turn's own response (no
   * interleaved output, Spec §3). Once no turn is in flight, speak right away.
   */
  private speakAfterCurrentTurn(text: string): void {
    const turn = this.turnInFlight;
    if (turn) {
      void turn.finally(() => this.emitAssistantResponse(text));
    } else {
      void this.emitAssistantResponse(text);
    }
  }

  async handleChatMessage(text: string, mode: 'chat' | 'voice' = 'chat'): Promise<void> {
    if (this.status !== 'running') {
      this.context.bus.emit(this.id, 'llm:error', { message: ERROR_MESSAGES.unavailable });
      return;
    }

    this.history.push({ role: 'user', content: text });

    // Claim this turn's slot synchronously (before any await) so a
    // concurrently racing action:result/action:notify (see
    // speakAfterCurrentTurn) waits for this turn instead of jumping ahead.
    const thisTurn = this.runTurn(text, mode);
    this.turnInFlight = thisTurn;
    try {
      await thisTurn;
    } finally {
      if (this.turnInFlight === thisTurn) this.turnInFlight = null;
    }
  }

  private async runTurn(text: string, mode: 'chat' | 'voice'): Promise<void> {
    await this.persistMessage('user', text);

    try {
      if (this.activeModel === '9b') {
        if (looksLikeActionCommand(text)) {
          // Gate (Spec §3): swap the worker out, let the router really decide.
          const llmConfig = this.context.parsedConfig.llm;
          // Bridge the 9B→2B swap pause with a spoken filler (voice only). The
          // routing target isn't known yet at swap start, so use a short/neutral
          // phrase; the real action announcement follows over the normal path.
          if (mode === 'voice') {
            this.context.bus.emit(this.id, 'llm:filler', { text: getFeedback('switchingBack') });
          }
          await this.vramManager.swapModels(llmConfig.workerModel).catch((err) => {
            console.warn('[Router] Gate swap failed (non-fatal, routing anyway):', err);
          });
          this.activeModel = '2b'; // R4-M1: before routeAndRespond; the 9b route re-sets it
          this.clearIdleTimer();
          await this.routeAndRespond(text, mode);
        } else {
          this.resetIdleTimer();
          await this.runWorker(mode);
        }
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
      const { action, param, feedback } = result.parsed;
      if (!isActionName(action)) {
        console.warn('[Router] Unknown action name, refusing:', action, 'raw param:', param);
        await this.emitAssistantResponse('Das kann ich noch nicht.');
        return;
      }
      const requestId = randomUUID();
      this.pendingActions.set(requestId, { action });
      this.context.bus.emit(this.id, 'action:request', { requestId, action, param });
      await this.emitAssistantResponse(feedback);
      return;
    }

    if (result.parsed.route === 'self') {
      await this.emitAssistantResponse(result.parsed.feedback);
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
    // Bridge the 2B→9B swap pause with a spoken filler (voice only), emitted
    // before awaiting the swap so TTS synthesis fills the load time. The real
    // worker answer follows over the normal path.
    if (mode === 'voice') {
      this.context.bus.emit(this.id, 'llm:filler', { text: getFeedback('frontendThinking') });
    }
    await this.vramManager.swapModels(llmConfig.routerModel).catch((err) => {
      console.warn('[Router] Swap failed (non-fatal, worker call proceeds):', err);
    });
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

    // The whole stream is ONE queue job: late action results wait, chunks never interleave.
    await this.enqueueOutput(async () => {
      if (this.status !== 'running') return;
      const { fullText, tookMs } = await this.worker.stream(messages, responseStyle, (chunk) => {
        this.context.bus.emit(this.id, 'llm:chunk', { text: chunk });
      });
      this.context.bus.emit(this.id, 'perf:timing', { label: 'worker', ms: tookMs });
      this.history.push({ role: 'assistant', content: fullText });
      await this.persistMessage('assistant', fullText);
      this.context.bus.emit(this.id, 'llm:done', { fullText });
    });
  }

  /** Serialize every assistant output; a failed job never blocks the queue. */
  private enqueueOutput(job: () => Promise<void>): Promise<void> {
    this.outputQueue = this.outputQueue.then(job).catch((err) => {
      console.warn('[Router] Output job failed:', err);
    });
    return this.outputQueue;
  }

  /**
   * The single exit for assistant text (Spec §3): llm:chunk + llm:done,
   * history.push and persistence via persistMessage — never a raw insert.
   */
  private emitAssistantResponse(text: string): Promise<void> {
    return this.enqueueOutput(async () => {
      if (this.status !== 'running') return; // shutdown guard
      this.context.bus.emit(this.id, 'llm:chunk', { text });
      this.context.bus.emit(this.id, 'llm:done', { fullText: text });
      this.history.push({ role: 'assistant', content: text });
      await this.persistMessage('assistant', text);
    });
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
