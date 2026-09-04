import { randomUUID } from 'crypto';
import type { AppContext } from '../../core/bootstrap.js';
import type { BusEvents } from '../../core/bus-events.js';
import { runWithTimeout, throwIfAborted } from '../../core/abort-utils.js';
import type { ActionConfirmationReference, ConfirmedAction } from '../../core/action-confirmation.js';
import type {
  ActionDecisionSource,
  ActionIntent,
  ActionInteractionContext,
  ActionProvenance,
  ActionValidation,
} from '../../core/action-intent.js';
import { isValidActionIntent } from '../../core/action-intent.js';
import type { TurnEnvelope, TurnId, TurnMode } from '../../core/turn-contract.js';
import type { ActionName } from '../actions/action-schemas.js';
import { ACTION_SCHEMAS, isActionName } from '../actions/action-schemas.js';
import { evaluateActionPolicy } from '../actions/action-policy.js';
import type { MediaAction } from '../actions/media-controller.js';
import type { ReminderClock } from '../actions/reminder-contract.js';
import { getActionAcknowledgement, getActionConfirmationDescription } from '../actions/action-feedback.js';
import { groundActionRequest } from './router-action-grounding.js';
import type { MediaContext } from './media-context.js';
import {
  createReminderCancelFollowupContext,
  parseReminderCancelFollowupIndex,
  REMINDER_CANCEL_TIME_FOLLOWUP_PATTERN,
  type ReminderCancelFollowupContext,
} from './router-reminder-routing.js';

interface RouterActionFlowDependencies {
  context: AppContext;
  serviceId: string;
  mediaContext: MediaContext;
  reminderClock: ReminderClock;
  actionResultTimeoutMs: number;
  isIncognitoActive(): boolean;
  getTurnPrivateContext(turnId: TurnId): boolean;
  emitAssistantResponse(
    turnId: TurnId,
    text: string,
    signal: AbortSignal,
    recordInHistory?: boolean,
    externalData?: boolean,
    localData?: boolean,
  ): Promise<void>;
  markBrowserSearchIntentTransient(turnId: TurnId, action: ActionName): void;
}

interface ActionDispatchOptions {
  decisionSource?: ActionDecisionSource;
  interactionContext?: {
    kind: ActionInteractionContext;
    contextTurnId: TurnId;
  };
  reminderCancelFollowupId?: number;
}

export type PlannedActionPreflightFailure =
  | 'action_service_unavailable'
  | 'invalid_intent'
  | 'confirmation_required'
  | 'policy_denied'
  | 'prepare_only';

export type PlannedActionPreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PlannedActionPreflightFailure };

export interface PlannedActionExecutionResult {
  readonly ok: boolean;
}

function createActionProvenance(
  envelope: TurnEnvelope,
  validation: ActionValidation,
  options: ActionDispatchOptions,
): ActionProvenance {
  const inputEvidence = envelope.command.kind === 'custom'
    ? {
      evidenceSource: 'custom_command_expansion' as const,
      customCommand: envelope.command.command,
    }
    : { evidenceSource: 'user_text' as const };
  return {
    sourceTurnId: envelope.turnId,
    decisionSource: options.decisionSource ?? 'router_model',
    validation,
    evidenceScope: { kind: 'whole_turn' },
    ...inputEvidence,
    ...(options.interactionContext ? { interactionContext: options.interactionContext } : {}),
  };
}

/** Coordinates action validation, confirmation, dispatch and correlated results. */
export class RouterActionFlow {
  private readonly pendingActions = new Map<string, {
    turnId: TurnId;
    action: string;
    resolve: (result: BusEvents['action:result']) => void;
  }>();
  private visibleSearchSession: { requestId: string; ownerTurnId: TurnId } | null = null;
  private readonly privateSearchSessionIds = new Set<string>();
  private pendingReminderCancelFollowup: ReminderCancelFollowupContext | null = null;

  constructor(private readonly deps: RouterActionFlowDependencies) {}

