import { validateIntentPlan, type IntentPlan } from './intent-plan.js';
import {
  isValidPlanExecutionState,
  type PlanExecutionState,
} from './plan-execution-state.js';
import type { TurnId } from './turn-contract.js';

export interface PendingIntentPlanEntry {
  readonly confirmationId: string;
  readonly plan: IntentPlan;
  readonly state: PlanExecutionState;
  readonly expiresAt: number;
}

export interface PendingIntentPlanPutResult {
  readonly entry: PendingIntentPlanEntry;
  readonly superseded: readonly PendingIntentPlanEntry[];
}

function stateMatchesPlan(plan: IntentPlan, state: PlanExecutionState): boolean {
  return state.planId === plan.planId
    && state.revision === plan.revision
    && state.fingerprint === plan.fingerprint
    && state.sourceTurnId === plan.sourceTurnId
    && state.steps.length === plan.steps.length
    && state.steps.every((step, index) => step.stepId === plan.steps[index]?.stepId);
}

/** Stores at most one expiring, immutable suspended plan in process memory. */
export class PendingIntentPlanStore {
  private readonly entries = new Map<string, PendingIntentPlanEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  put(
    confirmationId: string,
    plan: IntentPlan,
    state: PlanExecutionState,
    expiresAt: number,
  ): PendingIntentPlanPutResult {
    this.removeExpired();
    if (!confirmationId.trim() || confirmationId.length > 100) {
      throw new Error('Pending plan requires a confirmation ID');
    }
    if (!validateIntentPlan(plan) || !isValidPlanExecutionState(state)
      || state.status !== 'waiting_confirmation') {
      throw new Error('Pending plan requires a valid waiting execution state');
    }
    if (!stateMatchesPlan(plan, state)) {
      throw new Error('Pending execution state does not match its plan');
    }
    if (!isValidPlanExecutionState(state, plan)) {
      throw new Error('Pending plan requires a handoff confirmation step');
    }
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
      throw new Error('Pending plan expiry must be in the future');
    }
    const superseded = Object.freeze([...this.entries.values()]);
    this.entries.clear();
    const entry = Object.freeze({ confirmationId, plan, state, expiresAt });
    this.entries.set(confirmationId, entry);
    return Object.freeze({ entry, superseded });
  }

  take(confirmationId: string): PendingIntentPlanEntry | null {
    this.removeExpired();
    const entry = this.entries.get(confirmationId);
    if (!entry) return null;
    this.entries.delete(confirmationId);
    return entry;
  }

  /** Returns the only current entry without consuming it. */
  peekSingle(): PendingIntentPlanEntry | null {
    this.removeExpired();
    if (this.entries.size !== 1) return null;
    return this.entries.values().next().value ?? null;
  }

  cancel(confirmationId: string): PendingIntentPlanEntry | null {
    return this.take(confirmationId);
  }

  invalidateSourceTurn(turnId: TurnId): readonly PendingIntentPlanEntry[] {
    this.removeExpired();
    const invalidated: PendingIntentPlanEntry[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.plan.sourceTurnId !== turnId) continue;
      invalidated.push(entry);
      this.entries.delete(id);
    }
    return Object.freeze(invalidated);
  }

  clear(): readonly PendingIntentPlanEntry[] {
    this.removeExpired();
    const entries = Object.freeze([...this.entries.values()]);
    this.entries.clear();
    return entries;
  }

  private removeExpired(): void {
    const current = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= current) this.entries.delete(id);
    }
  }
}
