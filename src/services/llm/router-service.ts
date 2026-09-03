// src/services/llm/router-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { BusEvents } from '../../core/bus-events.js';
import type { AppContext } from '../../core/bootstrap.js';
import { DEFAULT_LLM_CONFIG } from '../../core/llm-defaults.js';
import type { LlmProvider } from './llm-provider.interface.js';
import {
  createSensitiveTurnGuard,
  redactSensitiveLiveContext,
} from './sensitive-turn-guard.js';
import { ModelRuntime, type ModelRuntimePort } from './model-runtime.js';
import { ConversationStore, FALLBACK_CONVERSATION_ID } from '../../core/storage/conversation-store.js';
import { Layer2MemoryStore } from '../../core/storage/layer2-memory-store.js';
import { MemoryCurator } from './memory-curator.js';
import { ContextWindowError } from './context-window.js';
import { looksLikeActionCommand, type ActionName } from '../actions/action-schemas.js';
import { getFeedback } from './filler-phrases.js';
import { randomUUID } from 'crypto';
import { MediaContext } from './media-context.js';
import { resolveBrowserResultFollowup } from '../search/browser-result-followup.js';
import {
  createSystemReminderClock,
  type ReminderClock,
} from '../actions/reminder-contract.js';
import { resolveProfileResponse } from './profile-response.js';
import {
  prepareTurnEnvelope,
  type TurnEnvelope,
  type TurnId,
  type TurnMode,
  type TurnRequest,
} from '../../core/turn-contract.js';
import { TurnCoordinator, TurnQueueFullError } from '../../core/turn-coordinator.js';
import {
  throwIfAborted,
} from '../../core/abort-utils.js';
import {
  hasConfiguredMemoryExclusion,
  type TurnPersistencePolicy,
} from '../../core/memory-policy.js';
import { resolveActionConfirmationIntent } from '../../core/action-confirmation.js';
import type { VoiceService } from '../voice/voice-service.js';
import type { RouterHistoryEntry } from './router-context-builder.js';
import { RouterActionFlow } from './router-action-flow.js';
import { memoryAuthorResponse, RouterMemoryFlow } from './router-memory-flow.js';
import {
  RouterTurnPersistence,
  type RouterTurnDraft,
} from './router-turn-persistence.js';
import { RouterWorkerFlow } from './router-worker-flow.js';
import { RouterOutputFlow } from './router-output-flow.js';
import { RouterPersistenceRuntime } from './router-persistence-runtime.js';

const ERROR_MESSAGES: Record<string, string> = {
  unavailable: 'Sarah träumt noch... Einen Moment.',
  timeout: 'Sarah hat den Faden verloren... Versuch es nochmal.',
  connection: 'Sarah ist kurz weggedriftet. Einen Moment...',
  context: 'Die aktuelle Anfrage und Sarahs Einstellungen sind zu umfangreich für das konfigurierte Kontextfenster.',
};


const DEFAULT_MEMORY_POLICY_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_RESULT_TIMEOUT_MS = 35_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const REMEMBER_INTENT_PATTERN = /\b(?:merk(?:e)?\s+dir|erinner(?:e)?\s+dich|behalt(?:e)?\s+(?:das|dies)|speicher(?:e)?\s+(?:dir\s+)?(?:als\s+)?erinnerung)\b/iu;
const EXPLICIT_REMEMBER_PATTERN = /^(?:bitte\s+)?(?:merk(?:e)?\s+dir|behalt(?:e)?\s+(?:das|dies)|speicher(?:e)?\s+(?:dir\s+)?(?:als\s+)?erinnerung)\s*[:,]?\s+([\s\S]+)$/iu;
const MEANINGLESS_MEMORY_PATTERN = /^(?:das|dies|dieses|daran|es)$/iu;
const RESUME_SPEECH_PATTERN = /^[^\p{L}\p{N}]*(?:(?:ich\s+)?bin\s+)?wieder da[^\p{L}\p{N}]*$/u;
export interface RouterServiceOptions {
  memoryPolicyWaitTimeoutMs?: number;
  actionResultTimeoutMs?: number;
  shutdownDrainTimeoutMs?: number;
  reminderClock?: ReminderClock;
}

