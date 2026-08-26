// src/services/llm/router-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { ModelRuntime, type ModelRuntimePort } from './model-runtime.js';
import { ConversationStore, FALLBACK_CONVERSATION_ID } from '../../core/storage/conversation-store.js';
import { buildContextWindow } from './context-window.js';
import { NUM_PREDICT_MAP } from './llm-types.js';
import { isActionName, looksLikeActionCommand } from '../actions/action-schemas.js';
import { getFeedback } from './filler-phrases.js';
import { randomUUID } from 'crypto';
import { MediaContext } from './media-context.js';
import type { MediaAction } from '../actions/media-controller.js';
import { getActionAcknowledgement } from '../actions/action-feedback.js';
import { resolveProfileResponse } from './profile-response.js';
import { resolveSlashCommand } from '../commands/slash-command-resolver.js';
import { WORKER_UNAVAILABLE_MESSAGE } from '../../core/chat-availability.js';

const ERROR_MESSAGES: Record<string, string> = {
  unavailable: 'Sarah träumt noch... Einen Moment.',
  timeout: 'Sarah hat den Faden verloren... Versuch es nochmal.',
  connection: 'Sarah ist kurz weggedriftet. Einen Moment...',
};

export class RouterService implements SarahService {
  readonly id = 'router';
  readonly subscriptions = ['chat:message', 'action:result', 'action:notify'] as const;
  status: ServiceStatus = 'pending';

  private history: ChatMessage[] = [];
  private modelRuntime: ModelRuntimePort;
  private mediaContext: MediaContext;
  private conversationId: number = FALLBACK_CONVERSATION_ID;
  private startContext: ChatMessage[] = [];
  private persistenceWarned = false;
  private outputQueue: Promise<void> = Promise.resolve();
  private pendingActions = new Map<string, { action: string }>();
  private turnInFlight: Promise<void> | null = null;

  constructor(
    private context: AppContext,
    runtimeOrRouterProvider: ModelRuntimePort | LlmProvider,
    workerProviderOrMediaContext?: LlmProvider | MediaContext,
    mediaContext: MediaContext = new MediaContext(),
  ) {
    if ('generateWorkerText' in runtimeOrRouterProvider) {
      this.modelRuntime = runtimeOrRouterProvider;
      this.mediaContext = workerProviderOrMediaContext instanceof MediaContext
        ? workerProviderOrMediaContext
        : mediaContext;
    } else {
      if (!workerProviderOrMediaContext || workerProviderOrMediaContext instanceof MediaContext) {
        throw new Error('RouterService requires a worker provider');
      }
      this.modelRuntime = new ModelRuntime({
        config: context.parsedConfig.llm,
        routerProvider: runtimeOrRouterProvider,
        workerProvider: workerProviderOrMediaContext,
        eagerLoadTransitions: false,
      });
      this.mediaContext = mediaContext;
    }
  }

  /** Legacy UI/test alias; productive lifecycle state uses model roles. */
  get activeModel(): '2b' | '9b' {
    return this.modelRuntime.snapshot.activeRole === 'local_worker' ? '9b' : '2b';
  }

  set activeModel(value: '2b' | '9b') {
    this.modelRuntime.assumeRole(value === '9b' ? 'local_worker' : 'router');
  }

  private initPromise: Promise<void> | null = null;

