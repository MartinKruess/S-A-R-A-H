import { randomUUID } from 'crypto';
import type { ActionIntent, ActionProvenance } from './action-intent.js';
import type { TurnId } from './turn-contract.js';

export type ConfirmationLevel = 'minimal' | 'standard' | 'maximal';

export interface ActionConfirmationReference {
  confirmationId: string;
  requestedTurnId: TurnId;
}

export interface ConfirmedAction {
  confirmation: ActionConfirmationReference;
  confirmationTurnId: TurnId;
  intent: ActionIntent;
  sourceRequestId?: string;
}

interface PendingAction {
  requestedTurnId: TurnId;
  intent: ActionIntent;
  sourceRequestId?: string;
  expiresAt: number;
}

interface Approval extends ConfirmedAction {
  expiresAt: number;
}

const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60_000;
export const SPOKEN_ACTION_CONFIRMATION_PHRASE = 'Diese Aktion jetzt verbindlich bestätigen';

function copyProvenance(provenance: ActionProvenance): ActionProvenance {
  const evidenceScope = provenance.evidenceScope.kind === 'clause'
    ? {
      kind: provenance.evidenceScope.kind,
      intentId: provenance.evidenceScope.intentId,
      ordinal: provenance.evidenceScope.ordinal,
      startOffset: provenance.evidenceScope.startOffset,
      endOffset: provenance.evidenceScope.endOffset,
    } as const
    : { kind: provenance.evidenceScope.kind } as const;
  const base = {
    sourceTurnId: provenance.sourceTurnId,
    decisionSource: provenance.decisionSource,
    validation: provenance.validation,
    evidenceScope,
    ...(provenance.interactionContext ? {
      interactionContext: {
        kind: provenance.interactionContext.kind,
        contextTurnId: provenance.interactionContext.contextTurnId,
      },
    } : {}),
    ...(provenance.parameterResolution ? {
      parameterResolution: {
        kind: provenance.parameterResolution.kind,
        role: provenance.parameterResolution.role,
        programName: provenance.parameterResolution.programName,
      },
    } : {}),
  } as const;
  if (provenance.evidenceSource === 'custom_command_expansion') {
    return {
      ...base,
      evidenceSource: provenance.evidenceSource,
      customCommand: provenance.customCommand,
    };
  }
  return { ...base, evidenceSource: provenance.evidenceSource };
}

function copyIntent(intent: ActionIntent): ActionIntent {
  return {
    action: intent.action,
    param: intent.param,
    provenance: copyProvenance(intent.provenance),
  };
}

function matchesProvenance(left: ActionProvenance, right: ActionProvenance): boolean {
  if (
    left.sourceTurnId !== right.sourceTurnId
    || left.decisionSource !== right.decisionSource
    || left.validation !== right.validation
    || left.evidenceSource !== right.evidenceSource
    || left.evidenceScope.kind !== right.evidenceScope.kind
    || left.interactionContext?.kind !== right.interactionContext?.kind
    || left.interactionContext?.contextTurnId !== right.interactionContext?.contextTurnId
    || Boolean(left.parameterResolution) !== Boolean(right.parameterResolution)
    || left.parameterResolution?.kind !== right.parameterResolution?.kind
    || left.parameterResolution?.role !== right.parameterResolution?.role
    || left.parameterResolution?.programName !== right.parameterResolution?.programName
  ) return false;
  if (left.evidenceScope.kind === 'clause' && right.evidenceScope.kind === 'clause') {
    if (
      left.evidenceScope.intentId !== right.evidenceScope.intentId
      || left.evidenceScope.ordinal !== right.evidenceScope.ordinal
      || left.evidenceScope.startOffset !== right.evidenceScope.startOffset
      || left.evidenceScope.endOffset !== right.evidenceScope.endOffset
    ) return false;
  }
  if (
    left.evidenceSource === 'custom_command_expansion'
    && right.evidenceSource === 'custom_command_expansion'
  ) return left.customCommand === right.customCommand;
  return left.evidenceSource === 'user_text' && right.evidenceSource === 'user_text';
}

function matchesIntent(left: ActionIntent, right: ActionIntent): boolean {
  return left.action === right.action
    && left.param === right.param
    && matchesProvenance(left.provenance, right.provenance);
}

function normalizeConfirmationText(text: string): string {
  return text
    .normalize('NFKC')
    .trim()
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('de-DE');
}

export type ActionConfirmationIntent = 'confirm' | 'cancel' | 'none';