export class RouterService implements SarahService {
  readonly id = 'router';
  readonly subscriptions = [
    'chat:message',
    'turn:cancel',
    'turn:terminal',
    'action:result',
    'action:notify',
  ] as const;
  status: ServiceStatus = 'pending';

  private history: RouterHistoryEntry[] = [];
  private modelRuntime: ModelRuntimePort;
  private mediaContext: MediaContext;
  private conversationId: number = FALLBACK_CONVERSATION_ID;
  private readonly conversationStore: ConversationStore;
  private readonly memoryStore: Layer2MemoryStore;
  private readonly memoryCurator: MemoryCurator;
  private readonly coordinator = new TurnCoordinator();
  private readonly turnDrafts = new Map<TurnId, RouterTurnDraft>();
  private readonly outputFlow: RouterOutputFlow;
  private readonly actionFlow: RouterActionFlow;
  private readonly memoryFlow: RouterMemoryFlow;
  private readonly turnPersistence: RouterTurnPersistence;
  private readonly workerFlow: RouterWorkerFlow;
  private readonly persistenceRuntime: RouterPersistenceRuntime;
  private lifecycleUnsubscribe: (() => void) | null = null;
  private incognitoActive = false;
  private readonly incognitoHistoryTurnIds = new Set<TurnId>();
  private shuttingDown = false;
  private readonly actionResultTimeoutMs: number;
  private readonly reminderClock: ReminderClock;

  constructor(
    private context: AppContext,
    runtimeOrRouterProvider: ModelRuntimePort | LlmProvider,
    workerProviderOrMediaContext?: LlmProvider | MediaContext,
    mediaContext: MediaContext = new MediaContext(),
    options: RouterServiceOptions = {},
  ) {
    const memoryPolicyWaitTimeoutMs = options.memoryPolicyWaitTimeoutMs
      ?? DEFAULT_MEMORY_POLICY_WAIT_TIMEOUT_MS;
    this.actionResultTimeoutMs = options.actionResultTimeoutMs
      ?? DEFAULT_ACTION_RESULT_TIMEOUT_MS;
    const shutdownDrainTimeoutMs = options.shutdownDrainTimeoutMs
      ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
    this.reminderClock = options.reminderClock ?? createSystemReminderClock();
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
    this.outputFlow = new RouterOutputFlow(
      this.context,
      this.id,
      this.coordinator,
      this.turnDrafts,
      () => this.isOperational(),
    );
    this.actionFlow = new RouterActionFlow({
      context: this.context,
      serviceId: this.id,
      mediaContext: this.mediaContext,
      reminderClock: this.reminderClock,
      actionResultTimeoutMs: this.actionResultTimeoutMs,
      isIncognitoActive: () => this.incognitoActive,
      emitAssistantResponse: (...args) => this.outputFlow.emitAssistantResponse(...args),
      markBrowserSearchIntentTransient: (turnId, action) => {
        this.markBrowserSearchIntentTransient(turnId, action);
      },
    });
    this.conversationStore = new ConversationStore(this.context.db);
    this.memoryStore = new Layer2MemoryStore(this.context.db);
    this.memoryCurator = new MemoryCurator(this.memoryStore, this.modelRuntime, {
      onMemoryChanged: async () => {
        await this.persistenceRuntime.refreshMemoryCache();
      },
      onMaintenanceFailure: () => {
        this.context.bus.emit(this.id, 'storage:degraded', {
          message: 'Eine Erinnerung konnte diesmal nicht aufbereitet werden. Die verschlüsselten Ausgangsdaten bleiben für einen späteren Versuch erhalten.',
        });
      },
      getCurrentPolicy: () => ({
        allowed: this.persistenceRuntime.memoryPolicyReady && this.context.parsedConfig.trust.memoryAllowed,
        exclusions: [...this.context.parsedConfig.trust.memoryExclusions],
      }),
      numCtx: this.context.parsedConfig.llm.workerOptions?.num_ctx
        ?? DEFAULT_LLM_CONFIG.workerOptions.num_ctx,
    });
    this.persistenceRuntime = new RouterPersistenceRuntime({
      context: this.context,
      memoryStore: this.memoryStore,
      memoryCurator: this.memoryCurator,
      coordinator: this.coordinator,
      turnDrafts: this.turnDrafts,
      getHistory: () => this.history,
      setHistory: (history) => { this.history = history; },
      memoryPolicyWaitTimeoutMs,
      shutdownDrainTimeoutMs,
    });
    this.memoryFlow = new RouterMemoryFlow({
      context: this.context,
      memoryStore: this.memoryStore,
      memoryCurator: this.memoryCurator,
      isMemoryPolicyReady: () => this.persistenceRuntime.memoryPolicyReady,
      isIncognitoActive: () => this.incognitoActive,
      getConversationId: () => this.conversationId,
      runMutation: (operation, signal) => this.persistenceRuntime.runMemoryMutation(operation, signal),
      refreshCache: () => this.persistenceRuntime.refreshMemoryCache(),
      warnPersistence: () => this.persistenceRuntime.warnPersistenceOnce(),
      emitAssistantResponse: (...args) => this.outputFlow.emitAssistantResponse(...args),
    });
    this.turnPersistence = new RouterTurnPersistence({
      drafts: this.turnDrafts,
      getHistory: () => this.history,
      setHistory: (history) => { this.history = history; },
      getMemoryPolicyReady: () => this.persistenceRuntime.memoryPolicyReady,
      getLivePolicy: () => ({
        allowed: this.context.parsedConfig.trust.memoryAllowed,
        exclusions: [...this.context.parsedConfig.trust.memoryExclusions],
      }),
      isIncognitoActive: () => this.incognitoActive,
      incognitoTurnIds: this.incognitoHistoryTurnIds,
      persistTurn: (...args) => this.persistenceRuntime.persistTurn(this.conversationId, ...args),
    });
    this.workerFlow = new RouterWorkerFlow({
      context: this.context,
      serviceId: this.id,
      modelRuntime: this.modelRuntime,
      actionFlow: this.actionFlow,
      drafts: this.turnDrafts,
      getHistory: () => this.history,
      getCuratedMemories: () => [...this.persistenceRuntime.curatedMemories],
      waitForMemoryPolicy: (signal) => this.persistenceRuntime.waitForMemoryPolicy(signal),
      enqueueOutput: (job) => this.outputFlow.enqueue(job),
      isTurnOperational: (turnId, signal) => this.outputFlow.isTurnOperational(turnId, signal),
      emitAssistantResponse: (turnId, text, signal) => this.outputFlow.emitAssistantResponse(turnId, text, signal),
      recordAssistantOutput: (turnId, text) => this.outputFlow.recordAssistantOutput(turnId, text),
      isWorkerUnavailable: () => this.isWorkerUnavailable(),
    });
  }

