// src/services/llm/router-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { BusEvents } from '../../core/bus-events.js';
import type { AppContext } from '../../core/bootstrap.js';
import { MEMORY_RECOVERY_GUARD_KEY } from '../../core/bootstrap.js';
import { DEFAULT_LLM_CONFIG } from '../../core/llm-defaults.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import {
  appendRuntimeTrustInstructions,
  buildSystemPrompt,
} from './prompt-builder.js';
import { serializePromptData } from './prompt-data.js';
import {
  createSensitiveTurnGuard,
  redactSensitiveLiterals,
  redactSensitiveLiveContext,
  type SensitiveTurnGuard,
} from './sensitive-turn-guard.js';
import { ModelRuntime, type ModelRuntimePort } from './model-runtime.js';
import { ConversationStore, FALLBACK_CONVERSATION_ID } from '../../core/storage/conversation-store.js';
import { Layer2MemoryStore, type CuratedMemoryView } from '../../core/storage/layer2-memory-store.js';
import { MemoryCurator, type MemoryCuratorRunResult } from './memory-curator.js';
import {
  buildContextWindow,
  ContextWindowError,
  MIN_EFFECTIVE_NUM_PREDICT,
  START_CONTEXT_HEADER,
  type ContextWindowInput,
  type ContextWindowPlan,
} from './context-window.js';
import { NUM_PREDICT_MAP } from './llm-types.js';
import {
  ACTION_SCHEMAS,
  isActionName,
  looksLikeActionCommand,
  type ActionName,
} from '../actions/action-schemas.js';
import { evaluateActionPolicy } from '../actions/action-policy.js';
import { getFeedback } from './filler-phrases.js';
import { randomUUID } from 'crypto';
import { MediaContext } from './media-context.js';
import { resolveBrowserResultFollowup } from '../search/browser-result-followup.js';
import type { MediaAction } from '../actions/media-controller.js';
import {
  getActionAcknowledgement,
  getActionConfirmationDescription,
} from '../actions/action-feedback.js';
import {
  parseTimerRequest,
  parseTimerSelector,
  serializeTimerRequest,
} from '../actions/timer-contract.js';
import {
  groundTimerRequest,
  groundTimerSelector,
} from '../actions/timer-grounding.js';
import {
  createSystemReminderClock,
  parseCancelReminderParam,
  parseSetReminderParam,
  serializeCancelReminderParam,
  serializeSetReminderParam,
  type ReminderClock,
} from '../actions/reminder-contract.js';
import {
  groundSetReminderRequest,
  isCancelReminderRequestGrounded,
} from '../actions/reminder-grounding.js';
import { resolveProfileResponse } from './profile-response.js';
import { WORKER_UNAVAILABLE_MESSAGE } from '../../core/chat-availability.js';
import {
  prepareTurnEnvelope,
  type TurnEnvelope,
  type TurnId,
  type TurnMode,
  type TurnRequest,
  type TurnTerminalStatus,
} from '../../core/turn-contract.js';
import { TurnCoordinator, TurnQueueFullError } from '../../core/turn-coordinator.js';
import {
  abortError,
  linkAbortSignals,
  runWithTimeout,
  throwIfAborted,
} from '../../core/abort-utils.js';
import {
  hasConfiguredMemoryExclusion,
  MemoryPolicyApplyError,
  mustKeepTurnTransient,
  type TurnPersistencePolicy,
} from '../../core/memory-policy.js';
import {
  resolveActionConfirmationIntent,
  type ActionConfirmationReference,
  type ConfirmedAction,
} from '../../core/action-confirmation.js';
import type { VoiceService } from '../voice/voice-service.js';

const ERROR_MESSAGES: Record<string, string> = {
  unavailable: 'Sarah träumt noch... Einen Moment.',
  timeout: 'Sarah hat den Faden verloren... Versuch es nochmal.',
  connection: 'Sarah ist kurz weggedriftet. Einen Moment...',
  context: 'Die aktuelle Anfrage und Sarahs Einstellungen sind zu umfangreich für das konfigurierte Kontextfenster.',
};


type HistoryEntry = ChatMessage & {
  turnId: TurnId;
  transient: boolean;
  privateContext: boolean;
  externalData: boolean;
  localData: boolean;
};

const MAX_LIVE_HISTORY_TURNS = 24;
const DEFAULT_MEMORY_POLICY_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_RESULT_TIMEOUT_MS = 35_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const REMINDER_CANCEL_FOLLOWUP_TIMEOUT_MS = 2 * 60_000;
const DELETE_ALL_MEMORY_CONFIRMATION_TIMEOUT_MS = 2 * 60_000;
const REMEMBER_INTENT_PATTERN = /\b(?:merk(?:e)?\s+dir|erinner(?:e)?\s+dich|behalt(?:e)?\s+(?:das|dies)|speicher(?:e)?\s+(?:dir\s+)?(?:als\s+)?erinnerung)\b/iu;
const EXPLICIT_REMEMBER_PATTERN = /^(?:bitte\s+)?(?:merk(?:e)?\s+dir|behalt(?:e)?\s+(?:das|dies)|speicher(?:e)?\s+(?:dir\s+)?(?:als\s+)?erinnerung)\s*[:,]?\s+([\s\S]+)$/iu;
const MEANINGLESS_MEMORY_PATTERN = /^(?:das|dies|dieses|daran|es)$/iu;
const RESUME_SPEECH_PATTERN = /^[^\p{L}\p{N}]*(?:(?:ich\s+)?bin\s+)?wieder da[^\p{L}\p{N}]*$/u;
const REMINDER_CANCEL_TIME_FOLLOWUP_PATTERN = /^(?:(?:die|der)(?:\s+erinnerung)?\s+)?(?:um\s+)?([01]?\d|2[0-3])(?:(?:[.:]\s*([0-5]\d))|(?:\s+uhr(?:\s+([0-5]?\d))?))(?:\s+uhr)?(?:\s+[\p{L}\p{N}][\p{L}\p{N}\s-]*)?[.!?]?$/iu;
const REMINDER_CANCEL_INDEX_WORDS: Readonly<Record<string, number>> = {
  eins: 1,
  erste: 1,
  erster: 1,
  ersten: 1,
  erstes: 1,
  zwei: 2,
  zweite: 2,
  zweiter: 2,
  zweiten: 2,
  zweites: 2,
  drei: 3,
  dritte: 3,
  dritter: 3,
  dritten: 3,
  drittes: 3,
  vier: 4,
  vierte: 4,
  fünf: 5,
  fünfte: 5,
};

function parseReminderCancelFollowupIndex(value: string): number | null {
  const normalized = value.normalize('NFKC')
    .trim()
    .toLocaleLowerCase('de-DE')
    .replace(/[.!?]+$/u, '')
    .replace(/^(?:die|der|das|nummer)\s+/u, '')
    .trim();
  if (/^[1-9]\d*$/u.test(normalized)) return Number(normalized);
  return REMINDER_CANCEL_INDEX_WORDS[normalized] ?? null;
}

function isExplicitReminderCreationIntent(value: string): boolean {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('de-DE');
  if (/\btimers?\b/u.test(normalized)) return false;
  return /\b(?:erinnerung|reminder)\b/u.test(normalized)
    || /\berinner(?:e)?\s+mich\b/u.test(normalized);
}

function reminderFromMisroutedTimer(param: string, userText: string): string | null {
  if (!isExplicitReminderCreationIntent(userText)) return null;
  const timer = parseTimerRequest(param);
  if (!timer?.label || timer.durationSeconds % 60 !== 0) return null;
  return serializeSetReminderParam({
    schedule: { kind: 'after', minutes: timer.durationSeconds / 60 },
    text: timer.label,
  });
}

function timerFromMisroutedReminder(param: string, userText: string): string | null {
  const normalized = userText.normalize('NFKC').toLocaleLowerCase('de-DE');
  if (!/\btimers?\b/u.test(normalized) || /\b(?:erinnerung|reminder)\b/u.test(normalized)) return null;
  const reminder = parseSetReminderParam(param);
  if (!reminder || reminder.schedule.kind !== 'after') return null;
  return serializeTimerRequest({
    durationSeconds: reminder.schedule.minutes * 60,
    label: reminder.text,
  });
}

function reminderCancelFromMisroutedSet(userText: string): string | null {
  const match = /^\s*(?:lösche?|lösch|entferne?|brich|breche)\s+(?:bitte\s+)?(?:die\s+)?erinnerung\s+(.+?)(?:\s+ab)?[.!?]?\s*$/iu.exec(userText);
  if (!match?.[1]) return null;
  return serializeCancelReminderParam({ kind: 'text', text: match[1] });
}

function isActiveReminderListShortcut(userText: string): boolean {
  const normalized = userText.normalize('NFKC')
    .trim()
    .toLocaleLowerCase('de-DE')
    .replace(/[.!?]+$/u, '')
    .trim();
  return /^(?:zeige\s+(?:mir\s+)?)?(?:die\s+)?(?:aktiven?|alle)\s+erinnerung(?:en)?$/u.test(normalized);
}