/**
 * @param value - Text- oder Sprachäußerung während genau einer offenen Bestätigung.
 *
 * - Wertet Verneinung und Abbruch immer vor Zustimmung aus.
 * - Akzeptiert kurze natürliche Zustimmungen nur innerhalb des offenen Vorgangs.
 * - Verwendet keine freie LLM-Entscheidung für die Sicherheitsgrenze.
 *
 * @returns Bestätigen, abbrechen oder keine eindeutige Absicht.
 *
 * @category Authorization Validation
 */
export function resolveActionConfirmationIntent(value: string): ActionConfirmationIntent {
  const normalized = normalizeConfirmationText(value);
  if (!normalized) return 'none';

  if (
    /^(?:nein|abbruch|(?:bitte\s+)?abbrechen|stopp|stoppen)$/u.test(normalized)
    || /\b(?:doch|lieber)\s+nicht\b/u.test(normalized)
    || /\bnicht\s+(?:bestätigen|ausführen|buchen|bestellen|löschen|starten)\b/u.test(normalized)
    || /^(?:lass|lassen)\s+(?:es|das)(?:\s+sein)?$/u.test(normalized)
  ) return 'cancel';

  if (normalized === normalizeConfirmationText(SPOKEN_ACTION_CONFIRMATION_PHRASE)) {
    return 'confirm';
  }
  if (/^(?:ja(?:\s+bitte)?|okay|ok)$/u.test(normalized)) return 'confirm';
  if (/^(?:ja[,\s]+)?(?:ich\s+)?bestätig(?:e|en)(?:\s+(?:das|die aktion|den auftrag))?(?:\s+jetzt)?$/u.test(normalized)) {
    return 'confirm';
  }
  if (/^(?:ja[,\s]+)?(?:ich\s+)?bestätig(?:e|en)\s+(?:diese\s+aktion|den\s+auftrag)(?:\s+jetzt)?$/u.test(normalized)) {
    return 'confirm';
  }
  if (/^(?:ja[,\s]+)?(?:du\s+)?darfst\s+(?:das|diese\s+aktion|die aktion)(?:\s+ausführen)?$/u.test(normalized)) {
    return 'confirm';
  }
  if (/^(?:ja[,\s]+)?(?:mach|mache|führ|führe)\s+(?:das|die aktion)(?:\s+aus)?$/u.test(normalized)) {
    return 'confirm';
  }
  if (/^(?:jetzt\s+)?(?:buchen|bestellen|löschen|ausführen|starten)$/u.test(normalized)) {
    return 'confirm';
  }
  return 'none';
}

export function isSpokenActionConfirmationPhrase(value: string): boolean {
  return resolveActionConfirmationIntent(value) === 'confirm';
}

/**
 * Verwaltet kurzlebige, einmalig nutzbare Zustimmungen zwischen Router und ActionService.
 * Eine Zustimmung ist an Vorschlags-Turn, Bestätigungs-Turn, Action und Parameter gebunden.
 *
 * @category Authorization Service
 */
export class ActionConfirmationGate {
  private readonly pending = new Map<string, PendingAction>();
  private readonly approvals = new Map<string, Approval>();
  private readonly recoverableApprovals = new Map<string, Approval>();