  /** Legacy UI/test alias; productive lifecycle state uses model roles. */
  get activeModel(): '2b' | '9b' {
    return this.modelRuntime.snapshot.activeRole === 'local_worker' ? '9b' : '2b';
  }

  set activeModel(value: '2b' | '9b') {
    this.modelRuntime.assumeRole(value === '9b' ? 'local_worker' : 'router');
  }

  retryRuntimeRecovery(signal?: AbortSignal): Promise<void> {
    return this.modelRuntime.retryRecovery(signal).then(() => undefined);
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
    if (!this.lifecycleUnsubscribe && typeof this.context.lifecycle?.subscribe === 'function') {
      this.lifecycleUnsubscribe = this.context.lifecycle.subscribe((snapshot) => {
        if (snapshot.state === 'stopping' || snapshot.state === 'stopped') {
          this.coordinator.destroy();
        }
      });
    }
    const trust = this.context.parsedConfig.trust;
    await this.persistenceRuntime.initializePolicy();
    const boot = await this.conversationStore.boot({
      memoryAllowed: trust.memoryAllowed,
      memoryExclusions: trust.memoryExclusions,
    });
    this.conversationId = boot.conversationId;
    if (boot.degraded) this.persistenceRuntime.markStorageDegraded();
    await this.persistenceRuntime.recoverMemoryJobs();

    try {
      await this.modelRuntime.init(signal);
    } catch (err) {
      console.error('[Router] Model runtime init failed:', err);
      // ModelRuntime owns a bounded background recheck. Keep the service and
      // its bus subscriptions alive so a recovered runtime becomes usable
      // without rebuilding the registry or restarting the app.
      this.status = 'running';
      return;
    }
    this.status = 'running';
  }

