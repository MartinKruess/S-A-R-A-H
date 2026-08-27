import { randomUUID } from 'crypto';
import type { TurnId } from './turn-contract.js';

export type ConfirmationLevel = 'minimal' | 'standard' | 'maximal';

export interface ActionConfirmationReference {
  confirmationId: string;
  requestedTurnId: TurnId;
}

export interface ConfirmedAction {
  confirmation: ActionConfirmationReference;
  confirmationTurnId: TurnId;
  action: string;
  param: string;
  sourceRequestId?: string;
}

interface PendingAction {
  requestedTurnId: TurnId;
  action: string;
  param: string;
  sourceRequestId?: string;
  expiresAt: number;
}

interface Approval extends ConfirmedAction {
  expiresAt: number;
}

const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60_000;

/**
 * Verwaltet kurzlebige, einmalig nutzbare Zustimmungen zwischen Router und ActionService.
 * Eine Zustimmung ist an Vorschlags-Turn, Bestätigungs-Turn, Action und Parameter gebunden.
 *
 * @category Authorization Service
 */
export class ActionConfirmationGate {
  private readonly pending = new Map<string, PendingAction>();
  private readonly approvals = new Map<string, Approval>();

  constructor(
    private readonly ttlMs = DEFAULT_CONFIRMATION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Registriert eine bestätigungspflichtige Action und gibt deren einmalige ID zurück. */
  request(
    requestedTurnId: TurnId,
    action: string,
    param: string,
    sourceRequestId?: string,
  ): string {
    this.removeExpired();
    const confirmationId = randomUUID();
    this.pending.set(confirmationId, {
      requestedTurnId,
      action,
      param,
      ...(sourceRequestId ? { sourceRequestId } : {}),
      expiresAt: this.now() + this.ttlMs,
    });
    return confirmationId;
  }

  /** Bindet eine noch offene Action-ID an den Turn, der die Zustimmung erteilt. */
  approve(confirmationId: string, confirmationTurnId: TurnId): ConfirmedAction | null {
    this.removeExpired();
    const pending = this.pending.get(confirmationId);
    if (!pending) return null;
    this.pending.delete(confirmationId);
    const confirmed: ConfirmedAction = {
      confirmation: {
        confirmationId,
        requestedTurnId: pending.requestedTurnId,
      },
      confirmationTurnId,
      action: pending.action,
      param: pending.param,
      ...(pending.sourceRequestId ? { sourceRequestId: pending.sourceRequestId } : {}),
    };
    this.approvals.set(confirmationId, {
      ...confirmed,
      expiresAt: this.now() + this.ttlMs,
    });
    return confirmed;
  }

  /** Verbraucht eine exakt passende Zustimmung; abweichende oder wiederholte Requests werden abgewiesen. */
  consume(
    confirmationTurnId: TurnId,
    action: string,
    param: string,
    reference: ActionConfirmationReference | undefined,
    sourceRequestId?: string,
  ): boolean {
    this.removeExpired();
    if (!reference) return false;
    const approval = this.approvals.get(reference.confirmationId);
    if (
      !approval
      || approval.confirmationTurnId !== confirmationTurnId
      || approval.confirmation.requestedTurnId !== reference.requestedTurnId
      || approval.action !== action
      || approval.param !== param
      || approval.sourceRequestId !== sourceRequestId
    ) return false;
    this.approvals.delete(reference.confirmationId);
    return true;
  }

  /** Verwirft alle offenen Vorschläge und Zustimmungen beim Service-Shutdown. */
  clear(): void {
    this.pending.clear();
    this.approvals.clear();
  }

  private removeExpired(): void {
    const current = this.now();
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= current) this.pending.delete(id);
    }
    for (const [id, approval] of this.approvals) {
      if (approval.expiresAt <= current) this.approvals.delete(id);
    }
  }
}