  // init() is single-flight (A8): repeated calls return the same promise,
  // so the eager boot call and registry.initAll() cannot double-initialize.
  init(signal?: AbortSignal): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit(signal);
    }
    return this.initPromise;
  }

  private async doInit(signal?: AbortSignal): Promise<void> {
    const boot = await new ConversationStore(this.context.db).boot();
    this.conversationId = boot.conversationId;
    this.startContext = boot.startContext.map((row) => ({
      role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: row.content,
    }));

    try {
      await this.modelRuntime.init(signal);
    } catch (err) {
      console.error('[Router] Model runtime init failed:', err);
      this.status = 'error';
      return;
    }
    this.status = 'running';
  }

  async destroy(signal?: AbortSignal): Promise<void> {
    this.pendingActions.clear();
    this.history = [];
    try {
      await this.modelRuntime.destroy(signal);
    } finally {
      this.status = 'stopped';
    }
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

    const command = resolveSlashCommand(
      text,
      this.context.parsedConfig.controls?.customCommands ?? [],
    );
    const effectiveText = command.kind === 'custom' ? command.expandedText : text;
    const immediateResponse = command.kind === 'builtin_unavailable'
      ? `Der Slash-Command ${command.command} ist noch nicht verfügbar.`
      : command.kind === 'unknown'
        ? `Diesen Slash-Command kenne ich nicht: ${command.command}.`
        : null;

    this.history.push({ role: 'user', content: effectiveText });

    // Claim this turn's slot synchronously (before any await) so a
    // concurrently racing action:result/action:notify (see
    // speakAfterCurrentTurn) waits for this turn instead of jumping ahead.
    const thisTurn = immediateResponse
      ? this.runDeterministicTurn(effectiveText, immediateResponse)
      : this.runTurn(effectiveText, mode);
    this.turnInFlight = thisTurn;
    try {
      await thisTurn;
    } finally {
      if (this.turnInFlight === thisTurn) this.turnInFlight = null;
    }
  }

  private async runDeterministicTurn(text: string, response: string): Promise<void> {
    await this.persistMessage('user', text);
    await this.emitAssistantResponse(response);
  }

  private async runTurn(text: string, mode: 'chat' | 'voice'): Promise<void> {
    await this.persistMessage('user', text);

    const profileResponse = resolveProfileResponse(text, this.context.parsedConfig.profile);
    if (profileResponse) {
      await this.emitAssistantResponse(profileResponse);
      return;
    }

    // MediaContext (Layer-1 terse follow-ups) — before any routing so it also
    // fires in the warm-9B window, where terse words bypass the gate.
    const hit = this.mediaContext.resolve(text, Date.now());
    if (hit) {
      const requestId = randomUUID();
      this.pendingActions.set(requestId, { action: hit.action });
      this.context.bus.emit(this.id, 'action:request', { requestId, action: hit.action, param: '' });
      this.mediaContext.record(hit.action, Date.now());
      await this.emitAssistantResponse(hit.speak);
      return;
    }

    try {
      if (this.modelRuntime.snapshot.activeRole === 'local_worker') {
        if (looksLikeActionCommand(text)) {
          // Bridge the 9B→2B swap pause with a spoken filler (voice only). The
          // routing target isn't known yet at swap start, so use a short/neutral
          // phrase; the real action announcement follows over the normal path.
          if (mode === 'voice') {
            this.context.bus.emit(this.id, 'llm:filler', { text: getFeedback('switchingBack') });
          }
          await this.routeAndRespond(text, mode);
        } else {
          await this.runWorker(mode);
        }
      } else {
        await this.routeAndRespond(text, mode);
      }
    } catch (err) {
      if (this.isWorkerUnavailable()) {
        await this.emitAssistantResponse(WORKER_UNAVAILABLE_MESSAGE);
        return;
      }
      const errorKey = err instanceof Error && err.message === 'timeout' ? 'timeout' : 'connection';
      this.context.bus.emit(this.id, 'llm:error', { message: ERROR_MESSAGES[errorKey] });
    }
  }

  private async routeAndRespond(text: string, mode: 'chat' | 'voice'): Promise<void> {
    const result = await this.modelRuntime.route(text);
    if (!this.isOperational()) return;
    this.context.bus.emit(this.id, 'perf:timing', { label: 'router', ms: result.tookMs });

    if (!result.hadTag) {
      console.warn('[Router] No route tag in 2B response, falling back to self');
    }

    if (result.parsed.kind === 'action') {
      const { action, param } = result.parsed;
      if (!isActionName(action)) {
        console.warn('[Router] Unknown action name, refusing:', action, 'raw param:', param);
        await this.emitAssistantResponse('Das kann ich noch nicht.');
        return;
      }
      const requestId = randomUUID();
      this.pendingActions.set(requestId, { action });
      this.context.bus.emit(this.id, 'action:request', { requestId, action, param });
      if (action.startsWith('media_')) this.mediaContext.record(action as MediaAction, Date.now());
      await this.emitAssistantResponse(getActionAcknowledgement(action, param));
      return;
    }

    // Routes: 9b, backend, extern, vision — all go to 9B for now
    const busTarget = result.parsed.route === 'backend' || result.parsed.route === 'extern'
      ? result.parsed.route
      : 'local_worker' as const;
    this.context.bus.emit(this.id, 'llm:routing', {
      from: 'router',
      to: busTarget,
    });

    // Bridge the 2B→9B swap pause with a spoken filler (voice only), emitted
    // before awaiting the swap so TTS synthesis fills the load time. The real
    // worker answer follows over the normal path.
    if (mode === 'voice') {
      this.context.bus.emit(this.id, 'llm:filler', { text: getFeedback('frontendThinking') });
    }
    this.context.bus.emit(this.id, 'llm:model-swap', {
      loading: this.context.parsedConfig.llm.workerModel,
      unloading: this.context.parsedConfig.llm.routerModel,
    });

    await this.runWorker(mode);
  }

  private async runWorker(mode: 'chat' | 'voice'): Promise<void> {
    const systemPrompt = buildSystemPrompt(this.context.parsedConfig, mode);
    const responseStyle = this.context.parsedConfig.personalization.responseStyle;
    const messages = this.buildMessages(systemPrompt, responseStyle);

    // The whole stream is ONE queue job: late action results wait, chunks never interleave.
    await this.enqueueOutput(async () => {
      if (this.status !== 'running') return;
      const { fullText, tookMs } = await this.modelRuntime.streamWorker(messages, responseStyle, (chunk) => {
        if (this.isOperational()) {
          this.context.bus.emit(this.id, 'llm:chunk', { text: chunk });
        }
      });
      if (!this.isOperational()) return;
      this.context.bus.emit(this.id, 'perf:timing', { label: 'worker', ms: tookMs });
      this.history.push({ role: 'assistant', content: fullText });
      await this.persistMessage('assistant', fullText);
      this.context.bus.emit(this.id, 'llm:done', { fullText });
    });
  }

  /** Serialize every assistant output; a failed job never blocks the queue. */
  private enqueueOutput(job: () => Promise<void>): Promise<void> {
    const currentJob = this.outputQueue.then(job);
    this.outputQueue = currentJob.catch((err) => {
      console.warn('[Router] Output job failed:', err);
    });
    return currentJob;
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

  private isOperational(): boolean {
    const lifecycleState = this.context.lifecycle?.snapshot.state;
    return this.status === 'running'
      && lifecycleState !== 'stopping'
      && lifecycleState !== 'stopped';
  }

  private isWorkerUnavailable(): boolean {
    const worker = this.modelRuntime.snapshot.roles.local_worker;
    return worker.availability !== 'available' || worker.residency === 'error';
  }

}