  async destroy(signal?: AbortSignal): Promise<void> {
    this.shuttingDown = true;
    this.lifecycleUnsubscribe?.();
    this.lifecycleUnsubscribe = null;
    const activeTurnId = this.coordinator.activeTurnId;
    this.coordinator.destroy();
    this.persistenceRuntime.abortShutdown();
    this.actionFlow.reset();
    this.turnDrafts.clear();
    this.outputFlow.reset();
    this.history = [];
    this.incognitoActive = false;
    this.incognitoHistoryTurnIds.clear();
    this.memoryFlow.reset();
    this.mediaContext.clear();
    this.context.actionConfirmations.clear();
    try {
      await this.persistenceRuntime.drainPendingWork(activeTurnId, this.outputFlow.pendingOutput, signal);
      await this.memoryCurator.destroy();
      await this.conversationStore.close(this.conversationId);
      await this.modelRuntime.destroy(signal);
    } finally {
      this.status = 'stopped';
    }
  }

  onMessage(msg: TypedBusMessage): void {
    if (msg.topic === 'chat:message') {
      void this.handleTurnRequest(msg.data);
    } else if (msg.topic === 'turn:cancel') {
      this.context.actionConfirmations.invalidateTurn(msg.data.turnId);
      this.actionFlow.clearVisibleSearchForTurn(msg.data.turnId);
      this.coordinator.cancel(msg.data.turnId, msg.data.reason);
    } else if (msg.topic === 'turn:terminal') {
      if (msg.data.status === 'canceled' || msg.data.status === 'error') {
        this.context.actionConfirmations.invalidateTurn(msg.data.turnId);
        this.actionFlow.clearVisibleSearchForTurn(msg.data.turnId);
        this.actionFlow.clearReminderFollowupForTurn(msg.data.turnId);
      }
      if (msg.source !== this.id) {
        this.outputFlow.rememberTerminal(msg.data.turnId);
        this.coordinator.cancel(msg.data.turnId, msg.data.message ?? `Turn ${msg.data.status}`);
      }
    } else if (msg.topic === 'action:result') {
      this.actionFlow.handleActionResult(msg.data);
    } else if (msg.topic === 'action:notify') {
      this.emitSystemNotification(
        msg.data.notificationId,
        msg.data.speak,
        msg.data.kind,
        msg.data.kind === 'timer' ? 'voice' : msg.data.originMode ?? 'voice',
        msg.data.privateContext ?? false,
      );
    }
  }

  /** Publishes deadline speech immediately while keeping its visible output serialized. */
  private emitSystemNotification(
    turnId: TurnId,
    text: string,
    _kind: BusEvents['action:notify']['kind'],
    originMode: TurnMode,
    privateContext: boolean,
  ): void {
    if (!this.isOperational()) return;
    if (!this.context.bus.isTurnKnown(turnId)) {
      const accepted = this.context.bus.emit(this.id, 'turn:accepted', {
        turnId,
        source: 'system',
        mode: originMode,
      });
      if (!accepted) return;
    }
    if (!this.context.bus.isTurnOpen(turnId)) return;

    const outputId = randomUUID();
    const visibleOutput = this.outputFlow.publishAssistantResponse(
      turnId,
      text,
      undefined,
      false,
      false,
      false,
      outputId,
    );
    this.context.bus.emit(this.id, 'turn:output-policy', {
      turnId,
      speech: 'suppress',
    });
    if (originMode === 'voice' && !privateContext) {
      this.context.bus.emit(this.id, 'voice:priority-speech', {
        turnId,
        outputId,
        text,
        priority: 'timer',
        pauseAfter: true,
      });
    }
    void visibleOutput.then(() => {
      if (this.outputFlow.isTurnOperational(turnId)) {
        this.outputFlow.emitTerminal(turnId, 'done');
        this.context.bus.emit(this.id, 'action:notify-accepted', { notificationId: turnId });
      } else if (this.context.bus.isTurnOpen(turnId)) {
        this.outputFlow.emitTerminal(turnId, 'canceled');
      }
    }).catch((error) => {
      if (error instanceof Error && error.name === 'AbortError') {
        this.outputFlow.emitTerminal(turnId, 'canceled');
        return;
      }
      this.outputFlow.emitError(turnId, ERROR_MESSAGES.connection);
      this.outputFlow.emitTerminal(turnId, 'error', ERROR_MESSAGES.connection);
    });
  }