  get hasVisibleSearchSession(): boolean { return this.visibleSearchSession !== null; }
  get visibleSearchContextTurnId(): TurnId | null {
    return this.visibleSearchSession?.ownerTurnId ?? null;
  }

  clearVisibleSearchForTurn(turnId: TurnId): void {
    if (this.visibleSearchSession?.ownerTurnId === turnId) this.visibleSearchSession = null;
  }

  clearReminderFollowupForTurn(turnId: TurnId): void {
    if (this.pendingReminderCancelFollowup?.ownerTurnId === turnId) {
      this.pendingReminderCancelFollowup = null;
    }
  }

  clearReminderFollowup(): void {
    this.pendingReminderCancelFollowup = null;
  }

  handleActionResult(result: BusEvents['action:result']): void {
    const { requestId, turnId, action } = result;
    const pending = this.pendingActions.get(requestId);
    if (!pending || pending.action !== action || pending.turnId !== turnId) {
      console.warn('[Router] Dropping unknown/stale action:result', turnId, requestId, action);
      return;
    }
    this.pendingActions.delete(requestId);
    if (action === 'cancel_reminder') {
      this.pendingReminderCancelFollowup = createReminderCancelFollowupContext(
        turnId,
        result.reminderCancelAmbiguity,
        this.deps.reminderClock.nowMs(),
      );
    }
    pending.resolve(result);
  }

  discardPrivateSearchSessions(): void {
    for (const requestId of this.privateSearchSessionIds) {
      this.deps.context.bus.emit(this.deps.serviceId, 'search:discard-session', { requestId });
    }
    if (this.visibleSearchSession
      && this.privateSearchSessionIds.has(this.visibleSearchSession.requestId)) {
      this.visibleSearchSession = null;
    }
    this.privateSearchSessionIds.clear();
  }

  reset(): void {
    this.pendingActions.clear();
    this.visibleSearchSession = null;
    this.privateSearchSessionIds.clear();
    this.pendingReminderCancelFollowup = null;
  }

  private async dispatchAction(
    envelope: TurnEnvelope,
    intent: ActionIntent<ActionName>,
    acknowledgement: string,
    signal: AbortSignal,
    confirmation?: ActionConfirmationReference,
    confirmedSourceRequestId?: string,
    confirmedPrivateContext?: boolean,
    confirmedOriginMode?: TurnMode,
  ): Promise<boolean> {
    const { action, param } = intent;
    const actionService = this.deps.context.registry.get('actions');
    if (!actionService || actionService.status !== 'running') {
      await this.deps.emitAssistantResponse(
        envelope.turnId,
        'Aktionen sind gerade nicht verfügbar. Bitte versuche es gleich noch einmal.',
        signal,
      );
      return false;
    }
    this.deps.markBrowserSearchIntentTransient(envelope.turnId, action);
    await this.deps.emitAssistantResponse(envelope.turnId, acknowledgement, signal);
    throwIfAborted(signal);
    const requestId = randomUUID();
    const privateSearch = action === 'web_search'
      && (this.deps.isIncognitoActive() || envelope.command.kind === 'anonymous');
    if (privateSearch) this.privateSearchSessionIds.add(requestId);
    if (action === 'web_search') {
      // A new search owns the visible-result pointer. If it fails or is
      // canceled, a later "erstes Ergebnis" must not reopen stale results.
      this.visibleSearchSession = null;
    }
    const resultPromise = new Promise<BusEvents['action:result']>((resolve) => {
      this.pendingActions.set(requestId, { turnId: envelope.turnId, action, resolve });
    });
    this.deps.context.bus.emit(this.deps.serviceId, 'action:request', {
      turnId: envelope.turnId,
      requestId,
      ...intent,
      originMode: confirmedOriginMode ?? envelope.mode,
      privateContext: confirmedPrivateContext
        ?? (this.deps.isIncognitoActive() || envelope.command.kind === 'anonymous'),
      ...((confirmedSourceRequestId || (action === 'show_browser' && this.visibleSearchSession))
        ? { sourceRequestId: confirmedSourceRequestId ?? this.visibleSearchSession?.requestId }
        : {}),
      ...(confirmation ? { confirmation } : {}),
    });
    try {
      const result = await runWithTimeout(
        () => resultPromise,
        this.deps.actionResultTimeoutMs,
        'Action timed out',
        signal,
      );
      throwIfAborted(signal);
      if (result.ok && action.startsWith('media_')) {
        this.deps.mediaContext.record(action as MediaAction, Date.now(), envelope.turnId);
      }
      if (action === 'web_search' && result.ok) {
        if (privateSearch && !this.deps.isIncognitoActive()) {
          this.visibleSearchSession = null;
        } else {
          this.visibleSearchSession = { requestId, ownerTurnId: envelope.turnId };
        }
      }
      if (result.speak) {
        const reminderStoreData = action === 'list_reminders' || action === 'cancel_reminder';
        await this.deps.emitAssistantResponse(
          envelope.turnId,
          result.speak,
          signal,
          true,
          action === 'web_search' || action === 'show_browser',
          action === 'open_program' || reminderStoreData,
        );
      }
      return result.ok;
    } catch (error) {
      this.deps.context.bus.emit(this.deps.serviceId, 'action:cancel', {
        turnId: envelope.turnId,
        requestId,
        reason: error instanceof Error ? error.message : 'Action canceled',
      });
      throw error;
    } finally {
      this.pendingActions.delete(requestId);
      if (privateSearch && !this.deps.isIncognitoActive()) {
        this.deps.context.bus.emit(this.deps.serviceId, 'search:discard-session', { requestId });
        this.privateSearchSessionIds.delete(requestId);
        if (this.visibleSearchSession?.requestId === requestId) this.visibleSearchSession = null;
      }
    }
  }