type ReminderCancelFollowupContext = {
  ownerTurnId: TurnId;
  candidates: Array<{ id: number; dueLocal: string }>;
  expiresAt: number;
};

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

  private history: HistoryEntry[] = [];
  private modelRuntime: ModelRuntimePort;
  private mediaContext: MediaContext;
  private conversationId: number = FALLBACK_CONVERSATION_ID;
  private readonly conversationStore: ConversationStore;
  private readonly memoryStore: Layer2MemoryStore;
  private readonly memoryCurator: MemoryCurator;
  private curatedMemories: CuratedMemoryView[] = [];
  private persistenceWarned = false;
  private outputQueue: Promise<void> = Promise.resolve();
  private readonly coordinator = new TurnCoordinator();
  private readonly terminalTurns = new Set<TurnId>();
  private readonly terminalTurnOrder: TurnId[] = [];
  private readonly errorTurns = new Set<TurnId>();
  private readonly turnDrafts = new Map<TurnId, {
    historyUser: string;
    persistedUser: string;
    assistants: string[];
    persistence: TurnPersistencePolicy;
    inheritedTransient: boolean;
    inheritedPrivateContext: boolean;
    externalData: boolean;
    localData: boolean;
    workerOutputStarted: boolean;
    commitStarted: boolean;
    suppressHistory: boolean;
    privateTurn: boolean;
    privateContext: boolean;
    recalledContents: string[];
    sensitiveGuard: SensitiveTurnGuard;
  }>();
  private pendingActions = new Map<string, {
    turnId: TurnId;
    action: string;
    resolve: (result: BusEvents['action:result']) => void;
  }>();
  private visibleSearchSession: { requestId: string; ownerTurnId: TurnId } | null = null;
  private readonly privateSearchSessionIds = new Set<string>();
  private lifecycleUnsubscribe: (() => void) | null = null;
  private incognitoActive = false;
  private readonly incognitoHistoryTurnIds = new Set<TurnId>();
  private memoryPolicyReady = true;
  private memoryPolicyBarrier: Promise<void> | null = null;
  private memoryMutationQueue: Promise<void> = Promise.resolve();
  private pendingDeleteAllMemories: { ids: number[]; expiresAt: number } | null = null;
  private pendingReminderCancelFollowup: ReminderCancelFollowupContext | null = null;
  private readonly shutdownAbort = new AbortController();
  private shuttingDown = false;
  private readonly memoryPolicyWaitTimeoutMs: number;
  private readonly actionResultTimeoutMs: number;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly reminderClock: ReminderClock;

  constructor(
    private context: AppContext,
    runtimeOrRouterProvider: ModelRuntimePort | LlmProvider,
    workerProviderOrMediaContext?: LlmProvider | MediaContext,
    mediaContext: MediaContext = new MediaContext(),
    options: RouterServiceOptions = {},
  ) {
    this.memoryPolicyWaitTimeoutMs = options.memoryPolicyWaitTimeoutMs
      ?? DEFAULT_MEMORY_POLICY_WAIT_TIMEOUT_MS;
    this.actionResultTimeoutMs = options.actionResultTimeoutMs
      ?? DEFAULT_ACTION_RESULT_TIMEOUT_MS;
    this.shutdownDrainTimeoutMs = options.shutdownDrainTimeoutMs
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
    this.conversationStore = new ConversationStore(this.context.db);
    this.memoryStore = new Layer2MemoryStore(this.context.db);
    this.memoryCurator = new MemoryCurator(this.memoryStore, this.modelRuntime, {
      onMemoryChanged: async () => {
        await this.refreshMemoryCache();
      },
      onMaintenanceFailure: () => {
        this.context.bus.emit(this.id, 'storage:degraded', {
          message: 'Eine Erinnerung konnte diesmal nicht aufbereitet werden. Die verschlüsselten Ausgangsdaten bleiben für einen späteren Versuch erhalten.',
        });
      },
      getCurrentPolicy: () => ({
        allowed: this.memoryPolicyReady && this.context.parsedConfig.trust.memoryAllowed,
        exclusions: [...this.context.parsedConfig.trust.memoryExclusions],
      }),
      numCtx: this.context.parsedConfig.llm.workerOptions?.num_ctx
        ?? DEFAULT_LLM_CONFIG.workerOptions.num_ctx,
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
    try {
      if (trust.memoryAllowed || !this.context.memoryRecoveryGuardActive) {
        await this.memoryStore.applyPolicy({
          allowed: trust.memoryAllowed,
          exclusions: trust.memoryExclusions,
        });
        if (trust.memoryAllowed) await this.clearMemoryRecoveryGuard();
      }
    } catch {
      this.memoryPolicyReady = false;
      this.markStorageDegraded();
      console.warn('[Router] Memory policy cleanup unavailable; persistence disabled for this run');
    }
    const boot = await this.conversationStore.boot({
      memoryAllowed: trust.memoryAllowed,
      memoryExclusions: trust.memoryExclusions,
    });
    this.conversationId = boot.conversationId;
    if (boot.degraded) this.markStorageDegraded();
    if (this.memoryPolicyReady && trust.memoryAllowed) {
      try {
        await this.memoryStore.recoverInterruptedJobs(Date.now(), true);
        await this.memoryStore.recoverFailedJobs();
        await this.refreshMemoryCache();
        if (await this.memoryStore.hasPending()) this.memoryCurator.schedule();
      } catch {
        this.memoryPolicyReady = false;
        this.curatedMemories = [];
        this.markStorageDegraded();
      }
    }

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
    this.shutdownAbort.abort(abortError('Router shutdown started'));
    this.pendingActions.clear();
    this.visibleSearchSession = null;
    this.privateSearchSessionIds.clear();
    this.turnDrafts.clear();
    this.errorTurns.clear();
    this.history = [];
    this.incognitoActive = false;
    this.incognitoHistoryTurnIds.clear();
    this.pendingDeleteAllMemories = null;
    this.pendingReminderCancelFollowup = null;
    this.mediaContext.clear();
    this.context.actionConfirmations.clear();
    try {
      await this.drainPendingWork(activeTurnId, signal);
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
      this.clearVisibleSearchForTurn(msg.data.turnId);
      this.coordinator.cancel(msg.data.turnId, msg.data.reason);
    } else if (msg.topic === 'turn:terminal') {
      if (msg.data.status === 'canceled' || msg.data.status === 'error') {
        this.context.actionConfirmations.invalidateTurn(msg.data.turnId);
        this.clearVisibleSearchForTurn(msg.data.turnId);
        if (this.pendingReminderCancelFollowup?.ownerTurnId === msg.data.turnId) {
          this.pendingReminderCancelFollowup = null;
        }
      }
      if (msg.source !== this.id) {
        this.rememberTerminal(msg.data.turnId);
        this.coordinator.cancel(msg.data.turnId, msg.data.message ?? `Turn ${msg.data.status}`);
      }
    } else if (msg.topic === 'action:result') {
      const { requestId, turnId, action } = msg.data;
      const pending = this.pendingActions.get(requestId);
      if (!pending || pending.action !== action || pending.turnId !== turnId) {
        console.warn('[Router] Dropping unknown/stale action:result', turnId, requestId, action);
        return;
      }
      this.pendingActions.delete(requestId);
      if (action === 'cancel_reminder') {
        this.pendingReminderCancelFollowup = this.createReminderCancelFollowupContext(
          turnId,
          msg.data.reminderCancelAmbiguity,
        );
      }
      pending.resolve(msg.data);
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

  private clearVisibleSearchForTurn(turnId: TurnId): void {
    if (this.visibleSearchSession?.ownerTurnId === turnId) {
      this.visibleSearchSession = null;
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
    const visibleOutput = this.publishAssistantResponse(
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
      if (this.isTurnOperational(turnId)) {
        this.emitTerminal(turnId, 'done');
        this.context.bus.emit(this.id, 'action:notify-accepted', { notificationId: turnId });
      } else if (this.context.bus.isTurnOpen(turnId)) {
        this.emitTerminal(turnId, 'canceled');
      }
    }).catch((error) => {
      if (error instanceof Error && error.name === 'AbortError') {
        this.emitTerminal(turnId, 'canceled');
        return;
      }
      this.emitError(turnId, ERROR_MESSAGES.connection);
      this.emitTerminal(turnId, 'error', ERROR_MESSAGES.connection);
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
    if (this.terminalTurns.has(request.turnId) || this.coordinator.hasTurn(request.turnId)) {
      console.warn('[Router] Duplicate turn refused:', request.turnId);
      return;
    }
    if (this.status !== 'running') {
      this.emitError(request.turnId, ERROR_MESSAGES.unavailable);
      this.emitTerminal(request.turnId, 'error', ERROR_MESSAGES.unavailable);
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
      this.emitTerminal(envelope.turnId, 'done');
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
        this.emitError(request.turnId, message);
        this.emitTerminal(request.turnId, 'error', message);
      } else if (error instanceof Error && error.name === 'AbortError') {
        this.emitTerminal(request.turnId, 'canceled');
      }
    } finally {
      if (this.memoryPolicyReady && this.context.parsedConfig.trust.memoryAllowed) {
        try {
          if (await this.memoryStore.hasPending()) this.memoryCurator.schedule();
        } catch {
          this.warnPersistenceOnce();
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
        allowed: this.memoryPolicyReady
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
        await this.handleMemoryCommand(envelope, signal);
      } else if (immediateResponse) {
        await this.emitAssistantResponse(envelope.turnId, immediateResponse, signal);
        if (entersIncognito) this.prewarmAnonymousWorker();
      } else if (envelope.command.kind === 'confirmation') {
        await this.confirmAction(envelope, signal);
      } else if (confirmationIntent === 'confirm') {
        await this.confirmSpokenAction(envelope, signal);
      } else if (confirmationIntent === 'cancel') {
        await this.cancelPendingAction(envelope, signal);
      } else if (await this.handleReminderCancelFollowup(envelope, signal)) {
        // A structured ambiguity result authorizes exactly one time-only follow-up.
      } else {
        await this.runTurn(envelope, signal);
      }
      throwIfAborted(signal);
      const draft = this.turnDrafts.get(envelope.turnId);
      if (draft) draft.commitStarted = true;
      await this.commitTurn(envelope.turnId, signal);
      throwIfAborted(signal);
      this.emitTerminal(envelope.turnId, 'done');
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        this.context.actionConfirmations.invalidateTurn(envelope.turnId);
        const draft = this.turnDrafts.get(envelope.turnId);
        if (draft?.workerOutputStarted && !draft.commitStarted) {
          this.retainInterruptedUserContext(envelope.turnId);
        } else {
          this.turnDrafts.delete(envelope.turnId);
        }
        this.emitTerminal(envelope.turnId, 'canceled');
        return;
      }
      this.context.actionConfirmations.invalidateTurn(envelope.turnId);
      this.turnDrafts.delete(envelope.turnId);
      const message = error instanceof ContextWindowError
        ? ERROR_MESSAGES.context
        : error instanceof Error && error.name === 'TimeoutError'
          ? ERROR_MESSAGES.timeout
          : ERROR_MESSAGES.connection;
      this.emitError(envelope.turnId, message);
      this.emitTerminal(envelope.turnId, 'error', message);
    }
  }

  async applyMemoryPolicy(policy: TurnPersistencePolicy): Promise<void> {
    this.memoryPolicyReady = false;
    let releasePolicyBarrier!: () => void;
    const policyBarrier = new Promise<void>((resolve) => { releasePolicyBarrier = resolve; });
    this.memoryPolicyBarrier = policyBarrier;
    try {
      const activeTurnId = this.coordinator.activeTurnId;
      const recalledContents = activeTurnId
        ? this.turnDrafts.get(activeTurnId)?.recalledContents ?? []
        : [];
      if (activeTurnId && recalledContents.length > 0
        && mustKeepTurnTransient(recalledContents, policy)) {
        this.coordinator.cancel(activeTurnId, 'Memory policy became more restrictive');
        await this.coordinator.waitForTurn(activeTurnId);
      }
      await this.runMemoryMutation(async () => {
        await this.memoryCurator.cancelAndWait();
        if (policy.allowed || !this.context.memoryRecoveryGuardActive) {
          await this.memoryStore.applyPolicy(policy);
        }
        const byTurn = new Map<TurnId, HistoryEntry[]>();
        for (const entry of this.history) {
          const entries = byTurn.get(entry.turnId) ?? [];
          entries.push(entry);
          byTurn.set(entry.turnId, entries);
        }
        const excluded = new Set<TurnId>();
        for (const [turnId, entries] of byTurn) {
          if (mustKeepTurnTransient(
            entries.map((entry) => entry.content),
            { allowed: true, exclusions: policy.exclusions },
          )) excluded.add(turnId);
        }
        this.history = this.history.filter((entry) => !excluded.has(entry.turnId));
        if (policy.allowed) await this.refreshMemoryCache();
        else this.curatedMemories = [];
        this.memoryPolicyReady = true;
        if (policy.allowed) await this.clearMemoryRecoveryGuard();
      });
    } catch (error) {
      this.memoryPolicyReady = false;
      this.curatedMemories = [];
      this.warnPersistenceOnce();
      throw new MemoryPolicyApplyError(
        `Memory policy cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      releasePolicyBarrier();
      if (this.memoryPolicyBarrier === policyBarrier) this.memoryPolicyBarrier = null;
    }
  }

  private async clearMemoryRecoveryGuard(): Promise<void> {
    if (!this.context.memoryRecoveryGuardActive) return;
    this.context.memoryRecoveryGuardActive = false;
    try {
      await this.context.config.set(MEMORY_RECOVERY_GUARD_KEY, false);
    } catch (error) {
      // The in-memory policy is authoritative for this run. A stale persisted
      // guard is conservative and will be retried after the next successful boot.
      console.warn('[Router] Memory recovery guard could not be cleared:', error);
    }
  }

  /** Number of complete/partial live turns retained in RAM for diagnostics. */
  get liveHistoryTurnCount(): number {
    return new Set(this.history.map((entry) => entry.turnId)).size;
  }

  get privacyState(): { incognitoActive: boolean } {
    return { incognitoActive: this.incognitoActive };
  }

  private async handleMemoryCommand(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    if (envelope.command.kind !== 'memory') return;
    const trust = this.context.parsedConfig.trust;
    if (this.incognitoActive) {
      await this.emitAssistantResponse(
        envelope.turnId,
        'Im Anonymous-Modus kann ich Erinnerungen weder anzeigen noch verändern. Beende ihn zuerst mit /anonymous.',
        signal,
      );
      return;
    }
    if (!trust.memoryAllowed) {
      await this.emitAssistantResponse(envelope.turnId, 'Das Gedächtnis ist in den Einstellungen deaktiviert.', signal);
      return;
    }
    if (!this.memoryPolicyReady) {
      await this.emitAssistantResponse(
        envelope.turnId,
        'Das Gedächtnis ist wegen eines Speicherfehlers vorübergehend gesperrt.',
        signal,
      );
      return;
    }

    const { command, arguments: args } = envelope.command;
    if (command === '/showcontext') {
      if (!trust.showContextEnabled) {
        await this.emitAssistantResponse(envelope.turnId, '/showcontext ist in den Einstellungen deaktiviert.', signal);
        return;
      }
      const memories = await this.memoryStore.listWithTopics({ includeDeleted: true });
      const byTopic = new Map<string, typeof memories>();
      for (const memory of memories) {
        const key = `${memory.topic.id}:${memory.topic.title}`;
        byTopic.set(key, [...(byTopic.get(key) ?? []), memory]);
      }
      const text = memories.length === 0
        ? 'Ich habe derzeit keine kuratierten Erinnerungen gespeichert.'
        : [...byTopic]
          .map(([topicKey, topicMemories]) => {
            const title = topicKey.slice(topicKey.indexOf(':') + 1);
            return [`## ${title}`, ...topicMemories.map((memory) => {
              const status = memory.deleted_at !== null || memory.status === 'deleted'
                ? 'deleted'
                : memory.status;
              return `${memory.id} [${memory.kind}, ${status}, Revision ${memory.revision}] ${memory.content} `
                + `(Quelle: Session ${memory.source_conversation_id ?? 'unbekannt'}, Turn ${memory.source_turn_id}, ${memory.created_at})`;
            })].join('\n');
          }).join('\n\n');
      await this.emitAssistantResponse(envelope.turnId, text, signal);
      return;
    }
    if (command === '/exportmemory') {
      if (!trust.showContextEnabled) {
        await this.emitAssistantResponse(envelope.turnId, '/exportmemory ist in den Einstellungen deaktiviert.', signal);
        return;
      }
      const memories = await this.memoryStore.listWithTopics({ includeDeleted: true });
      await this.emitAssistantResponse(envelope.turnId, JSON.stringify({
        exportedAt: new Date().toISOString(),
        memories: memories.map((memory) => ({
          id: memory.id,
          kind: memory.kind,
          content: memory.content,
          topic: memory.topic,
          status: memory.deleted_at !== null ? 'deleted' : memory.status,
          revision: memory.revision,
          supersededBy: memory.superseded_by_id,
          deletedAt: memory.deleted_at,
          evidence: {
            excerpt: memory.evidence,
            confirmationCount: memory.confirmation_count,
            lastConfirmedAt: memory.last_confirmed_at,
            sources: memory.sources.map((source) => ({
              type: source.source_type,
              conversationId: source.source_conversation_id,
              turnId: source.source_turn_id,
              observedAt: source.observed_at,
            })),
          },
          source: {
            conversationId: memory.source_conversation_id,
            turnId: memory.source_turn_id,
            createdAt: memory.created_at,
          },
        })),
      }, null, 2), signal);
      return;
    }
    if (command === '/remember') {
      const result = await this.authorExplicitMemory(envelope.turnId, args, signal);
      await this.emitAssistantResponse(
        envelope.turnId,
        this.memoryAuthorResponse(result),
        signal,
      );
      return;
    }

    if (command === '/deletememory' && /^all(?:\s|$)/iu.test(args)) {
      const operation = args.slice(3).trim().toLowerCase();
      if (operation === 'abbrechen' || operation === 'cancel') {
        this.pendingDeleteAllMemories = null;
        await this.emitAssistantResponse(envelope.turnId, 'Das Löschen aller Erinnerungen wurde abgebrochen.', signal);
        return;
      }
      if (operation === 'bestätigen' || operation === 'confirm') {
        const pending = this.pendingDeleteAllMemories;
        this.pendingDeleteAllMemories = null;
        if (!pending || pending.expiresAt < Date.now()) {
          await this.emitAssistantResponse(
            envelope.turnId,
            'Es gibt keine gültige Löschanfrage. Starte sie erneut mit /deletememory all.',
            signal,
          );
          return;
        }
        try {
          const deleted = await this.runMemoryMutation(
            () => this.memoryStore.deleteAll(pending.ids),
            signal,
          );
          await this.refreshMemoryCache();
          await this.emitAssistantResponse(
            envelope.turnId,
            `${deleted} kuratierte ${deleted === 1 ? 'Erinnerung wurde' : 'Erinnerungen wurden'} endgültig gelöscht.`,
            signal,
          );
        } catch (error) {
          if (error instanceof Error
            && error.message === 'Curated memories changed after deletion was requested') {
            await this.emitAssistantResponse(
              envelope.turnId,
              'Die Erinnerungen haben sich seit der Anfrage geändert. Es wurde nichts gelöscht. Starte /deletememory all erneut.',
              signal,
            );
            return;
          }
          throw error;
        }
        return;
      }
      if (operation !== '') {
        await this.emitAssistantResponse(
          envelope.turnId,
          'Nutze /deletememory all, danach /deletememory all bestätigen oder /deletememory all abbrechen.',
          signal,
        );
        return;
      }
      const memories = await this.memoryStore.list({ includeDeleted: true });
      if (memories.length === 0) {
        this.pendingDeleteAllMemories = null;
        await this.emitAssistantResponse(envelope.turnId, 'Es sind keine kuratierten Erinnerungen gespeichert.', signal);
        return;
      }
      this.pendingDeleteAllMemories = {
        ids: memories.map(({ id }) => id),
        expiresAt: Date.now() + DELETE_ALL_MEMORY_CONFIRMATION_TIMEOUT_MS,
      };
      await this.emitAssistantResponse(
        envelope.turnId,
        `Alle ${memories.length} kuratierten Erinnerungen endgültig löschen? `
          + 'Bestätige mit /deletememory all bestätigen oder brich mit /deletememory all abbrechen ab.',
        signal,
      );
      return;
    }

    const match = args.match(/^(\d+)(?:\s+([\s\S]+))?$/u);
    const id = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      await this.emitAssistantResponse(envelope.turnId, 'Bitte gib eine gültige Erinnerungs-ID an.', signal);
      return;
    }
    const changed = await this.runMemoryMutation(() => command === '/correctmemory'
      ? this.memoryStore.correct(
        id,
        match?.[2] ?? '',
        { allowed: true, exclusions: trust.memoryExclusions },
      )
      : command === '/forget'
        ? this.memoryStore.forget(id)
        : this.memoryStore.delete(id), signal);
    if (changed) await this.refreshMemoryCache();
    await this.emitAssistantResponse(
      envelope.turnId,
      changed ? `Erinnerung ${id} wurde aktualisiert.` : `Erinnerung ${id} wurde nicht gefunden oder konnte nicht geändert werden.`,
      signal,
    );
  }

  private toggleIncognito(turnId: TurnId): string {
    this.mediaContext.clear();
    this.pendingReminderCancelFollowup = null;
    this.context.actionConfirmations.clear();
    if (!this.incognitoActive) {
      this.incognitoActive = true;
      this.incognitoHistoryTurnIds.clear();
      this.context.bus.emit(this.id, 'privacy:incognito', { active: true, turnId });
      return 'Anonymous-Modus aktiviert. Dieser Abschnitt wird nicht gespeichert. Mit /anonymous beendest du ihn wieder.';
    }

    this.history = this.history.filter((entry) => !this.incognitoHistoryTurnIds.has(entry.turnId));
    for (const requestId of this.privateSearchSessionIds) {
      this.context.bus.emit(this.id, 'search:discard-session', { requestId });
    }
    if (this.visibleSearchSession
      && this.privateSearchSessionIds.has(this.visibleSearchSession.requestId)) {
      this.visibleSearchSession = null;
    }
    this.privateSearchSessionIds.clear();
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
        await this.emitAssistantResponse(
          turnId,
          'In einer privaten Nachricht kann ich mir nichts merken. Wiederhole das bitte außerhalb von /anonymous.',
          signal,
        );
        return;
      }
      if (!this.context.parsedConfig.trust.memoryAllowed) {
        await this.emitAssistantResponse(turnId, 'Das Gedächtnis ist in den Einstellungen deaktiviert.', signal);
        return;
      }
      if (!this.memoryPolicyReady) {
        await this.emitAssistantResponse(
          turnId,
          'Das Gedächtnis ist wegen eines Speicherfehlers vorübergehend gesperrt.',
          signal,
        );
        return;
      }
      const result = await this.authorExplicitMemory(turnId, explicitMemory, signal);
      await this.emitAssistantResponse(
        turnId,
        this.memoryAuthorResponse(result),
        signal,
      );
      return;
    }

    const profileResponse = resolveProfileResponse(text, this.context.parsedConfig.profile);
    if (profileResponse) {
      await this.emitAssistantResponse(turnId, profileResponse, signal);
      return;
    }

    if (this.visibleSearchSession) {
      const browserResult = resolveBrowserResultFollowup(text);
      if (browserResult) {
        await this.dispatchOrRequestConfirmation(envelope, 'show_browser', browserResult, signal);
        return;
      }
    }

    // MediaContext (Layer-1 terse follow-ups) — before any routing so it also
    // fires in the warm-9B window, where terse words bypass the gate.
    const hit = this.mediaContext.resolve(text, Date.now());
    if (hit) {
      await this.dispatchOrRequestConfirmation(envelope, hit.action, '', signal);
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
        await this.routeAndRespond(envelope, signal);
      } else {
        await this.runWorkerWithFallback(envelope, signal);
      }
    } else {
      await this.routeAndRespond(envelope, signal);
    }
  }

  private async routeAndRespond(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    const { effectiveText: text, mode, turnId } = envelope;
    if (isActiveReminderListShortcut(envelope.normalizedText)) {
      await this.dispatchOrRequestConfirmation(
        envelope,
        'list_reminders',
        'upcoming',
        signal,
      );
      return;
    }
    const result = await this.modelRuntime.route(text, signal);
    if (!this.isTurnOperational(turnId, signal)) return;
    this.context.bus.emit(this.id, 'perf:timing', { turnId, label: 'router', ms: result.tookMs });

    if (!result.hadTag) {
      console.warn('[Router] No route tag in 2B response, falling back to self');
    }

    if (result.parsed.kind === 'action') {
      const { action, param } = result.parsed;
      if (!isActionName(action)) {
        console.warn('[Router] Unknown action name refused');
        await this.emitAssistantResponse(turnId, 'Das kann ich noch nicht.', signal);
        return;
      }
      const explicitCancelReminderParam = reminderCancelFromMisroutedSet(envelope.effectiveText);
      const reminderParam = action === 'set_timer'
        ? reminderFromMisroutedTimer(param, envelope.effectiveText)
        : null;
      const timerParam = action === 'set_reminder'
        ? timerFromMisroutedReminder(param, envelope.effectiveText)
        : null;
      await this.dispatchOrRequestConfirmation(
        envelope,
        explicitCancelReminderParam
          ? 'cancel_reminder'
          : reminderParam
            ? 'set_reminder'
            : timerParam
              ? 'set_timer'
              : action,
        explicitCancelReminderParam ?? reminderParam ?? timerParam ?? param,
        signal,
      );
      return;
    }

    // Routes: 9b, backend, extern, vision — all go to 9B for now
    const busTarget = result.parsed.route === 'backend' || result.parsed.route === 'extern'
      ? result.parsed.route
      : 'local_worker' as const;
    this.context.bus.emit(this.id, 'llm:routing', {
      turnId,
      from: 'router',
      to: busTarget,
    });

    // Bridge the 2B→9B swap pause with a spoken filler (voice only), emitted
    // before awaiting the swap so TTS synthesis fills the load time. The real
    // worker answer follows over the normal path.
    if (mode === 'voice') {
      this.context.bus.emit(this.id, 'llm:filler', { turnId, text: getFeedback('frontendThinking') });
    }
    this.context.bus.emit(this.id, 'llm:model-swap', {
      turnId,
      loading: this.context.parsedConfig.llm.workerModel,
      unloading: this.context.parsedConfig.llm.routerModel,
    });

    await this.runWorkerWithFallback(envelope, signal);
  }

  private async runWorkerWithFallback(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    let outputStarted = false;
    try {
      await this.runWorker(envelope, signal, () => {
        outputStarted = true;
        const draft = this.turnDrafts.get(envelope.turnId);
        if (draft) draft.workerOutputStarted = true;
      });
    } catch (error) {
      throwIfAborted(signal);
      if (outputStarted) throw error;
      if (!this.isWorkerUnavailable()) throw error;
      await this.emitAssistantResponse(envelope.turnId, WORKER_UNAVAILABLE_MESSAGE, signal);
    }
  }

  private async runWorker(
    envelope: TurnEnvelope,
    signal: AbortSignal,
    onOutputStarted?: () => void,
  ): Promise<void> {
    const { turnId, mode } = envelope;
    await this.waitForMemoryPolicy(signal);
    const systemPrompt = buildSystemPrompt(this.context.parsedConfig, mode);
    const responseStyle = this.context.parsedConfig.personalization.responseStyle;
    const { messages, numPredict } = this.buildMessages(
      turnId,
      systemPrompt,
      responseStyle,
      envelope.effectiveText,
    );
    const outputId = randomUUID();
    let sequence = 0;
    const sensitiveGuard = this.turnDrafts.get(turnId)?.sensitiveGuard
      ?? { hasSensitiveInput: false, literals: [] };
    const bufferSensitiveOutput = sensitiveGuard.literals.length > 0;

    // The whole stream is ONE queue job: late action results wait, chunks never interleave.
    await this.enqueueOutput(async () => {
      if (!this.isTurnOperational(turnId, signal)) return;
      const { fullText, tookMs } = await this.modelRuntime.streamWorker(messages, responseStyle, (chunk) => {
        if (bufferSensitiveOutput) return;
        if (this.isTurnOperational(turnId, signal)) {
          onOutputStarted?.();
          this.context.bus.emit(this.id, 'llm:chunk', {
            turnId,
            outputId,
            sequence: sequence++,
            text: chunk,
          });
        }
      }, signal, numPredict);
      if (!this.isTurnOperational(turnId, signal)) return;
      const protectedFullText = redactSensitiveLiterals(fullText, sensitiveGuard);
      if (bufferSensitiveOutput && protectedFullText) {
        onOutputStarted?.();
        this.context.bus.emit(this.id, 'llm:chunk', {
          turnId,
          outputId,
          sequence: sequence++,
          text: protectedFullText,
        });
      }
      this.context.bus.emit(this.id, 'perf:timing', { turnId, label: 'worker', ms: tookMs });
      this.recordAssistantOutput(turnId, protectedFullText);
      if (!this.isTurnOperational(turnId, signal)) return;
      this.context.bus.emit(this.id, 'llm:done', {
        turnId,
        outputId,
        sequence,
        fullText: protectedFullText,
      });
    });
  }

  /** Serialize every assistant output; a failed job never blocks the queue. */
  private enqueueOutput(job: () => Promise<void>): Promise<void> {
    const currentJob = this.outputQueue.then(job);
    this.outputQueue = currentJob.catch((err) => {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.warn('[Router] Output job failed:', err);
    });
    return currentJob;
  }

  /** The single exit for assistant text: output first, draft-owned recording only. */
  private emitAssistantResponse(
    turnId: TurnId,
    text: string,
    signal?: AbortSignal,
    recordInHistory = true,
    externalData = false,
    localData = false,
    outputId = randomUUID(),
  ): Promise<void> {
    return this.enqueueOutput(() => this.publishAssistantResponse(
      turnId,
      text,
      signal,
      recordInHistory,
      externalData,
      localData,
      outputId,
    ));
  }

  private async publishAssistantResponse(
    turnId: TurnId,
    text: string,
    signal: AbortSignal | undefined,
    recordInHistory: boolean,
    externalData: boolean,
    localData: boolean,
    outputId: string,
  ): Promise<void> {
    if (!this.isTurnOperational(turnId, signal)) return;
    const sensitiveGuard = this.turnDrafts.get(turnId)?.sensitiveGuard;
    const protectedText = sensitiveGuard ? redactSensitiveLiterals(text, sensitiveGuard) : text;
    this.context.bus.emit(this.id, 'llm:chunk', {
      turnId,
      outputId,
      sequence: 0,
      text: protectedText,
    });
    this.context.bus.emit(this.id, 'llm:done', {
      turnId,
      outputId,
      sequence: 1,
      fullText: protectedText,
    });
    this.recordAssistantOutput(turnId, protectedText, externalData, localData);
    if (!this.turnDrafts.has(turnId) && recordInHistory) {
      console.warn('[Router] Refused to record assistant output without an active turn draft');
    }
  }

  private async dispatchAction(
    envelope: TurnEnvelope,
    action: ActionName,
    param: string,
    acknowledgement: string,
    signal: AbortSignal,
    confirmation?: ActionConfirmationReference,
    confirmedSourceRequestId?: string,
  ): Promise<void> {
    const actionService = this.context.registry.get('actions');
    if (!actionService || actionService.status !== 'running') {
      await this.emitAssistantResponse(
        envelope.turnId,
        'Aktionen sind gerade nicht verfügbar. Bitte versuche es gleich noch einmal.',
        signal,
      );
      return;
    }
    this.markBrowserSearchIntentTransient(envelope.turnId, action);
    await this.emitAssistantResponse(envelope.turnId, acknowledgement, signal);
    throwIfAborted(signal);
    const requestId = randomUUID();
    const privateSearch = action === 'web_search'
      && (this.incognitoActive || envelope.command.kind === 'anonymous');
    if (privateSearch) this.privateSearchSessionIds.add(requestId);
    if (action === 'web_search') {
      // A new search owns the visible-result pointer. If it fails or is
      // canceled, a later "erstes Ergebnis" must not reopen stale results.
      this.visibleSearchSession = null;
    }
    const resultPromise = new Promise<BusEvents['action:result']>((resolve) => {
      this.pendingActions.set(requestId, { turnId: envelope.turnId, action, resolve });
    });
    this.context.bus.emit(this.id, 'action:request', {
      turnId: envelope.turnId,
      requestId,
      action,
      param,
      originMode: envelope.mode,
      privateContext: this.incognitoActive || envelope.command.kind === 'anonymous',
      ...((confirmedSourceRequestId || (action === 'show_browser' && this.visibleSearchSession))
        ? { sourceRequestId: confirmedSourceRequestId ?? this.visibleSearchSession?.requestId }
        : {}),
      ...(confirmation ? { confirmation } : {}),
    });
    try {
      const result = await runWithTimeout(
        () => resultPromise,
        this.actionResultTimeoutMs,
        'Action timed out',
        signal,
      );
      throwIfAborted(signal);
      if (result.ok && action.startsWith('media_')) {
        this.mediaContext.record(action as MediaAction, Date.now());
      }
      if (action === 'web_search' && result.ok) {
        if (privateSearch && !this.incognitoActive) {
          this.visibleSearchSession = null;
        } else {
          this.visibleSearchSession = { requestId, ownerTurnId: envelope.turnId };
        }
      }
      if (result.speak) {
        const reminderStoreData = action === 'list_reminders' || action === 'cancel_reminder';
        await this.emitAssistantResponse(
          envelope.turnId,
          result.speak,
          signal,
          true,
          action === 'web_search' || action === 'show_browser',
          action === 'open_program' || reminderStoreData,
        );
      }
    } catch (error) {
      this.context.bus.emit(this.id, 'action:cancel', {
        turnId: envelope.turnId,
        requestId,
        reason: error instanceof Error ? error.message : 'Action canceled',
      });
      throw error;
    } finally {
      this.pendingActions.delete(requestId);
      if (privateSearch && !this.incognitoActive) {
        this.context.bus.emit(this.id, 'search:discard-session', { requestId });
        this.privateSearchSessionIds.delete(requestId);
        if (this.visibleSearchSession?.requestId === requestId) this.visibleSearchSession = null;
      }
    }
  }

  private async dispatchOrRequestConfirmation(
    envelope: TurnEnvelope,
    action: ActionName,
    param: string,
    signal: AbortSignal,
    reminderCancelFollowupId?: number,
  ): Promise<void> {
    let groundedParam = param;
    if (action === 'set_timer') {
      const request = parseTimerRequest(param);
      const canonical = request
        ? groundTimerRequest(request, envelope.effectiveText)
        : null;
      if (!canonical) {
        await this.emitAssistantResponse(
          envelope.turnId,
          'Ich konnte die Timerdauer nicht eindeutig aus deiner Anfrage übernehmen.',
          signal,
        );
        return;
      }
      groundedParam = canonical;
    } else if (action === 'cancel_timer') {
      const selector = parseTimerSelector(param);
      const canonical = selector
        ? groundTimerSelector(selector, envelope.effectiveText)
        : null;
      if (!canonical) {
        await this.emitAssistantResponse(
          envelope.turnId,
          'Diesen Timer kann ich aus deiner Angabe nicht eindeutig zuordnen.',
          signal,
        );
        return;
      }
      groundedParam = canonical;
    }
    if (action === 'set_reminder') {
      const request = parseSetReminderParam(param);
      const grounding = request
        ? groundSetReminderRequest(request, envelope.effectiveText, this.reminderClock)
        : null;
      if (!grounding?.ok) {
        const response = grounding?.reason === 'non_future_time'
          ? 'Der genannte Zeitpunkt liegt bereits in der Vergangenheit. Bitte nenne einen zukünftigen Zeitpunkt.'
          : grounding?.reason === 'ungrounded_text'
            ? 'Ich konnte den Inhalt der Erinnerung nicht eindeutig aus deiner Anfrage übernehmen. Bitte nenne Zeitpunkt und Inhalt noch einmal zusammen.'
            : grounding?.reason === 'ungrounded_time'
              ? 'Ich konnte den genannten Zeitpunkt nicht sicher zuordnen. Bitte nenne Zeitpunkt und Inhalt noch einmal zusammen.'
              : 'Bitte nenne den vollständigen Erinnerungswunsch mit eindeutigem Zeitpunkt und Inhalt.';
        await this.emitAssistantResponse(
          envelope.turnId,
          response,
          signal,
        );
        return;
      }
      groundedParam = grounding.canonicalParam;
    } else if (action === 'cancel_reminder') {
      const request = parseCancelReminderParam(param);
      const groundedByFollowupContext = request?.kind === 'id'
        && request.id === reminderCancelFollowupId;
      const canonical = request && (
        groundedByFollowupContext
        || isCancelReminderRequestGrounded(request, envelope.effectiveText)
      )
        ? serializeCancelReminderParam(request)
        : null;
      if (!canonical) {
        await this.emitAssistantResponse(
          envelope.turnId,
          'Diese Erinnerung kann ich aus deiner Angabe nicht eindeutig zuordnen.',
          signal,
        );
        return;
      }
      groundedParam = canonical;
    }
    const parsed = ACTION_SCHEMAS[action].safeParse(groundedParam);
    if (!parsed.success) {
      await this.emitAssistantResponse(envelope.turnId, 'Das kann ich noch nicht.', signal);
      return;
    }
    const validatedParam = String(parsed.data);
    const validatedAcknowledgement = getActionAcknowledgement(action, validatedParam);
    this.markBrowserSearchIntentTransient(envelope.turnId, action);
    const trust = this.context.parsedConfig.trust;
    const policy = evaluateActionPolicy(action, {
      confirmationLevel: trust.confirmationLevel,
      fileAccess: trust.fileAccess,
      webAccessAllowed: trust.webAccessAllowed,
      param: validatedParam,
    });
    if (policy.effect === 'deny') {
      await this.emitAssistantResponse(
        envelope.turnId,
        policy.reason === 'web_access_disabled'
          ? 'Der Browserzugriff ist in den Einstellungen deaktiviert.'
          : 'Diese Aktion ist durch deine Berechtigungen gesperrt.',
        signal,
      );
      return;
    }
    if (policy.effect === 'prepare_only') {
      await this.emitAssistantResponse(
        envelope.turnId,
        'Ich kann diese Aktion nur vorbereiten, aber nicht verbindlich ausführen.',
        signal,
      );
      return;
    }
    if (policy.effect === 'confirm') {
      const sourceRequestId = action === 'show_browser'
        ? this.visibleSearchSession?.requestId
        : undefined;
      const confirmationId = this.context.actionConfirmations.request(
        envelope.turnId,
        action,
        validatedParam,
        sourceRequestId,
      );
      const description = getActionConfirmationDescription(action, validatedParam);
      const spokenConfirmationPrompt = `Soll ich ${description}? Sage oder schreibe „Bestätigen“ oder „Abbrechen“.`;
      const confirmationPrompt = `${spokenConfirmationPrompt} Alternativ im Textchat: /confirm ${confirmationId}`;
      if (envelope.mode === 'voice') {
        // Keep the technical fallback visible without making TTS read a UUID.
        this.context.bus.emit(this.id, 'turn:output-policy', {
          turnId: envelope.turnId,
          speech: 'suppress',
        });
        this.context.bus.emit(this.id, 'llm:filler', {
          turnId: envelope.turnId,
          text: spokenConfirmationPrompt,
        });
      }
      await this.emitAssistantResponse(
        envelope.turnId,
        confirmationPrompt,
        signal,
      );
      return;
    }
    await this.dispatchAction(envelope, action, validatedParam, validatedAcknowledgement, signal);
  }

  private createReminderCancelFollowupContext(
    ownerTurnId: TurnId,
    ambiguity: BusEvents['action:result']['reminderCancelAmbiguity'],
  ): ReminderCancelFollowupContext | null {
    if (!ambiguity || ambiguity.candidates.length < 2) return null;
    const candidates: Array<{ id: number; dueLocal: string }> = [];
    const ids = new Set<number>();
    for (const candidate of ambiguity.candidates) {
      if (
        !Number.isSafeInteger(candidate.id)
        || candidate.id <= 0
        || ids.has(candidate.id)
        || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/u.test(candidate.dueLocal)
      ) return null;
      ids.add(candidate.id);
      candidates.push({ id: candidate.id, dueLocal: candidate.dueLocal });
    }
    return {
      ownerTurnId,
      candidates,
      expiresAt: this.reminderClock.nowMs() + REMINDER_CANCEL_FOLLOWUP_TIMEOUT_MS,
    };
  }

  private async handleReminderCancelFollowup(
    envelope: TurnEnvelope,
    signal: AbortSignal,
  ): Promise<boolean> {
    const context = this.pendingReminderCancelFollowup;
    if (!context) return false;
    if (this.reminderClock.nowMs() > context.expiresAt) {
      this.pendingReminderCancelFollowup = null;
      return false;
    }
    const followupText = envelope.effectiveText.trim();
    const selectedIndex = parseReminderCancelFollowupIndex(followupText);
    const timeMatch = selectedIndex === null
      ? REMINDER_CANCEL_TIME_FOLLOWUP_PATTERN.exec(followupText)
      : null;
    if (selectedIndex === null && !timeMatch) {
      this.pendingReminderCancelFollowup = null;
      return false;
    }

    if (selectedIndex !== null) {
      const candidate = context.candidates[selectedIndex - 1];
      if (!candidate) {
        await this.emitAssistantResponse(
          envelope.turnId,
          `Es gibt keine Erinnerung mit der Nummer ${selectedIndex} in dieser Auswahl.`,
          signal,
        );
        return true;
      }
      this.pendingReminderCancelFollowup = null;
      await this.dispatchOrRequestConfirmation(
        envelope,
        'cancel_reminder',
        `id=${candidate.id}`,
        signal,
        candidate.id,
      );
      return true;
    }

    if (!timeMatch) return true;
    const hour = timeMatch[1].padStart(2, '0');
    const minute = (timeMatch[2] ?? timeMatch[3] ?? '00').padStart(2, '0');
    const matches = context.candidates.filter((candidate) => candidate.dueLocal.endsWith(`T${hour}:${minute}`));
    if (matches.length !== 1) {
      await this.emitAssistantResponse(
        envelope.turnId,
        matches.length === 0
          ? 'Zu dieser Uhrzeit finde ich unter den genannten Erinnerungen keine passende.'
          : 'Zu dieser Uhrzeit gibt es weiterhin mehrere passende Erinnerungen.',
        signal,
      );
      return true;
    }

    const [candidate] = matches;
    if (!candidate) return true;
    this.pendingReminderCancelFollowup = null;
    await this.dispatchOrRequestConfirmation(
      envelope,
      'cancel_reminder',
      `id=${candidate.id}`,
      signal,
      candidate.id,
    );
    return true;
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

  private async confirmAction(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    const confirmed = this.context.actionConfirmations.approve(
      envelope.command.kind === 'confirmation' ? envelope.command.arguments : '',
      envelope.turnId,
    );
    if (!confirmed) {
      await this.emitAssistantResponse(
        envelope.turnId,
        'Diese Bestätigung ist ungültig oder abgelaufen.',
        signal,
      );
      return;
    }
    await this.executeConfirmedAction(envelope, confirmed, signal);
  }

  private async confirmSpokenAction(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    const confirmed = this.context.actionConfirmations.approveSpoken(
      envelope.normalizedText,
      envelope.turnId,
    );
    if (!confirmed) {
      await this.emitAssistantResponse(
        envelope.turnId,
        'Die Sprachbestätigung ist nicht eindeutig oder bereits abgelaufen. Nutze im Textchat die konkrete /confirm-ID.',
        signal,
      );
      return;
    }
    await this.executeConfirmedAction(envelope, confirmed, signal);
  }

  private async cancelPendingAction(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    const canceled = this.context.actionConfirmations.cancelSinglePending();
    await this.emitAssistantResponse(
      envelope.turnId,
      canceled ? 'Die Aktion wurde abgebrochen.' : 'Es ist keine eindeutige Aktion zum Abbrechen offen.',
      signal,
    );
  }

  private async executeConfirmedAction(
    envelope: TurnEnvelope,
    confirmed: ConfirmedAction,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.dispatchConfirmedAction(envelope, confirmed, signal);
    } catch (error) {
      this.context.actionConfirmations.restorePending(confirmed);
      throw error;
    }
  }

  private async dispatchConfirmedAction(
    envelope: TurnEnvelope,
    confirmed: ConfirmedAction,
    signal: AbortSignal,
  ): Promise<void> {
    if (!isActionName(confirmed.action)) {
      await this.emitAssistantResponse(envelope.turnId, 'Diese Bestätigung ist ungültig.', signal);
      return;
    }
    await this.dispatchAction(
      envelope,
      confirmed.action,
      confirmed.param,
      getActionAcknowledgement(confirmed.action, confirmed.param),
      signal,
      confirmed.confirmation,
      confirmed.sourceRequestId,
    );
  }

  private buildMessages(
    turnId: TurnId,
    systemPrompt: string,
    responseStyle: string,
    currentUser: string,
  ): ContextWindowPlan {
    const trust = this.context.parsedConfig.trust;
    const startContext: ChatMessage[] = trust.memoryAllowed
      ? this.retrieveStartContext(currentUser)
      : [];
    const protectedSystemPrompt = appendRuntimeTrustInstructions(systemPrompt, {
      external: this.history.some((entry) => entry.externalData),
      local: this.history.some((entry) => entry.localData),
    });
    const preparedHistory = this.history.map((entry): ChatMessage => ({
      role: entry.role,
      content: entry.externalData
        ? serializePromptData('external_search_data', { content: entry.content })
        : entry.localData
          ? serializePromptData('local_program_data', { content: entry.content })
          : entry.content,
    }));
    const contextInput: ContextWindowInput = {
      systemPrompt: protectedSystemPrompt,
      startContext,
      history: [...preparedHistory, { role: 'user', content: currentUser }],
      numCtx: this.context.parsedConfig.llm.workerOptions.num_ctx,
      numPredict: NUM_PREDICT_MAP[responseStyle] ?? NUM_PREDICT_MAP.mittel,
    };
    const includesTransientHistory = (messages: readonly ChatMessage[]): boolean => (
      preparedHistory.some((prepared, index) => (
        messages.includes(prepared)
        && (this.history[index].transient
          || this.history[index].externalData
          || this.history[index].localData)
      ))
    );
    const includesPrivateHistory = (messages: readonly ChatMessage[]): boolean => (
      preparedHistory.some((prepared, index) => (
        messages.includes(prepared) && this.history[index].privateContext
      ))
    );
    let plan = buildContextWindow(contextInput, { includeEffectiveNumPredict: true });
    if (this.history.some((entry) => entry.privateContext)
      && !includesPrivateHistory(plan.messages)) {
      // A directly dependent answer must see the newest private/live-only turn.
      // Reduce answer capacity before silently dropping that privacy context.
      plan = buildContextWindow({
        ...contextInput,
        numPredict: MIN_EFFECTIVE_NUM_PREDICT,
      }, { includeEffectiveNumPredict: true });
    }
    const { messages } = plan;
    const draft = this.turnDrafts.get(turnId);
    if (draft) {
      draft.recalledContents = [
        ...startContext.map((message) => message.content),
        ...preparedHistory.flatMap((prepared, index) => (
          messages.includes(prepared) ? [this.history[index].content] : []
        )),
      ];
      // Prompt trimming must never make a live-only dependency persistable.
      draft.inheritedTransient = draft.inheritedTransient || includesTransientHistory(messages);
    }
    return plan;
  }

  private retrieveStartContext(query: string): ChatMessage[] {
    const queryTokens = this.retrievalTokens(query);
    if (queryTokens.size === 0) return [];
    const ranked = this.curatedMemories
      .map((memory) => {
        const topicTokens = this.retrievalTokens(memory.topic.title ?? '');
        const memoryTokens = this.retrievalTokens(memory.content);
        let topicScore = 0;
        let contentScore = 0;
        for (const token of queryTokens) {
          if (topicTokens.has(token)) topicScore += token.length >= 7 ? 2 : 1;
          if (memoryTokens.has(token)) contentScore += token.length >= 7 ? 2 : 1;
        }
        return { memory, topicScore, contentScore, score: topicScore * 100 + contentScore };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.id - left.memory.id)
      .slice(0, 5);

    if (ranked.length === 0) return [];
    return [
      { role: 'system', content: START_CONTEXT_HEADER },
      ...ranked.map(({ memory }): ChatMessage => ({
        role: 'system',
        content: serializePromptData('recalled_memory_data', {
          id: memory.id,
          kind: memory.kind,
          topic: memory.topic.title,
          revision: memory.revision,
          createdAt: memory.created_at,
          content: memory.content,
        }),
      })),
    ];
  }

  private retrievalTokens(value: string): Set<string> {
    const stopWords = new Set(['aber', 'dass', 'diese', 'dieser', 'einen', 'eine', 'einer', 'haben', 'mein', 'meine', 'nicht', 'oder', 'sarah', 'über', 'und', 'was', 'wie']);
    return new Set(
      (value.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('de-DE').match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter((token) => token.length >= 3 && !stopWords.has(token)),
    );
  }

  /** Stages and reconciles an explicit memory through the same bounded Memory Author path. */
  private async authorExplicitMemory(
    turnId: TurnId,
    content: string,
    signal: AbortSignal,
  ): Promise<MemoryCuratorRunResult> {
    throwIfAborted(signal);
    const trust = this.context.parsedConfig.trust;
    const policy: TurnPersistencePolicy = {
      allowed: this.memoryPolicyReady && trust.memoryAllowed && !this.incognitoActive,
      exclusions: [...trust.memoryExclusions],
    };
    if (mustKeepTurnTransient([content], policy)) return { status: 'blocked' };
    if (this.conversationId === FALLBACK_CONVERSATION_ID) {
      this.warnPersistenceOnce();
      return { status: 'failed' };
    }
    try {
      return await this.runMemoryMutation(async () => {
        await this.memoryCurator.cancelAndWait();
        throwIfAborted(signal);
        const stagingId = await this.memoryStore.stageTurn(
          this.conversationId,
          turnId,
          [{ role: 'user', content }],
          policy,
        );
        if (stagingId == null) return { status: 'blocked' } as const;
        return this.memoryCurator.runStaging(stagingId, signal);
      }, signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      console.warn('[Router] Explicit Memory Author reconciliation failed');
      this.warnPersistenceOnce();
      return { status: 'failed' };
    }
  }

  private memoryAuthorResponse(result: MemoryCuratorRunResult): string {
    if (result.status === 'blocked') return 'Das kann ich aus Datenschutzgründen nicht als Erinnerung übernehmen.';
    if (result.status !== 'applied') {
      return 'Ich konnte das gerade nicht zuverlässig einordnen. Es wurde keine neue Erinnerung bestätigt.';
    }
    const { action, memoryId } = result.result;
    if (action === 'ignore') return 'Das war bereits passend gespeichert; es wurde kein Duplikat angelegt.';
    const id = memoryId == null ? '' : ` ${memoryId}`;
    const descriptions = {
      add: `Erinnerung${id} wurde thematisch eingeordnet.`,
      update: `Erinnerung${id} wurde mit dem vorhandenen Wissen aktualisiert.`,
      merge: `Erinnerung${id} wurde mit passenden Einträgen zusammengeführt.`,
      supersede: `Erinnerung${id} ersetzt die veraltete Aussage.`,
    } as const;
    return descriptions[action];
  }

  private async refreshMemoryCache(): Promise<void> {
    this.curatedMemories = await this.memoryStore.listWithTopics();
  }

  private warnPersistenceOnce(): void {
    this.markStorageDegraded();
    if (this.persistenceWarned) return;
    this.persistenceWarned = true;
    this.context.bus.emit(this.id, 'storage:degraded', {
      message: 'Speichern nicht möglich — diese Unterhaltung wird nach einem Neustart vergessen.',
    });
  }

  private recordAssistantOutput(
    turnId: TurnId,
    text: string,
    externalData = false,
    localData = false,
  ): void {
    const draft = this.turnDrafts.get(turnId);
    if (!draft) return;
    draft.assistants.push(text);
    if (externalData) draft.externalData = true;
    if (localData) draft.localData = true;
  }

  private async commitTurn(turnId: TurnId, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const draft = this.turnDrafts.get(turnId);
    if (!draft) return;
    if (draft.suppressHistory) {
      throwIfAborted(signal);
      this.turnDrafts.delete(turnId);
      return;
    }
    const liveTrust = this.context.parsedConfig.trust;
    const effectivePolicy: TurnPersistencePolicy = {
      allowed: draft.persistence.allowed && this.memoryPolicyReady && liveTrust.memoryAllowed,
      exclusions: [...new Set([...draft.persistence.exclusions, ...liveTrust.memoryExclusions])],
    };
    const transient = draft.inheritedTransient || draft.externalData || draft.localData || mustKeepTurnTransient(
      [draft.persistedUser, draft.historyUser, ...draft.assistants],
      effectivePolicy,
    );
    if (!transient) {
      await this.persistTurn(turnId, [
        { role: 'user', content: draft.persistedUser },
        ...draft.assistants.map((content) => ({ role: 'assistant' as const, content })),
      ], effectivePolicy, signal);
    }
    throwIfAborted(signal);
    if (draft.inheritedTransient && !this.incognitoActive) {
      // Consume old private/external sources after one dependent turn, but retain
      // the completed dependent turn as transient live context. This preserves
      // follow-up continuity without laundering it into persistent memory.
      this.history = this.history.filter((entry) => (
        !entry.transient && !entry.externalData && !entry.localData
      ));
    }
    if (draft.inheritedPrivateContext && !this.incognitoActive) {
      // One one-shot Anonymous turn may inform one follow-up. Its derived
      // response is not retained, preventing permanent transience propagation.
      this.turnDrafts.delete(turnId);
      return;
    }
    this.history.push({
      turnId,
      role: 'user',
      content: draft.historyUser,
      transient,
      privateContext: draft.privateContext,
      externalData: false,
      localData: false,
    });
    for (const content of draft.assistants) {
      this.history.push({
        turnId,
        role: 'assistant',
        content,
        transient,
        privateContext: draft.privateContext,
        externalData: draft.externalData && content === draft.assistants[draft.assistants.length - 1],
        localData: draft.localData && content === draft.assistants[draft.assistants.length - 1],
      });
    }
    if (draft.privateTurn && this.incognitoActive) {
      this.incognitoHistoryTurnIds.add(turnId);
    }
    this.trimLiveHistory();
    this.turnDrafts.delete(turnId);
  }

  /** Retain only the user's live-session context after an interrupted worker response. */
  private retainInterruptedUserContext(turnId: TurnId): void {
    const draft = this.turnDrafts.get(turnId);
    if (!draft) return;
    this.turnDrafts.delete(turnId);
    const transient = draft.inheritedTransient || draft.externalData || draft.localData || mustKeepTurnTransient(
      [draft.persistedUser, draft.historyUser],
      draft.persistence,
    );
    this.history.push({
      turnId,
      role: 'user',
      content: draft.historyUser,
      transient,
      privateContext: draft.privateContext,
      externalData: false,
      localData: false,
    });
    if (draft.privateTurn && this.incognitoActive) {
      this.incognitoHistoryTurnIds.add(turnId);
    }
    this.trimLiveHistory();
  }

  private markStorageDegraded(): void {
    this.context.lifecycle?.setCapability(
      'storage',
      'degraded',
      'Speichern nicht möglich — neue Unterhaltungen bleiben nur bis zum Neustart erhalten.',
    );
  }

  private trimLiveHistory(): void {
    const turnIds: TurnId[] = [];
    for (const entry of this.history) {
      if (turnIds[turnIds.length - 1] !== entry.turnId) turnIds.push(entry.turnId);
    }
    if (turnIds.length <= MAX_LIVE_HISTORY_TURNS) return;
    const firstKeptTurnId = turnIds[turnIds.length - MAX_LIVE_HISTORY_TURNS];
    const firstKeptIndex = this.history.findIndex((entry) => entry.turnId === firstKeptTurnId);
    if (firstKeptIndex <= 0) return;
    this.history.splice(0, firstKeptIndex);
  }

  private async waitForMemoryPolicy(signal: AbortSignal): Promise<void> {
    const barrier = this.memoryPolicyBarrier;
    if (!barrier) return;
    await runWithTimeout(
      () => barrier,
      this.memoryPolicyWaitTimeoutMs,
      'Memory policy wait timed out',
      signal,
    );
    throwIfAborted(signal);
    if (!this.memoryPolicyReady) {
      throw new MemoryPolicyApplyError('Memory policy is unavailable');
    }
  }

  private async persistTurn(
    turnId: TurnId,
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
    policy: TurnPersistencePolicy,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (this.conversationId === FALLBACK_CONVERSATION_ID) {
      this.warnPersistenceOnce();
      return;
    }
    try {
      const stagingId = await this.runMemoryMutation(() => this.memoryStore.persistTurn(
        this.conversationId,
        turnId,
        messages,
        policy,
      ), signal);
      throwIfAborted(signal);
      if (stagingId != null) this.memoryCurator.schedule();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      console.warn('[Router] Turn persist failed (non-fatal):', err);
      this.warnPersistenceOnce();
    }
  }

  private async runMemoryMutation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const linked = linkAbortSignals(signal, this.shutdownAbort.signal);
    const mutationSignal = linked.signal;
    const execute = async (): Promise<T> => {
      throwIfAborted(mutationSignal);
      const result = await operation();
      throwIfAborted(mutationSignal);
      return result;
    };
    const run = this.memoryMutationQueue.then(execute, execute);
    this.memoryMutationQueue = run.then(() => undefined, () => undefined);
    try {
      throwIfAborted(mutationSignal);
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          mutationSignal.removeEventListener('abort', onAbort);
          callback();
        };
        const onAbort = (): void => finish(() => {
          const reason = mutationSignal.reason;
          reject(reason instanceof Error ? reason : abortError());
        });
        mutationSignal.addEventListener('abort', onAbort, { once: true });
        run.then(
          (value) => finish(() => resolve(value)),
          (error: Error) => finish(() => reject(error)),
        );
      });
    } finally {
      linked.dispose();
    }
  }

  private async drainPendingWork(activeTurnId: TurnId | null, signal?: AbortSignal): Promise<void> {
    const drains: Promise<void>[] = [this.outputQueue, this.memoryMutationQueue];
    if (activeTurnId) drains.push(this.coordinator.waitForTurn(activeTurnId));
    try {
      await runWithTimeout(
        () => Promise.allSettled(drains).then(() => undefined),
        this.shutdownDrainTimeoutMs,
        'Router shutdown drain timed out',
        signal,
      );
    } catch (error) {
      console.warn('[Router] Pending work did not drain before shutdown:', error);
    }
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

  private isTurnOperational(turnId: TurnId, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false;
    if (this.context.bus.isTurnTerminal(turnId)) return false;
    if (turnId === this.coordinator.activeTurnId) return this.coordinator.isCurrent(turnId);
    return this.isOperational() && !this.terminalTurns.has(turnId);
  }

  private emitError(turnId: TurnId, message: string): void {
    if (this.terminalTurns.has(turnId) || this.errorTurns.has(turnId)) return;
    this.errorTurns.add(turnId);
    this.context.bus.emit(this.id, 'llm:error', { turnId, message });
  }

  private emitTerminal(turnId: TurnId, status: TurnTerminalStatus, message?: string): void {
    if (this.context.bus.isTurnTerminal(turnId)) {
      this.rememberTerminal(turnId);
      return;
    }
    if (!this.rememberTerminal(turnId)) return;
    this.context.bus.emit(this.id, 'turn:terminal', { turnId, status, ...(message ? { message } : {}) });
  }

  private rememberTerminal(turnId: TurnId): boolean {
    if (this.terminalTurns.has(turnId)) return false;
    this.terminalTurns.add(turnId);
    this.terminalTurnOrder.push(turnId);
    if (this.terminalTurnOrder.length > 2_000) {
      const expired = this.terminalTurnOrder.shift();
      if (expired) {
        this.terminalTurns.delete(expired);
        this.errorTurns.delete(expired);
      }
    }
    return true;
  }

  private isWorkerUnavailable(): boolean {
    const worker = this.modelRuntime.snapshot.roles.local_worker;
    return worker.availability !== 'available' || worker.residency === 'error';
  }

}
