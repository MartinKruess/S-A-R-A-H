import { randomUUID } from 'crypto';
import type { AppContext } from '../../core/bootstrap.js';
import { WORKER_UNAVAILABLE_MESSAGE } from '../../core/chat-availability.js';
import type { TurnEnvelope, TurnId } from '../../core/turn-contract.js';
import type { DecisionCapability, DecisionContext } from '../../core/decision-context.js';
import type { ActionPlanStep, IntentPlan, IntentPlanStep } from '../../core/intent-plan.js';
import { throwIfAborted } from '../../core/abort-utils.js';
import { isActionName } from '../actions/action-schemas.js';
import { getFeedback } from './filler-phrases.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { redactSensitiveLiterals } from './sensitive-turn-guard.js';
import type { ModelRuntimePort } from './model-runtime.js';
import type { RouterActionFlow } from './router-action-flow.js';
import { buildRouterContext, type RouterHistoryEntry } from './router-context-builder.js';
import type { RouterTurnDraft } from './router-turn-persistence.js';
import type { ReminderClock } from '../actions/reminder-contract.js';
import { compileRouterPlanProposal } from './router-plan-validator.js';
import {
  IntentPlanExecutor,
} from './intent-plan-executor.js';
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
  buildDecisionContext: (envelope: TurnEnvelope) => DecisionContext | null;
  reminderClock: ReminderClock;
}

const PLAN_REJECTED_MESSAGE = 'Ich konnte den kombinierten Auftrag nicht zuverlässig aufteilen. Bitte formuliere die Schritte noch einmal einzeln.';
const PLAN_PREFLIGHT_MESSAGE = 'Ich kann diesen kombinierten Auftrag so noch nicht sicher ausführen. Bitte teile ihn in einzelne Aufträge auf.';
const PLAN_INCOMPLETE_MESSAGE = 'Ich konnte den kombinierten Auftrag nicht vollständig ausführen.';

function isAvailable(capability: DecisionCapability): boolean {
  return capability.state === 'available';
}

function isStepCapabilityAvailable(step: IntentPlanStep, context: DecisionContext): boolean {
  if (step.kind === 'answer') return isAvailable(context.capabilities.localAnswer);
  if (step.kind === 'handoff_confirmation' || step.kind === 'specialist_handoff') {
    return isAvailable(context.capabilities.specialists[step.capability]);
  }
  if (!isAvailable(context.capabilities.actions)) return false;
  const action = step.intent.action;
  if (action === 'web_search') return isAvailable(context.capabilities.webSearch);
  if (action === 'show_browser') return isAvailable(context.capabilities.visibleBrowserResult);
  if (action === 'set_reminder' || action === 'list_reminders' || action === 'cancel_reminder') {
    return isAvailable(context.capabilities.reminders)
      && !(action === 'set_reminder' && context.turn.privateContext);
  }
  if (
    action === 'spotify_volume'
    || action === 'spotify_volume_adjust'
    || action === 'media_play'
    || action === 'media_pause'
    || action === 'media_toggle'
    || action === 'media_next'
    || action === 'media_previous'
  ) return isAvailable(context.capabilities.media);
  return true;
}

function isCurrentPlanContext(
  current: DecisionContext,
  planned: DecisionContext,
  plan: IntentPlan,
): boolean {
  return current.capabilities.lifecycleGeneration === planned.capabilities.lifecycleGeneration
    && current.turn.turnId === plan.sourceTurnId
    && current.turn.mode === plan.originMode
    && current.turn.privateContext === plan.privateContext
    && current.capabilities.modelExecutionMode === 'exclusive';
}

/** Owns router-model dispatch, worker streaming and model-transition feedback. */
export class RouterWorkerFlow {
  constructor(private readonly options: RouterWorkerFlowOptions) {}

  async routeAndRespond(
    envelope: TurnEnvelope,
    signal: AbortSignal,
    requiresPlan = false,
  ): Promise<void> {
    const { context, serviceId, modelRuntime, actionFlow } = this.options;
    const { effectiveText: text, mode, turnId } = envelope;
    if (isActiveReminderListShortcut(envelope.normalizedText)) {
      await actionFlow.dispatchOrRequestConfirmation(
        envelope,
        'list_reminders',
        'upcoming',
        signal,
        { decisionSource: 'deterministic_shortcut' },
      );
      return;
    }
    const decisionContext = this.options.buildDecisionContext(envelope);
    const result = decisionContext
      ? await modelRuntime.route(text, decisionContext, signal)
      : await modelRuntime.route(text, signal);
    if (!this.options.isTurnOperational(turnId, signal)) return;
    context.bus.emit(serviceId, 'perf:timing', { turnId, label: 'router', ms: result.tookMs });

    if (result.outputKind === 'invalid_proposal' || (
      requiresPlan && result.outputKind !== 'proposal'
    )) {
      await this.options.emitAssistantResponse(turnId, PLAN_REJECTED_MESSAGE, signal);
      return;
    }
    if (result.outputKind === 'proposal') {
      if (!decisionContext) {
        await this.options.emitAssistantResponse(turnId, PLAN_REJECTED_MESSAGE, signal);
        return;
      }
      const compiled = compileRouterPlanProposal(result.proposalOutput, envelope, {
        decisionContext,
        reminderClock: this.options.reminderClock,
      });
      if (!compiled.ok) {
        await this.options.emitAssistantResponse(turnId, PLAN_REJECTED_MESSAGE, signal);
        return;
      }
      await this.executePlan(envelope, compiled.plan, decisionContext, signal);
      return;
    }

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
      const correctedByDeterministicRule = explicitCancelReminderParam !== null
        || reminderParam !== null
        || timerParam !== null;
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
        correctedByDeterministicRule
          ? { decisionSource: 'deterministic_shortcut' }
          : undefined,
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
    await this.runWorkerTextWithFallback(envelope, envelope.effectiveText, signal);
  }