  /**
   * Checks whether an immutable, clause-grounded plan action can start now.
   *
   * - Reads current ActionService and trust-policy state without emitting output.
   * - Accepts only immediately allowed actions; confirmation and preparation are explicit failures.
   * - Does not replace the authoritative ActionService validation at execution time.
   *
   * @returns Side-effect-free current preflight decision.
   *
   * @category Validation Authorization
   */
  preflightPlannedAction(intent: ActionIntent): PlannedActionPreflightResult {
    const actionService = this.deps.context.registry.get('actions');
    if (!actionService || actionService.status !== 'running') {
      return { ok: false, reason: 'action_service_unavailable' };
    }
    if (
      !isValidActionIntent(intent)
      || intent.provenance.validation !== 'semantic_grounding'
      || intent.provenance.evidenceScope.kind !== 'clause'
    ) {
      return { ok: false, reason: 'invalid_intent' };
    }
    const parsed = ACTION_SCHEMAS[intent.action].safeParse(intent.param);
    if (!parsed.success || String(parsed.data) !== intent.param) {
      return { ok: false, reason: 'invalid_intent' };
    }
    const trust = this.deps.context.parsedConfig.trust;
    const policy = evaluateActionPolicy(intent.action, {
      confirmationLevel: trust.confirmationLevel,
      fileAccess: trust.fileAccess,
      webAccessAllowed: trust.webAccessAllowed,
      param: intent.param,
    });
    if (policy.effect === 'allow') return { ok: true };
    if (policy.effect === 'confirm') return { ok: false, reason: 'confirmation_required' };
    if (policy.effect === 'prepare_only') return { ok: false, reason: 'prepare_only' };
    return { ok: false, reason: 'policy_denied' };
  }

