import { randomUUID } from 'crypto';
import type { AppContext } from '../../core/bootstrap.js';
import { WORKER_UNAVAILABLE_MESSAGE } from '../../core/chat-availability.js';
import type { TurnEnvelope, TurnId } from '../../core/turn-contract.js';
import { throwIfAborted } from '../../core/abort-utils.js';
import { isActionName } from '../actions/action-schemas.js';
import { getFeedback } from './filler-phrases.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { redactSensitiveLiterals } from './sensitive-turn-guard.js';
import type { ModelRuntimePort } from './model-runtime.js';
import type { RouterActionFlow } from './router-action-flow.js';
import { buildRouterContext, type RouterHistoryEntry } from './router-context-builder.js';
import type { RouterTurnDraft } from './router-turn-persistence.js';
import {
  isActiveReminderListShortcut,
  reminderCancelFromMisroutedSet,
  reminderFromMisroutedTimer,
  timerFromMisroutedReminder,
} from './router-reminder-routing.js';

interface RouterWorkerFlowOptions {
  context: AppContext;
  serviceId: string;
  modelRuntime: ModelRuntimePort;
  actionFlow: RouterActionFlow;
  drafts: Map<TurnId, RouterTurnDraft>;
  getHistory: () => RouterHistoryEntry[];
  getCuratedMemories: () => Parameters<typeof buildRouterContext>[0]['curatedMemories'];
  waitForMemoryPolicy: (signal: AbortSignal) => Promise<void>;
  enqueueOutput: (job: () => Promise<void>) => Promise<void>;
  isTurnOperational: (turnId: TurnId, signal?: AbortSignal) => boolean;
  emitAssistantResponse: (turnId: TurnId, text: string, signal: AbortSignal) => Promise<void>;
  recordAssistantOutput: (turnId: TurnId, text: string) => void;
  isWorkerUnavailable: () => boolean;
}

/** Owns router-model dispatch, worker streaming and model-transition feedback. */
export class RouterWorkerFlow {
  constructor(private readonly options: RouterWorkerFlowOptions) {}

  async routeAndRespond(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    const { context, serviceId, modelRuntime, actionFlow } = this.options;
    const { effectiveText: text, mode, turnId } = envelope;
    if (isActiveReminderListShortcut(envelope.normalizedText)) {
      await actionFlow.dispatchOrRequestConfirmation(envelope, 'list_reminders', 'upcoming', signal);
      return;
    }
    const result = await modelRuntime.route(text, signal);
    if (!this.options.isTurnOperational(turnId, signal)) return;
    context.bus.emit(serviceId, 'perf:timing', { turnId, label: 'router', ms: result.tookMs });

    if (!result.hadTag) {
      console.warn('[Router] No route tag in 2B response, falling back to self');
    }
    if (result.parsed.kind === 'action') {
      const { action, param } = result.parsed;
      if (!isActionName(action)) {
        console.warn('[Router] Unknown action name refused');
        await this.options.emitAssistantResponse(turnId, 'Das kann ich noch nicht.', signal);
        return;
      }
      const explicitCancelReminderParam = reminderCancelFromMisroutedSet(envelope.effectiveText);
      const reminderParam = action === 'set_timer'
        ? reminderFromMisroutedTimer(param, envelope.effectiveText)
        : null;
      const timerParam = action === 'set_reminder'
        ? timerFromMisroutedReminder(param, envelope.effectiveText)
        : null;
      await actionFlow.dispatchOrRequestConfirmation(
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

    const busTarget = result.parsed.route === 'backend' || result.parsed.route === 'extern'
      ? result.parsed.route
      : 'local_worker' as const;
    context.bus.emit(serviceId, 'llm:routing', { turnId, from: 'router', to: busTarget });
    if (mode === 'voice') {
      context.bus.emit(serviceId, 'llm:filler', { turnId, text: getFeedback('frontendThinking') });
    }
    context.bus.emit(serviceId, 'llm:model-swap', {
      turnId,
      loading: context.parsedConfig.llm.workerModel,
      unloading: context.parsedConfig.llm.routerModel,
    });
    await this.runWorkerWithFallback(envelope, signal);
  }

  async runWorkerWithFallback(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    let outputStarted = false;
    try {
      await this.runWorker(envelope, signal, () => {
        outputStarted = true;
        const draft = this.options.drafts.get(envelope.turnId);
        if (draft) draft.workerOutputStarted = true;
      });
    } catch (error) {
      throwIfAborted(signal);
      if (outputStarted || !this.options.isWorkerUnavailable()) throw error;
      await this.options.emitAssistantResponse(envelope.turnId, WORKER_UNAVAILABLE_MESSAGE, signal);
    }
  }

  private async runWorker(
    envelope: TurnEnvelope,
    signal: AbortSignal,
    onOutputStarted?: () => void,
  ): Promise<void> {
    const { context, serviceId, modelRuntime, drafts } = this.options;
    const { turnId, mode } = envelope;
    await this.options.waitForMemoryPolicy(signal);
    const systemPrompt = buildSystemPrompt(context.parsedConfig, mode);
    const responseStyle = context.parsedConfig.personalization.responseStyle;
    const { messages, numPredict } = buildRouterContext({
      systemPrompt,
      responseStyle,
      currentUser: envelope.effectiveText,
      memoryAllowed: context.parsedConfig.trust.memoryAllowed,
      numCtx: context.parsedConfig.llm.workerOptions.num_ctx,
      history: this.options.getHistory(),
      curatedMemories: this.options.getCuratedMemories(),
      draft: drafts.get(turnId),
    });
    const outputId = randomUUID();
    let sequence = 0;
    const sensitiveGuard = drafts.get(turnId)?.sensitiveGuard
      ?? { hasSensitiveInput: false, literals: [] };
    const bufferSensitiveOutput = sensitiveGuard.literals.length > 0;

    await this.options.enqueueOutput(async () => {
      if (!this.options.isTurnOperational(turnId, signal)) return;
      const { fullText, tookMs } = await modelRuntime.streamWorker(messages, responseStyle, (chunk) => {
        if (bufferSensitiveOutput) return;
        if (this.options.isTurnOperational(turnId, signal)) {
          onOutputStarted?.();
          context.bus.emit(serviceId, 'llm:chunk', {
            turnId,
            outputId,
            sequence: sequence++,
            text: chunk,
          });
        }
      }, signal, numPredict);
      if (!this.options.isTurnOperational(turnId, signal)) return;
      const protectedFullText = redactSensitiveLiterals(fullText, sensitiveGuard);
      if (bufferSensitiveOutput && protectedFullText) {
        onOutputStarted?.();
        context.bus.emit(serviceId, 'llm:chunk', {
          turnId,
          outputId,
          sequence: sequence++,
          text: protectedFullText,
        });
      }
      context.bus.emit(serviceId, 'perf:timing', { turnId, label: 'worker', ms: tookMs });
      this.options.recordAssistantOutput(turnId, protectedFullText);
      if (!this.options.isTurnOperational(turnId, signal)) return;
      context.bus.emit(serviceId, 'llm:done', {
        turnId,
        outputId,
        sequence,
        fullText: protectedFullText,
      });
    });
  }
}