  constructor(
    private readonly ttlMs = DEFAULT_CONFIRMATION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Registriert eine bestätigungspflichtige Action und gibt deren einmalige ID zurück. */
  request(
    requestedTurnId: TurnId,
    intent: ActionIntent,
    sourceRequestId?: string,
  ): string | null {
    this.removeExpired();
    if (intent.provenance.sourceTurnId !== requestedTurnId) return null;
    for (const [id, pending] of this.pending) {
      if (
        matchesIntent(pending.intent, intent)
        && pending.sourceRequestId === sourceRequestId
      ) {
        if (pending.requestedTurnId !== requestedTurnId) {
          this.pending.delete(id);
          break;
        }
        pending.expiresAt = this.now() + this.ttlMs;
        return id;
      }
    }
    this.pending.clear();
    const confirmationId = randomUUID();
    this.pending.set(confirmationId, {
      requestedTurnId,
      intent: copyIntent(intent),
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
      intent: copyIntent(pending.intent),
      ...(pending.sourceRequestId ? { sourceRequestId: pending.sourceRequestId } : {}),
    };
    this.approvals.set(confirmationId, {
      ...confirmed,
      intent: copyIntent(confirmed.intent),
      expiresAt: this.now() + this.ttlMs,
    });
    return { ...confirmed, intent: copyIntent(confirmed.intent) };
  }

  /** Bestätigt die einzige offene Action über die fest vorgegebene Sprachphrase. */
  approveSpoken(phrase: string, confirmationTurnId: TurnId): ConfirmedAction | null {
    this.removeExpired();
    if (!isSpokenActionConfirmationPhrase(phrase) || this.pending.size !== 1) return null;
    const confirmationId = this.pending.keys().next().value as string | undefined;
    return confirmationId ? this.approve(confirmationId, confirmationTurnId) : null;
  }

  /** Ob genau ein offener Vorschlag per Sprachphrase eindeutig bestätigt werden kann. */
  hasSinglePending(): boolean {
    this.removeExpired();
    return this.pending.size === 1;
  }

  /** Bricht den einzigen offenen Vorschlag ab; mehrdeutige Zustände werden nie geraten. */
  cancelSinglePending(): boolean {
    this.removeExpired();
    if (this.pending.size !== 1) return false;
    this.pending.clear();
    return true;
  }

  /** Verbraucht eine exakt passende Zustimmung; abweichende oder wiederholte Requests werden abgewiesen. */
  consume(
    confirmationTurnId: TurnId,
    intent: ActionIntent,
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
      || !matchesIntent(approval.intent, intent)
      || approval.sourceRequestId !== sourceRequestId
    ) return false;
    this.approvals.delete(reference.confirmationId);
    return true;
  }

  /**
   * Führt eine noch nicht verbrauchte Zustimmung in ihren erneut bestätigbaren Vorschlag zurück.
   * Nach dem synchronen Consume durch den ActionService bleibt sie unwiderruflich verbraucht.
   */
  restorePending(confirmed: ConfirmedAction): boolean {
    this.removeExpired();
    const id = confirmed.confirmation.confirmationId;
    const approval = this.approvals.get(id) ?? this.recoverableApprovals.get(id);
    if (!approval || !this.matchesApproval(approval, confirmed)) return false;
    this.approvals.delete(id);
    this.recoverableApprovals.delete(id);
    this.pending.set(id, {
      requestedTurnId: confirmed.confirmation.requestedTurnId,
      intent: copyIntent(confirmed.intent),
      ...(confirmed.sourceRequestId ? { sourceRequestId: confirmed.sourceRequestId } : {}),
      expiresAt: this.now() + this.ttlMs,
    });
    return true;
  }

  /** Verwirft offene Vorschläge, die ein abgebrochener oder fehlerhafter Turn erzeugt hat. */
  invalidatePendingForTurn(turnId: TurnId): void {
    this.removeExpired();
    for (const [id, pending] of this.pending) {
      if (pending.requestedTurnId === turnId) this.pending.delete(id);
    }
  }

  /** Verwirft Vorschläge und noch nicht verbrauchte Zustimmungen eines fehlgeschlagenen Turns. */
  invalidateTurn(turnId: TurnId): void {
    this.invalidatePendingForTurn(turnId);
    for (const [id, approval] of this.approvals) {
      if (approval.confirmation.requestedTurnId === turnId) {
        this.approvals.delete(id);
      } else if (approval.confirmationTurnId === turnId) {
        this.approvals.delete(id);
        this.recoverableApprovals.set(id, approval);
      }
    }
    for (const [id, approval] of this.recoverableApprovals) {
      if (approval.confirmation.requestedTurnId === turnId) {
        this.recoverableApprovals.delete(id);
      }
    }
  }

  /** Verwirft alle offenen Vorschläge und Zustimmungen beim Service-Shutdown. */
  clear(): void {
    this.pending.clear();
    this.approvals.clear();
    this.recoverableApprovals.clear();
  }

  private removeExpired(): void {
    const current = this.now();
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= current) this.pending.delete(id);
    }
    for (const [id, approval] of this.approvals) {
      if (approval.expiresAt <= current) this.approvals.delete(id);
    }
    for (const [id, approval] of this.recoverableApprovals) {
      if (approval.expiresAt <= current) this.recoverableApprovals.delete(id);
    }
  }

  private matchesApproval(left: ConfirmedAction, right: ConfirmedAction): boolean {
    return left.confirmation.confirmationId === right.confirmation.confirmationId
      && left.confirmation.requestedTurnId === right.confirmation.requestedTurnId
      && left.confirmationTurnId === right.confirmationTurnId
      && matchesIntent(left.intent, right.intent)
      && left.sourceRequestId === right.sourceRequestId;
  }
}