  private async runWorkerTextWithFallback(
    envelope: TurnEnvelope,
    currentUser: string,
    signal: AbortSignal,
    bufferUntilComplete = false,
  ): Promise<boolean> {
    let outputStarted = false;
    try {
      await this.runWorker(envelope, currentUser, signal, () => {
        outputStarted = true;
        const draft = this.options.drafts.get(envelope.turnId);
        if (draft) draft.workerOutputStarted = true;
      }, bufferUntilComplete);
    } catch (error) {
      throwIfAborted(signal);
      if (outputStarted || !this.options.isWorkerUnavailable()) throw error;
      await this.options.emitAssistantResponse(envelope.turnId, WORKER_UNAVAILABLE_MESSAGE, signal);
      return false;
    }
    return true;
  }

  private async runWorker(
    envelope: TurnEnvelope,
    currentUser: string,
    signal: AbortSignal,
    onOutputStarted?: () => void,
    bufferUntilComplete = false,
  ): Promise<void> {
    const { context, serviceId, modelRuntime, drafts } = this.options;
    const { turnId, mode } = envelope;
    await this.options.waitForMemoryPolicy(signal);
    const systemPrompt = buildSystemPrompt(context.parsedConfig, mode);
    const responseStyle = context.parsedConfig.personalization.responseStyle;
    const { messages, numPredict } = buildRouterContext({
      systemPrompt,
      responseStyle,
      currentUser,
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
    const bufferOutput = bufferSensitiveOutput || bufferUntilComplete;

    await this.options.enqueueOutput(async () => {
      if (!this.options.isTurnOperational(turnId, signal)) return;
      const { fullText, tookMs } = await modelRuntime.streamWorker(messages, responseStyle, (chunk) => {
        if (bufferOutput) return;
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
      if (bufferOutput && protectedFullText) {
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

  private async executePlan(
    envelope: TurnEnvelope,
    plan: IntentPlan,
    plannedContext: DecisionContext,
    signal: AbortSignal,
  ): Promise<void> {
    const currentContext = this.options.buildDecisionContext(envelope);
    if (
      !currentContext
      || !isCurrentPlanContext(currentContext, plannedContext, plan)
      || plan.steps.some((step) => !isStepCapabilityAvailable(step, currentContext))
    ) {
      await this.options.emitAssistantResponse(envelope.turnId, PLAN_PREFLIGHT_MESSAGE, signal);
      return;
    }
    const actionSteps = plan.steps.filter(
      (step): step is ActionPlanStep => step.kind === 'action',
    );
    for (const step of actionSteps) {
      const preflight = this.options.actionFlow.preflightPlannedAction(step.intent, {
        privateContext: plan.privateContext,
        originMode: plan.originMode,
      });
      if (!preflight.ok || step.intent.provenance.sourceTurnId !== envelope.turnId) {
        await this.options.emitAssistantResponse(
          envelope.turnId,
          PLAN_PREFLIGHT_MESSAGE,
          signal,
        );
        return;
      }
    }

    const executor = new IntentPlanExecutor({
      executeAction: async (step, executionContext, stepSignal) => {
        const liveContext = this.options.buildDecisionContext(envelope);
        if (
          !liveContext
          || !isCurrentPlanContext(liveContext, plannedContext, plan)
          || !isStepCapabilityAvailable(step, liveContext)
        ) return { status: 'failed', reason: 'action_failed' };
        const result = await this.options.actionFlow.executePlannedAction(
          envelope,
          step.intent,
          stepSignal ?? signal,
          executionContext,
        );
        return result.ok
          ? { status: 'succeeded' }
          : { status: 'failed', reason: 'action_failed' };
      },
      executeAnswer: async (step, _context, stepSignal) => {
        const liveContext = this.options.buildDecisionContext(envelope);
        if (
          !liveContext
          || !isCurrentPlanContext(liveContext, plannedContext, plan)
          || !isStepCapabilityAvailable(step, liveContext)
        ) return { status: 'failed', reason: 'answer_failed' };
        const succeeded = await this.runWorkerTextWithFallback(
          envelope,
          step.text,
          stepSignal ?? signal,
          true,
        );
        return succeeded
          ? { status: 'succeeded' }
          : { status: 'failed', reason: 'answer_failed' };
      },
      requestHandoffConfirmation: async () => ({
        status: 'failed',
        reason: 'confirmation_failed',
      }),
      executeSpecialistHandoff: async () => ({
        status: 'failed',
        reason: 'handoff_failed',
      }),
    });
    const state = await executor.execute(plan, signal);
    throwIfAborted(signal);
    if (state.status !== 'completed') {
      await this.options.emitAssistantResponse(envelope.turnId, PLAN_INCOMPLETE_MESSAGE, signal);
    }
  }
}