  async handleChatMessage(text: string, mode: TurnMode = 'chat'): Promise<void> {
    const turnId = randomUUID();
    return this.handleTurnRequest({
      turnId,
      source: mode === 'voice' ? 'voice' : 'chat',
      mode,
      originalText: text,
      createdAt: new Date().toISOString(),
    });
  }

  async handleTurnRequest(request: TurnRequest): Promise<void> {
    if (!this.context.bus.isTurnKnown(request.turnId)) {
      const accepted = this.context.bus.emit(this.id, 'turn:accepted', {
        turnId: request.turnId,
        source: request.source,
        mode: request.mode,
      });
      if (!accepted) return;
    }
    if (this.context.bus.isTurnTerminal(request.turnId)) {
      console.warn('[Router] Terminal turn refused:', request.turnId);
      return;
    }
    if (this.outputFlow.hasTerminalTurn(request.turnId) || this.coordinator.hasTurn(request.turnId)) {
      console.warn('[Router] Duplicate turn refused:', request.turnId);
      return;
    }
    if (this.status !== 'running') {
      this.outputFlow.emitError(request.turnId, ERROR_MESSAGES.unavailable);
      this.outputFlow.emitTerminal(request.turnId, 'error', ERROR_MESSAGES.unavailable);
      return;
    }

    const envelope = prepareTurnEnvelope(
      request,
      this.context.parsedConfig.controls?.customCommands ?? [],
    );
    const speechPaused = this.isOperational() && this.isVoiceSpeechPaused();
    if (
      speechPaused
      && request.source === 'voice'
      && request.mode === 'voice'
      && this.isResumeSpeechPhrase(envelope.normalizedText)
    ) {
      this.context.bus.emit(this.id, 'turn:output-policy', {
        turnId: envelope.turnId,
        speech: 'suppress',
      });
      this.context.bus.emit(this.id, 'voice:resume-speech', {});
      this.outputFlow.emitTerminal(envelope.turnId, 'done');
      return;
    }
    if (speechPaused) {
      this.context.bus.emit(this.id, 'voice:discard-paused-speech', {
        preserveTurnId: envelope.turnId,
        reason: 'New user input superseded paused speech',
      });
    }

    this.memoryCurator.cancelForUserInput();
    if (envelope.command.kind === 'memory') {
      this.context.bus.emit(this.id, 'turn:output-policy', {
        turnId: envelope.turnId,
        speech: 'suppress',
      });
    }
    try {
      await this.coordinator.enqueue(envelope, (signal) => this.executeTurn(envelope, signal));
    } catch (error) {
      if (error instanceof TurnQueueFullError) {
        const message = 'Zu viele Anfragen gleichzeitig. Bitte warte kurz.';
        this.outputFlow.emitError(request.turnId, message);
        this.outputFlow.emitTerminal(request.turnId, 'error', message);
      } else if (error instanceof Error && error.name === 'AbortError') {
        this.outputFlow.emitTerminal(request.turnId, 'canceled');
      }
    } finally {
      if (this.persistenceRuntime.memoryPolicyReady && this.context.parsedConfig.trust.memoryAllowed) {
        try {
          if (await this.memoryStore.hasPending()) this.memoryCurator.schedule();
        } catch {
          this.persistenceRuntime.warnPersistenceOnce();
        }
      }
    }
  }

