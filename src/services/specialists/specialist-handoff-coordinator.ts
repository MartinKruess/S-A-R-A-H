import { randomUUID } from 'crypto';
import {
  PendingIntentPlanStore,
} from '../../core/pending-intent-plan-store.js';
import {
  SpecialistHandoffConfirmationGate,
  type SpecialistHandoffConfirmationSubject,
} from '../../core/specialist-handoff-confirmation.js';
import type { IntentPlan, HandoffConfirmationPlanStep } from '../../core/intent-plan.js';
import {
  cancelPlanExecution,
  type PlanExecutionState,
} from '../../core/plan-execution-state.js';
import type { TurnId } from '../../core/turn-contract.js';
import type { SpecialistTaskSnapshot } from '../../core/specialist-task.js';
import type {
  AiProviderId,
  AiProviderOperationId,
} from '../../core/ai-provider-contract.js';
import { IntentPlanExecutor } from '../llm/intent-plan-executor.js';
import { getAiProviderCatalogEntry } from '../integrations/ai-provider-catalog.js';
import type { SpecialistRuntimeService } from './specialist-runtime-service.js';

export interface SpecialistHandoffSelection {
  readonly providerId: AiProviderId;
  readonly operationId: AiProviderOperationId;
  readonly connectionId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly providerName: string;
  readonly roleName: string;
  readonly modelName: string;
}

export type SpecialistHandoffSelectionResolver = (
  capability: 'coding' | 'research',
) => SpecialistHandoffSelection | null;

export type SpecialistHandoffRegistrationResult =
  | {
    readonly ok: true;
    readonly confirmationId: string;
    readonly prompt: string;
  }
  | { readonly ok: false; readonly code: 'invalid_plan' | 'unavailable' | 'private_context' };

export type SpecialistHandoffResumeResult =
  | {
    readonly ok: true;
    readonly state: PlanExecutionState;
    readonly task?: SpecialistTaskSnapshot;
  }
  | {
    readonly ok: false;
    readonly code: 'not_found' | 'expired' | 'stale' | 'private_context' | 'start_failed';
    readonly state?: PlanExecutionState;
  };

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

function waitingConfirmation(
  plan: IntentPlan,
  state: PlanExecutionState,
): HandoffConfirmationPlanStep | null {
  if (state.status !== 'waiting_confirmation') return null;
  const waiting = state.steps.find((step) => step.status === 'waiting_confirmation');
  const planStep = waiting
    ? plan.steps.find((step) => step.stepId === waiting.stepId)
    : undefined;
  return planStep?.kind === 'handoff_confirmation' ? planStep : null;
}

function buildSubject(
  plan: IntentPlan,
  step: HandoffConfirmationPlanStep,
  selection: SpecialistHandoffSelection,
): SpecialistHandoffConfirmationSubject | null {
  if (step.capability !== 'coding' && step.capability !== 'research') return null;
  const providerName = getAiProviderCatalogEntry(selection.providerId).displayName;
  return {
    planId: plan.planId,
    revision: plan.revision,
    fingerprint: plan.fingerprint,
    sourceTurnId: plan.sourceTurnId,
    stepId: step.stepId,
    task: step.task,
    capability: step.capability,
    privateContext: plan.privateContext,
    originMode: plan.originMode,
    dataEgress: ['goal'],
    accessMode: 'none',
    budget: { maxTurns: DEFAULT_MAX_TURNS, timeoutMs: DEFAULT_TIMEOUT_MS },
    bindingLease: {
      providerId: selection.providerId,
      operationId: selection.operationId,
      connectionId: selection.connectionId,
      bindingId: selection.bindingId,
      revision: selection.bindingRevision,
    },
    display: {
      providerName,
      roleName: selection.roleName,
      modelName: selection.modelName,
    },
  };
}

/** Coordinates inert plan suspension and one exact, provider-neutral specialist start. */
export class SpecialistHandoffCoordinator {
  constructor(
    private readonly runtime: SpecialistRuntimeService,
    private readonly resolveSelection: SpecialistHandoffSelectionResolver,
    private readonly gate = new SpecialistHandoffConfirmationGate(),
    private readonly pendingPlans = new PendingIntentPlanStore(),
    private readonly createTaskId: () => string = randomUUID,
  ) {}

  register(plan: IntentPlan, state: PlanExecutionState): SpecialistHandoffRegistrationResult {
    const confirmation = waitingConfirmation(plan, state);
    if (!confirmation) return { ok: false, code: 'invalid_plan' };
    if (plan.privateContext) return { ok: false, code: 'private_context' };
    if (confirmation.capability !== 'coding' && confirmation.capability !== 'research') {
      return { ok: false, code: 'unavailable' };
    }
    const selection = this.resolveSelection(confirmation.capability);
    if (!selection) return { ok: false, code: 'unavailable' };
    const subject = buildSubject(plan, confirmation, selection);
    if (!subject) return { ok: false, code: 'invalid_plan' };
    const request = this.gate.request(subject);
    if (!request) return { ok: false, code: 'invalid_plan' };
    const put = this.pendingPlans.put(request.confirmationId, plan, state, request.expiresAt);
    for (const superseded of put.superseded) this.gate.cancel(superseded.confirmationId);
    return {
      ok: true,
      confirmationId: request.confirmationId,
      prompt: `Ziel: ${confirmation.task}\nRolle: ${subject.display.roleName}. Anbieter: ${subject.display.providerName} (${subject.display.modelName}). Übertragen wird nur der Zieltext; kein Workspace und kein Gesprächskontext. Soll ich den Spezialisten jetzt starten? Im Textchat: /confirm ${request.confirmationId}`,
    };
  }