  /** Executes one pre-grounded plan action through the existing correlated action path. */
  async executePlannedAction(
    envelope: TurnEnvelope,
    intent: ActionIntent,
    signal: AbortSignal,
  ): Promise<PlannedActionExecutionResult> {
    const preflight = this.preflightPlannedAction(intent);
    if (!preflight.ok || !isValidActionIntent(intent)) {
      const message = preflight.ok
        ? 'Diese Planaktion ist nicht eindeutig dem aktuellen Auftrag zugeordnet.'
        : preflight.reason === 'action_service_unavailable'
          ? 'Aktionen sind gerade nicht verfügbar. Bitte versuche es gleich noch einmal.'
          : preflight.reason === 'confirmation_required'
            ? 'Diese Aktion benötigt zuerst eine einzelne Bestätigung.'
            : preflight.reason === 'policy_denied'
              ? 'Diese Aktion ist durch deine Berechtigungen gesperrt.'
              : preflight.reason === 'prepare_only'
                ? 'Ich kann diese Aktion nur vorbereiten, aber nicht verbindlich ausführen.'
                : 'Diese Planaktion ist nicht eindeutig dem aktuellen Auftrag zugeordnet.';
      await this.deps.emitAssistantResponse(envelope.turnId, message, signal);
      return { ok: false };
    }
    if (intent.provenance.sourceTurnId !== envelope.turnId) {
      await this.deps.emitAssistantResponse(
        envelope.turnId,
        'Diese Planaktion ist nicht eindeutig dem aktuellen Auftrag zugeordnet.',
        signal,
      );
      return { ok: false };
    }
    return {
      ok: await this.dispatchAction(
        envelope,
        intent,
        getActionAcknowledgement(intent.action, intent.param),
        signal,
      ),
    };
  }