  private async executeTurn(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    const trust = this.context.parsedConfig.trust;
    await this.conversationStore.recordMode(this.conversationId, envelope.mode);
    const togglesIncognito = envelope.command.kind === 'anonymous'
      && envelope.command.arguments.length === 0;
    const managesMemory = envelope.command.kind === 'memory';
    const oneShotAnonymous = envelope.command.kind === 'anonymous'
      && envelope.command.arguments.length > 0
      && trust.anonymousEnabled;
    const privateTurn = this.incognitoActive || oneShotAnonymous;
    const inheritedPrivateContext = this.history.some((entry) => entry.privateContext);
    const sensitiveGuard = createSensitiveTurnGuard(envelope.effectiveText);
    this.turnDrafts.set(envelope.turnId, {
      historyUser: redactSensitiveLiveContext(envelope.effectiveText, sensitiveGuard),
      persistedUser: envelope.originalText,
      assistants: [],
      persistence: {
        allowed: this.persistenceRuntime.memoryPolicyReady
          && trust.memoryAllowed
          && !this.incognitoActive
          && envelope.command.kind !== 'anonymous'
          && !managesMemory,
        exclusions: [...trust.memoryExclusions],
      },
      inheritedTransient: inheritedPrivateContext,
      inheritedPrivateContext,
      externalData: false,
      localData: false,
      workerOutputStarted: false,
      commitStarted: false,
      suppressHistory: togglesIncognito
        || managesMemory
        || (envelope.command.kind === 'anonymous' && !trust.anonymousEnabled),
      privateTurn,
      privateContext: privateTurn || inheritedPrivateContext,
      recalledContents: [],
      sensitiveGuard,
    });
    try {
      throwIfAborted(signal);
      const exitsActiveIncognito = togglesIncognito && this.incognitoActive;
      const entersIncognito = togglesIncognito
        && trust.anonymousEnabled
        && !this.incognitoActive;
      const immediateResponse = envelope.command.kind === 'anonymous'
        && !trust.anonymousEnabled
        && !exitsActiveIncognito
        ? 'Der Anonymous-Modus ist in den Einstellungen deaktiviert.'
        : togglesIncognito
          ? this.toggleIncognito(envelope.turnId)
          : this.incognitoActive && REMEMBER_INTENT_PATTERN.test(envelope.effectiveText)
            ? 'Im Anonymous-Modus kann ich mir nichts merken. Beende ihn zuerst mit /anonymous und wiederhole dann, was ich speichern soll.'
          : envelope.command.kind === 'builtin_unavailable'
        ? `Der Slash-Command ${envelope.command.command} ist noch nicht verfügbar.`
        : envelope.command.kind === 'unknown'
          ? `Diesen Slash-Command kenne ich nicht: ${envelope.command.command}.`
          : null;

      const confirmationIntent = this.context.actionConfirmations.hasSinglePending()
        ? resolveActionConfirmationIntent(envelope.normalizedText)
        : 'none';
      if (
        confirmationIntent === 'none'
        && envelope.command.kind !== 'confirmation'
      ) this.context.actionConfirmations.cancelSinglePending();
      if (envelope.command.kind === 'memory') {
        await this.memoryFlow.handleCommand(envelope, signal);
      } else if (immediateResponse) {
        await this.outputFlow.emitAssistantResponse(envelope.turnId, immediateResponse, signal);
        if (entersIncognito) this.prewarmAnonymousWorker();
      } else if (envelope.command.kind === 'confirmation') {
        await this.actionFlow.confirmAction(envelope, signal);
      } else if (confirmationIntent === 'confirm') {
        await this.actionFlow.confirmSpokenAction(envelope, signal);
      } else if (confirmationIntent === 'cancel') {
        await this.actionFlow.cancelPendingAction(envelope, signal);
      } else if (await this.actionFlow.handleReminderCancelFollowup(envelope, signal)) {
        // A structured ambiguity result authorizes exactly one time-only follow-up.
      } else {
        await this.runTurn(envelope, signal);
      }
      throwIfAborted(signal);
      const draft = this.turnDrafts.get(envelope.turnId);
      if (draft) draft.commitStarted = true;
      await this.turnPersistence.commit(envelope.turnId, signal);
      throwIfAborted(signal);
      this.outputFlow.emitTerminal(envelope.turnId, 'done');
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        this.context.actionConfirmations.invalidateTurn(envelope.turnId);
        const draft = this.turnDrafts.get(envelope.turnId);
        if (draft?.workerOutputStarted && !draft.commitStarted) {
          this.turnPersistence.retainInterruptedUser(envelope.turnId);
        } else {
          this.turnDrafts.delete(envelope.turnId);
        }
        this.outputFlow.emitTerminal(envelope.turnId, 'canceled');
        return;
      }
      this.context.actionConfirmations.invalidateTurn(envelope.turnId);
      this.turnDrafts.delete(envelope.turnId);
      const message = error instanceof ContextWindowError
        ? ERROR_MESSAGES.context
        : error instanceof Error && error.name === 'TimeoutError'
          ? ERROR_MESSAGES.timeout
          : ERROR_MESSAGES.connection;
      this.outputFlow.emitError(envelope.turnId, message);
      this.outputFlow.emitTerminal(envelope.turnId, 'error', message);
    }
  }

  async applyMemoryPolicy(policy: TurnPersistencePolicy): Promise<void> {
    return this.persistenceRuntime.applyMemoryPolicy(policy);
  }

  /** Number of complete/partial live turns retained in RAM for diagnostics. */
  get liveHistoryTurnCount(): number {
    return new Set(this.history.map((entry) => entry.turnId)).size;
  }

  get privacyState(): { incognitoActive: boolean } {
    return { incognitoActive: this.incognitoActive };
  }

  private toggleIncognito(turnId: TurnId): string {
    this.mediaContext.clear();
    this.actionFlow.clearReminderFollowup();
    this.context.actionConfirmations.clear();
    if (!this.incognitoActive) {
      this.incognitoActive = true;
      this.incognitoHistoryTurnIds.clear();
      this.context.bus.emit(this.id, 'privacy:incognito', { active: true, turnId });
      return 'Anonymous-Modus aktiviert. Dieser Abschnitt wird nicht gespeichert. Mit /anonymous beendest du ihn wieder.';
    }

    this.history = this.history.filter((entry) => !this.incognitoHistoryTurnIds.has(entry.turnId));
    this.actionFlow.discardPrivateSearchSessions();
    this.incognitoActive = false;
    this.incognitoHistoryTurnIds.clear();
    this.context.bus.emit(this.id, 'privacy:incognito', { active: false, turnId });
    return 'Anonymous-Modus beendet. Der private Abschnitt wurde verworfen.';
  }

  /**
   * Starts the worker transition after privacy activation without delaying or
   * weakening the authoritative Anonymous state and response.
   *
   * @category Service
   */
  private prewarmAnonymousWorker(): void {
    void this.modelRuntime.ensureRole('local_worker').catch(() => {
      console.warn('[Router] Anonymous worker prewarm failed; continuing without prewarm');
    });
  }

  private async runTurn(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    const { effectiveText: text, mode, turnId } = envelope;
    throwIfAborted(signal);

    const explicitMatch = text.match(EXPLICIT_REMEMBER_PATTERN)?.[1]?.trim();
    const explicitMemory = explicitMatch && envelope.command.kind === 'custom'
      && envelope.command.arguments.length > 0
      ? envelope.command.arguments.trim()
      : explicitMatch;
    if (explicitMemory && !MEANINGLESS_MEMORY_PATTERN.test(explicitMemory)) {
      const draft = this.turnDrafts.get(turnId);
      if (draft) draft.suppressHistory = true;
      if (draft?.privateTurn) {
        await this.outputFlow.emitAssistantResponse(
          turnId,
          'In einer privaten Nachricht kann ich mir nichts merken. Wiederhole das bitte außerhalb von /anonymous.',
          signal,
        );
        return;
      }
      if (!this.context.parsedConfig.trust.memoryAllowed) {
        await this.outputFlow.emitAssistantResponse(turnId, 'Das Gedächtnis ist in den Einstellungen deaktiviert.', signal);
        return;
      }
      if (!this.persistenceRuntime.memoryPolicyReady) {
        await this.outputFlow.emitAssistantResponse(
          turnId,
          'Das Gedächtnis ist wegen eines Speicherfehlers vorübergehend gesperrt.',
          signal,
        );
        return;
      }
      const result = await this.memoryFlow.authorExplicitMemory(turnId, explicitMemory, signal);
      await this.outputFlow.emitAssistantResponse(
        turnId,
        memoryAuthorResponse(result),
        signal,
      );
      return;
    }

    const profileResponse = resolveProfileResponse(text, this.context.parsedConfig.profile);
    if (profileResponse) {
      await this.outputFlow.emitAssistantResponse(turnId, profileResponse, signal);
      return;
    }

    if (this.actionFlow.hasVisibleSearchSession) {
      const browserResult = resolveBrowserResultFollowup(text);
      const searchContextTurnId = this.actionFlow.visibleSearchContextTurnId;
      if (browserResult && searchContextTurnId) {
        await this.actionFlow.dispatchOrRequestConfirmation(
          envelope,
          'show_browser',
          browserResult,
          signal,
          {
            decisionSource: 'deterministic_shortcut',
            interactionContext: {
              kind: 'visible_search_result',
              contextTurnId: searchContextTurnId,
            },
          },
        );
        return;
      }
    }

    // MediaContext (Layer-1 terse follow-ups) — before any routing so it also
    // fires in the warm-9B window, where terse words bypass the gate.
    const hit = this.mediaContext.resolve(text, Date.now());
    if (hit) {
      await this.actionFlow.dispatchOrRequestConfirmation(
        envelope,
        hit.action,
        '',
        signal,
        {
          decisionSource: 'deterministic_shortcut',
          interactionContext: {
            kind: 'media_followup',
            contextTurnId: hit.contextTurnId,
          },
        },
      );
      return;
    }

    if (this.modelRuntime.snapshot.activeRole === 'local_worker') {
      if (looksLikeActionCommand(text)) {
        // Bridge the 9B→2B swap pause with a spoken filler (voice only). The
        // routing target isn't known yet at swap start, so use a short/neutral
        // phrase; the real action announcement follows over the normal path.
        if (mode === 'voice') {
          this.context.bus.emit(this.id, 'llm:filler', { turnId, text: getFeedback('switchingBack') });
        }
        await this.workerFlow.routeAndRespond(envelope, signal);
      } else {
        await this.workerFlow.runWorkerWithFallback(envelope, signal);
      }
    } else {
      await this.workerFlow.routeAndRespond(envelope, signal);
    }
  }

  /** Keeps the tested single-output boundary stable while delegating ownership. */
  private emitAssistantResponse(
    turnId: TurnId,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.outputFlow.emitAssistantResponse(turnId, text, signal);
  }

  private markBrowserSearchIntentTransient(turnId: TurnId, action: ActionName): void {
    if (action !== 'web_search') return;
    const draft = this.turnDrafts.get(turnId);
    if (!draft) return;
    const exclusions = [
      ...draft.persistence.exclusions,
      ...this.context.parsedConfig.trust.memoryExclusions,
    ];
    if (hasConfiguredMemoryExclusion(exclusions, 'Browser-Daten')) {
      draft.persistence.allowed = false;
    }
  }

  /** Compatibility boundary for focused mutation-ordering tests. */
  private runMemoryMutation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.persistenceRuntime.runMemoryMutation(operation, signal);
  }

  /** Compatibility boundary for focused mutation-drain tests. */
  private get memoryMutationQueue(): Promise<void> {
    return this.persistenceRuntime.pendingMutation;
  }

  /** Compatibility boundary for existing Router policy-state diagnostics. */
  private get memoryPolicyReady(): boolean {
    return this.persistenceRuntime.memoryPolicyReady;
  }

  private isOperational(): boolean {
    const lifecycleState = this.context.lifecycle?.snapshot.state;
    return !this.shuttingDown
      && this.status === 'running'
      && lifecycleState !== 'stopping'
      && lifecycleState !== 'stopped';
  }

  private isVoiceSpeechPaused(): boolean {
    const voiceService = this.context.registry.get('voice') as VoiceService | undefined;
    return voiceService?.status === 'running' && voiceService.isSpeechPaused;
  }

  /** Matches the single local Phase-1 resume phrase after whitespace normalization. */
  private isResumeSpeechPhrase(text: string): boolean {
    const normalizedText = text
      .normalize('NFC')
      .toLocaleLowerCase('de-DE')
      .replace(/\s+/gu, ' ')
      .trim();
    return !normalizedText.includes('?') && RESUME_SPEECH_PATTERN.test(normalizedText);
  }

  private isWorkerUnavailable(): boolean {
    const worker = this.modelRuntime.snapshot.roles.local_worker;
    return worker.availability !== 'available' || worker.residency === 'error';
  }

}