  hasSinglePending(): boolean {
    return this.pendingPlans.peekSingle() !== null && this.gate.hasSinglePending();
  }

  singleConfirmationId(): string | null {
    return this.pendingPlans.peekSingle()?.confirmationId ?? null;
  }

  cancelSinglePending(): PlanExecutionState | null {
    const entry = this.pendingPlans.peekSingle();
    if (!entry) return null;
    this.pendingPlans.cancel(entry.confirmationId);
    this.gate.cancel(entry.confirmationId);
    return cancelPlanExecution(entry.plan, entry.state, 'user_canceled');
  }

  async confirm(
    confirmationId: string,
    confirmationTurnId: TurnId,
    currentPrivateContext: boolean,
    signal?: AbortSignal,
  ): Promise<SpecialistHandoffResumeResult> {
    const peeked = this.pendingPlans.peekSingle();
    if (!peeked || peeked.confirmationId !== confirmationId) {
      return { ok: false, code: 'not_found' };
    }
    const grant = this.gate.approve(confirmationId, confirmationTurnId);
    if (!grant) {
      this.pendingPlans.cancel(confirmationId);
      return { ok: false, code: 'expired' };
    }
    const entry = this.pendingPlans.take(confirmationId);
    if (!entry) {
      this.gate.cancel(confirmationId);
      return { ok: false, code: 'expired' };
    }
    if (currentPrivateContext !== entry.plan.privateContext || currentPrivateContext) {
      this.gate.cancel(confirmationId);
      return {
        ok: false,
        code: 'private_context',
        state: cancelPlanExecution(entry.plan, entry.state, 'superseded'),
      };
    }
    const confirmation = waitingConfirmation(entry.plan, entry.state);
    if (!confirmation || (confirmation.capability !== 'coding'
      && confirmation.capability !== 'research')) {
      this.gate.cancel(confirmationId);
      return { ok: false, code: 'stale' };
    }
    const selection = this.resolveSelection(confirmation.capability);
    const expected = selection ? buildSubject(entry.plan, confirmation, selection) : null;
    if (!expected || !this.gate.consume(grant, expected)) {
      this.gate.cancel(confirmationId);
      return {
        ok: false,
        code: 'stale',
        state: cancelPlanExecution(entry.plan, entry.state, 'superseded'),
      };
    }

    let task: SpecialistTaskSnapshot | undefined;
    const executor = new IntentPlanExecutor({
      executeAction: async () => ({ status: 'failed', reason: 'action_failed' }),
      executeAnswer: async () => ({ status: 'failed', reason: 'answer_failed' }),
      requestHandoffConfirmation: async () => ({ status: 'failed', reason: 'confirmation_failed' }),
      executeSpecialistHandoff: async (step) => {
        if (step.stepId === confirmation.stepId || step.task !== expected.task
          || step.capability !== expected.capability
          || step.dependsOn.length !== 1
          || step.dependsOn[0] !== confirmation.stepId) {
          return { status: 'failed', reason: 'handoff_failed' };
        }
        const result = await this.runtime.start({
          taskId: this.createTaskId(),
          role: expected.capability,
          goal: expected.task,
          sourceTurnId: expected.sourceTurnId,
          planId: expected.planId,
          planRevision: expected.revision,
          planFingerprint: expected.fingerprint,
          stepId: step.stepId,
          providerId: expected.bindingLease.providerId,
          operationId: expected.bindingLease.operationId,
          connectionId: expected.bindingLease.connectionId,
          bindingId: expected.bindingLease.bindingId,
          bindingRevision: expected.bindingLease.revision,
          privateContext: false,
          originMode: expected.originMode,
          dataEgress: expected.dataEgress,
          ...(expected.workspaceReference
            ? { workspaceReference: expected.workspaceReference }
            : {}),
          accessMode: expected.accessMode,
          budget: expected.budget,
        }, signal);
        if (!result.ok) return { status: 'failed', reason: 'handoff_failed' };
        task = result.snapshot;
        return { status: 'succeeded' };
      },
    });
    const state = await executor.resume(
      entry.plan,
      entry.state,
      confirmation.stepId,
      signal,
      'turn_canceled',
    );
    return state.status === 'completed'
      ? { ok: true, state, ...(task ? { task } : {}) }
      : { ok: false, code: 'start_failed', state };
  }

  invalidateSourceTurn(turnId: TurnId): void {
    for (const entry of this.pendingPlans.invalidateSourceTurn(turnId)) {
      this.gate.cancel(entry.confirmationId);
    }
    this.gate.invalidateSourceTurn(turnId);
  }

  clear(): void {
    this.pendingPlans.clear();
    this.gate.clear();
  }

  /** Exposes no pending task content; used only for lifecycle/readiness tests. */
  pendingCount(): 0 | 1 {
    return this.pendingPlans.peekSingle() ? 1 : 0;
  }
}