  async dispatchOrRequestConfirmation(
    envelope: TurnEnvelope,
    action: ActionName,
    param: string,
    signal: AbortSignal,
    options: ActionDispatchOptions = {},
  ): Promise<void> {
    const grounding = groundActionRequest(
      action,
      param,
      envelope.effectiveText,
      this.deps.reminderClock,
      options.reminderCancelFollowupId,
    );
    if (!grounding.ok) {
      await this.deps.emitAssistantResponse(envelope.turnId, grounding.message, signal);
      return;
    }
    const validatedParam = grounding.param;
    const intent: ActionIntent<ActionName> = {
      action,
      param: validatedParam,
      provenance: createActionProvenance(envelope, grounding.validation, options),
    };
    const validatedAcknowledgement = getActionAcknowledgement(action, validatedParam);
    this.deps.markBrowserSearchIntentTransient(envelope.turnId, action);
    const trust = this.deps.context.parsedConfig.trust;
    const policy = evaluateActionPolicy(action, {
      confirmationLevel: trust.confirmationLevel,
      fileAccess: trust.fileAccess,
      webAccessAllowed: trust.webAccessAllowed,
      param: validatedParam,
    });
    if (policy.effect === 'deny') {
      await this.deps.emitAssistantResponse(
        envelope.turnId,
        policy.reason === 'web_access_disabled'
          ? 'Der Browserzugriff ist in den Einstellungen deaktiviert.'
          : 'Diese Aktion ist durch deine Berechtigungen gesperrt.',
        signal,
      );
      return;
    }
    if (policy.effect === 'prepare_only') {
      await this.deps.emitAssistantResponse(
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
      const confirmationId = this.deps.context.actionConfirmations.request(
        envelope.turnId,
        intent,
        this.deps.getTurnPrivateContext(envelope.turnId),
        sourceRequestId,
        envelope.mode,
      );
      if (!confirmationId) {
        await this.deps.emitAssistantResponse(
          envelope.turnId,
          'Diese Aktion ist nicht eindeutig dem aktuellen Auftrag zugeordnet.',
          signal,
        );
        return;
      }
      const description = getActionConfirmationDescription(action, validatedParam);
      const spokenConfirmationPrompt = `Soll ich ${description}? Sage oder schreibe „Bestätigen“ oder „Abbrechen“.`;
      const confirmationPrompt = `${spokenConfirmationPrompt} Alternativ im Textchat: /confirm ${confirmationId}`;
      if (envelope.mode === 'voice') {
        // Keep the technical fallback visible without making TTS read a UUID.
        this.deps.context.bus.emit(this.deps.serviceId, 'turn:output-policy', {
          turnId: envelope.turnId,
          speech: 'suppress',
        });
        this.deps.context.bus.emit(this.deps.serviceId, 'llm:filler', {
          turnId: envelope.turnId,
          text: spokenConfirmationPrompt,
        });
      }
      await this.deps.emitAssistantResponse(
        envelope.turnId,
        confirmationPrompt,
        signal,
      );
      return;
    }
    await this.dispatchAction(envelope, intent, validatedAcknowledgement, signal);
  }

  async handleReminderCancelFollowup(
    envelope: TurnEnvelope,
    signal: AbortSignal,
  ): Promise<boolean> {
    const context = this.pendingReminderCancelFollowup;
    if (!context) return false;
    if (this.deps.reminderClock.nowMs() > context.expiresAt) {
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
        await this.deps.emitAssistantResponse(
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
        {
          decisionSource: 'deterministic_shortcut',
          interactionContext: {
            kind: 'reminder_cancel_followup',
            contextTurnId: context.ownerTurnId,
          },
          reminderCancelFollowupId: candidate.id,
        },
      );
      return true;
    }

    if (!timeMatch) return true;
    const hour = timeMatch[1].padStart(2, '0');
    const minute = (timeMatch[2] ?? timeMatch[3] ?? '00').padStart(2, '0');
    const matches = context.candidates.filter((candidate) => candidate.dueLocal.endsWith(`T${hour}:${minute}`));
    if (matches.length !== 1) {
      await this.deps.emitAssistantResponse(
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
      {
        decisionSource: 'deterministic_shortcut',
        interactionContext: {
          kind: 'reminder_cancel_followup',
          contextTurnId: context.ownerTurnId,
        },
        reminderCancelFollowupId: candidate.id,
      },
    );
    return true;
  }

  async confirmAction(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    const confirmed = this.deps.context.actionConfirmations.approve(
      envelope.command.kind === 'confirmation' ? envelope.command.arguments : '',
      envelope.turnId,
    );
    if (!confirmed) {
      await this.deps.emitAssistantResponse(
        envelope.turnId,
        'Diese Bestätigung ist ungültig oder abgelaufen.',
        signal,
      );
      return;
    }
    await this.executeConfirmedAction(envelope, confirmed, signal);
  }

  async confirmSpokenAction(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    const confirmed = this.deps.context.actionConfirmations.approveSpoken(
      envelope.normalizedText,
      envelope.turnId,
    );
    if (!confirmed) {
      await this.deps.emitAssistantResponse(
        envelope.turnId,
        'Die Sprachbestätigung ist nicht eindeutig oder bereits abgelaufen. Nutze im Textchat die konkrete /confirm-ID.',
        signal,
      );
      return;
    }
    await this.executeConfirmedAction(envelope, confirmed, signal);
  }

  async cancelPendingAction(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    const canceled = this.deps.context.actionConfirmations.cancelSinglePending();
    await this.deps.emitAssistantResponse(
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
      this.deps.context.actionConfirmations.restorePending(confirmed);
      throw error;
    }
  }

  private async dispatchConfirmedAction(
    envelope: TurnEnvelope,
    confirmed: ConfirmedAction,
    signal: AbortSignal,
  ): Promise<void> {
    if (!isActionName(confirmed.intent.action)) {
      await this.deps.emitAssistantResponse(envelope.turnId, 'Diese Bestätigung ist ungültig.', signal);
      return;
    }
    const intent: ActionIntent<ActionName> = {
      ...confirmed.intent,
      action: confirmed.intent.action,
    };
    await this.dispatchAction(
      envelope,
      intent,
      getActionAcknowledgement(intent.action, intent.param),
      signal,
      confirmed.confirmation,
      confirmed.sourceRequestId,
      confirmed.privateContext,
      confirmed.originMode,
    );
  }


}
