// src/services/actions/action-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { BusEvents } from '../../core/bus-events.js';
import type { MessageBus } from '../../core/message-bus.js';
import type { ProgramLauncher, ProgramEntry, LaunchResult } from '../../main/program-launcher.js';
import type { SystemActions } from './system-actions.js';
import type { SpotifyActions } from './spotify-actions.js';
import type { MediaController } from './media-controller.js';
import { ACTION_SCHEMAS, isActionName } from './action-schemas.js';
import { evaluateActionPolicy } from './action-policy.js';
import { parseTimerRequest, parseTimerSelector } from './timer-contract.js';
import {
  createSystemReminderClock,
  parseCancelReminderParam,
  parseListReminderParam,
  parseSetReminderParam,
  resolveReminderDueLocal,
  type ReminderClock,
} from './reminder-contract.js';
import {
  ReminderServiceError,
  type ReminderCancelResult,
  type ReminderCancelSelector,
  type ReminderService,
} from '../reminders/reminder-service.js';
import type { ReminderAgendaItem } from '../reminders/reminder-types.js';
import type { Trust } from '../../core/config-schema.js';
import {
  mustKeepTurnTransient,
  type TurnPersistencePolicy,
} from '../../core/memory-policy.js';
import { throwIfAborted, waitForSettlement } from '../../core/abort-utils.js';
import { randomUUID } from 'crypto';
import {
  ActionConfirmationGate,
  type ConfirmationLevel,
} from '../../core/action-confirmation.js';

/** Structural view of SearchService (Task 9) — keeps this task testable standalone. */
export interface SearchLike {
  runSearch(
    query: string,
    correlation: { turnId: string; requestId: string },
    signal?: AbortSignal,
  ): Promise<string>;
  showResult(
    param: string,
    correlation: { turnId: string; requestId: string; sourceRequestId?: string },
    signal?: AbortSignal,
  ): Promise<LaunchResult>;
}

export interface ActionDeps {
  launcher: ProgramLauncher;
  getPrograms: () => ProgramEntry[];
  search: SearchLike;
  system: SystemActions;
  spotify: SpotifyActions;
  media: MediaController;
  reminders: Pick<ReminderService, 'create' | 'list' | 'cancel'>;
  reminderClock?: ReminderClock;
  confirmationGate?: ActionConfirmationGate;
  getConfirmationLevel: () => ConfirmationLevel;
  getFileAccess: () => Trust['fileAccess'];
  getWebAccessAllowed: () => boolean;
  getReminderPersistencePolicy?: () => TurnPersistencePolicy;
}

export interface ActionServiceOptions {
  drainTimeoutMs?: number;
}

const DEFAULT_ACTION_DRAIN_TIMEOUT_MS = 2_000;

type ActionExecutionResult = LaunchResult & {
  reminderCancelAmbiguity?: BusEvents['action:result']['reminderCancelAmbiguity'];
};

function nextLocalDate(date: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return null;
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function formatReminderDueLocal(dueLocal: string, nowLocal?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(dueLocal);
  if (!match) return dueLocal;
  const dueDate = `${match[1]}-${match[2]}-${match[3]}`;
  const currentDate = nowLocal?.slice(0, 10);
  if (currentDate === dueDate) return `um ${match[4]}:${match[5]} Uhr`;
  if (currentDate && nextLocalDate(currentDate) === dueDate) {
    return `morgen um ${match[4]}:${match[5]} Uhr`;
  }
  return `am ${Number(match[3])}.${Number(match[2])}.${match[1]} um ${match[4]}:${match[5]} Uhr`;
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function formatReminderList(items: readonly ReminderAgendaItem[], scope: 'today' | 'upcoming'): string {
  if (items.length === 0) {
    return scope === 'today'
      ? 'Heute stehen keine Erinnerungen an.'
      : 'Es gibt keine offenen Erinnerungen.';
  }
  const heading = scope === 'today'
    ? `Heute ${items.length === 1 ? 'steht eine Erinnerung' : `stehen ${items.length} Erinnerungen`} an.`
    : `${items.length === 1 ? 'Eine Erinnerung ist' : `${items.length} Erinnerungen sind`} offen.`;
  const entries = items.map((item, index) => (
    `${index + 1}. ${formatReminderDueLocal(item.dueLocal)}: ${ensureSentence(item.text)}`
  ));
  return [heading, ...entries].join(' ');
}

function formatReminderCancelResult(result: ReminderCancelResult, all: boolean): ActionExecutionResult {
  if (result.status === 'none') {
    return { ok: false, speak: 'Ich finde keine passende offene Erinnerung.' };
  }
  if (result.status === 'ambiguous') {
    return {
      ok: false,
      speak: `Es gibt mehrere passende Erinnerungen. Bitte nenne zusätzlich den Zeitpunkt, zum Beispiel: Die um 17:05 Uhr. ${formatReminderList(result.candidates, 'upcoming')}`,
      reminderCancelAmbiguity: {
        candidates: result.candidates.map(({ id, dueLocal }) => ({ id, dueLocal })),
      },
    };
  }
  if (result.status === 'already_firing') {
    return { ok: false, speak: 'Die passende Erinnerung ist bereits fällig und wird gerade ausgegeben.' };
  }
  if (result.status === 'partially_cancelled') {
    return {
      ok: true,
      speak: `${result.cancelled.length} Erinnerungen wurden abgebrochen. ${result.candidates.length} wurden nicht abgebrochen.`,
    };
  }
  if (all) {
    return {
      ok: true,
      speak: result.cancelled.length === 1
        ? 'Die offene Erinnerung wurde abgebrochen.'
        : `Alle ${result.cancelled.length} offenen Erinnerungen wurden abgebrochen.`,
    };
  }
  const [cancelled] = result.cancelled;
  return {
    ok: true,
    speak: cancelled
      ? `Die Erinnerung „${cancelled.text}“ wurde abgebrochen.`
      : 'Die Erinnerung wurde abgebrochen.',
  };
}

function reminderErrorResult(error: object): LaunchResult {
  if (error instanceof ReminderServiceError) {
    switch (error.code) {
      case 'not_persistent':
        return { ok: false, speak: 'Persistente Erinnerungen sind gerade nicht verfügbar.' };
      case 'past_due':
        return { ok: false, speak: 'Dieser Zeitpunkt liegt bereits in der Vergangenheit.' };
      case 'limit_reached':
        return { ok: false, speak: 'Es sind bereits zu viele offene Erinnerungen gespeichert.' };
      case 'invalid_input':
      case 'not_initialized':
        return { ok: false, speak: 'Die Erinnerung kann ich gerade nicht speichern.' };
    }
  }
  return { ok: false, speak: 'Die Erinnerungsfunktion ist gerade nicht verfügbar.' };
}

/**
 * Validates and dispatches actions. Deliberately NO AppContext (Mi1):
 * only the bus and its concrete deps — it can never touch history or DB.
 */
export class ActionService implements SarahService {
  readonly id = 'actions';
  readonly subscriptions = ['action:request', 'action:cancel', 'turn:cancel', 'turn:terminal'] as const;
  status: ServiceStatus = 'pending';
  private activeActions = new Map<string, {
    turnId: string;
    operation: Promise<ActionExecutionResult>;
    controller: AbortController;
  }>();
  private readonly seenRequestIds = new Set<string>();
  private readonly drainTimeoutMs: number;
  private readonly confirmationGate: ActionConfirmationGate;
  private readonly getConfirmationLevel: () => ConfirmationLevel;
  private readonly getFileAccess: () => Trust['fileAccess'];
  private readonly getWebAccessAllowed: () => boolean;
  private readonly getReminderPersistencePolicy: () => TurnPersistencePolicy;

  constructor(
    private bus: MessageBus,
    private deps: ActionDeps,
    options: ActionServiceOptions = {},
  ) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_ACTION_DRAIN_TIMEOUT_MS;
    this.confirmationGate = deps.confirmationGate ?? new ActionConfirmationGate();
    this.getConfirmationLevel = deps.getConfirmationLevel;
    this.getFileAccess = deps.getFileAccess;
    this.getWebAccessAllowed = deps.getWebAccessAllowed;
    this.getReminderPersistencePolicy = deps.getReminderPersistencePolicy
      ?? (() => ({ allowed: false, exclusions: [] }));
  }

  async init(): Promise<void> {
    this.deps.system.setNotifyHandler((speak, context) => {
      this.bus.emit(this.id, 'action:notify', {
        notificationId: randomUUID(),
        kind: 'timer',
        speak,
        originMode: context?.originMode ?? 'voice',
        privateContext: context?.privateContext ?? false,
      });
    });
    this.status = 'running';
  }

  async destroy(): Promise<void> {
    this.status = 'stopped';
    this.deps.system.setNotifyHandler(() => {});
    this.deps.system.clearAllTimers();
    const active = [...this.activeActions.values()];
    for (const { controller } of active) controller.abort();
    if (active.length > 0) {
      await waitForSettlement(
        Promise.allSettled(active.map(({ operation }) => operation)),
        this.drainTimeoutMs,
      );
    }
    this.activeActions.clear();
  }

  onMessage(msg: TypedBusMessage): void {
    if (msg.topic === 'action:cancel') {
      const active = this.activeActions.get(msg.data.requestId);
      if (active?.turnId === msg.data.turnId) active.controller.abort();
      return;
    }
    if (msg.topic === 'turn:cancel' || msg.topic === 'turn:terminal') {
      for (const { turnId, controller } of this.activeActions.values()) {
        if (turnId === msg.data.turnId) controller.abort();
      }
      return;
    }
    if (msg.topic !== 'action:request' || this.status !== 'running') return;
    const {
      turnId,
      requestId,
      action,
      param,
      sourceRequestId,
      confirmation,
      originMode,
      privateContext,
    } = msg.data;
    if (this.bus.isTurnTerminal(turnId)) {
      console.warn('[Actions] request for terminal turn refused', { action });
      return;
    }
    if (this.seenRequestIds.has(requestId)) {
      console.warn('[Actions] duplicate request refused', { action });
      return;
    }
    this.rememberRequestId(requestId);
    const controller = new AbortController();
    const operation = this.execute(
      turnId,
      requestId,
      action,
      param,
      sourceRequestId,
      confirmation,
      originMode ?? 'voice',
      privateContext ?? false,
      controller.signal,
    );
    this.activeActions.set(requestId, { turnId, operation, controller });
    void operation
      .then((result) => {
        // The adapter side effect is authoritative once its result is ready.
        // Remove it before emitting because a synchronous terminal listener
        // must not cancel a successfully accepted long-lived effect (timer).
        this.activeActions.delete(requestId);
        if (controller.signal.aborted || this.bus.isTurnTerminal(turnId)) {
          if (
            this.status === 'running'
            && result.ok
            && (action === 'set_reminder' || action === 'cancel_reminder')
            && result.speak
          ) {
            this.bus.emit(this.id, 'action:notify', {
              notificationId: randomUUID(),
              kind: 'reminder',
              speak: result.speak,
              originMode: originMode ?? 'chat',
              privateContext: privateContext ?? false,
            });
          }
          return;
        }
        if (this.status !== 'running') return;
        this.emitResult(turnId, requestId, action, param, result);
      }, (err) => {
        if (
          controller.signal.aborted
          || this.status !== 'running'
          || this.bus.isTurnTerminal(turnId)
        ) return;
        console.warn('[Actions] dispatch failed', {
          action,
          error: err instanceof Error ? err.name : 'NonError',
        });
        this.emitResult(turnId, requestId, action, param, {
          ok: false,
          speak: action === 'web_search' ? 'Meine Suche klemmt gerade.' : 'Das kann ich noch nicht.',
        });
      })
      .finally(() => {
        this.activeActions.delete(requestId);
      });
  }

  private emitResult(
    turnId: string,
    requestId: string,
    action: string,
    param: string,
    result: ActionExecutionResult,
  ): void {
    console.log('[Actions] completed', { action, ok: result.ok, hasSpeech: result.speak != null });
    // Exactly ONE result per request — also for silent successes (Spec §3).
    this.bus.emit(this.id, 'action:result', {
      turnId,
      requestId,
      action,
      ok: result.ok,
      ...(result.speak != null && { speak: result.speak }),
      ...(result.reminderCancelAmbiguity && {
        reminderCancelAmbiguity: result.reminderCancelAmbiguity,
      }),
    });
  }

  private rememberRequestId(requestId: string): void {
    this.seenRequestIds.add(requestId);
    if (this.seenRequestIds.size <= 1_000) return;
    const oldest = this.seenRequestIds.values().next().value as string | undefined;
    if (oldest) this.seenRequestIds.delete(oldest);
  }

  private async execute(
    turnId: string,
    requestId: string,
    action: string,
    param: string,
    sourceRequestId: string | undefined,
    confirmation: BusEvents['action:request']['confirmation'],
    originMode: NonNullable<BusEvents['action:request']['originMode']>,
    privateContext: boolean,
    signal: AbortSignal,
  ): Promise<ActionExecutionResult> {
    throwIfAborted(signal);
    if (!isActionName(action)) {
      console.warn('[Actions] unknown action refused');
      return { ok: false, speak: 'Das kann ich noch nicht.' };
    }
    const parsed = ACTION_SCHEMAS[action].safeParse(param);
    if (!parsed.success) {
      console.warn('[Actions] invalid param refused', { action });
      return { ok: false, speak: 'Das kann ich noch nicht.' };
    }
    const policy = evaluateActionPolicy(action, {
      confirmationLevel: this.getConfirmationLevel(),
      fileAccess: this.getFileAccess(),
      webAccessAllowed: this.getWebAccessAllowed(),
      param: String(parsed.data),
    });
    if (policy.effect === 'deny') {
      console.warn('[Actions] denied by policy', { action, reason: policy.reason });
      if (policy.reason === 'web_access_disabled') {
        return { ok: false, speak: 'Der Browserzugriff ist in den Einstellungen deaktiviert.' };
      }
      return { ok: false, speak: 'Diese Aktion ist durch deine Berechtigungen gesperrt.' };
    }
    if (policy.effect === 'prepare_only') {
      console.warn('[Actions] binding action restricted to preparation', { action });
      return { ok: false, speak: 'Ich kann diese Aktion nur vorbereiten, aber nicht verbindlich ausführen.' };
    }
    if (
      policy.effect === 'confirm'
      && !this.confirmationGate.consume(turnId, action, param, confirmation, sourceRequestId)
    ) {
      console.warn('[Actions] unconfirmed action refused', { action });
      return { ok: false, speak: 'Diese Aktion wurde nicht bestätigt.' };
    }

    switch (action) {
      case 'open_program':
        if (process.platform !== 'win32') return { ok: false, speak: 'Das unterstützt dein System nicht.' };
        return this.deps.launcher.launch(parsed.data as string, this.deps.getPrograms(), signal);
      case 'web_search':
        return {
          ok: true,
          speak: await this.deps.search.runSearch(parsed.data as string, { turnId, requestId }, signal),
        };
      case 'show_browser':
        return this.deps.search.showResult(
          parsed.data as string,
          { turnId, requestId, ...(sourceRequestId ? { sourceRequestId } : {}) },
          signal,
        );
      case 'set_volume':
        return this.deps.system.setVolume(parsed.data as number, signal);
      case 'spotify_volume':
        return this.deps.spotify.setVolume(parsed.data as number, signal);
      case 'spotify_volume_adjust':
        return this.deps.spotify.adjustVolume(parsed.data as number, signal);
      case 'media_play':
        return this.deps.media.play(parsed.data as string, signal);
      case 'media_pause':
        return this.deps.media.pause(parsed.data as string, signal);
      case 'media_toggle':
        return this.deps.media.toggle(parsed.data as string, signal);
      case 'media_next':
        return this.deps.media.next(parsed.data as string, signal);
      case 'media_previous':
        return this.deps.media.previous(parsed.data as string, signal);
      case 'set_timer': {
        const timer = parseTimerRequest(parsed.data as string);
        return timer
          ? this.deps.system.setTimer(timer, signal, { originMode, privateContext })
          : { ok: false, speak: 'Die Timerdauer ist ungültig.' };
      }
      case 'cancel_timer': {
        const selector = parseTimerSelector(parsed.data as string);
        return selector
          ? this.deps.system.cancelTimers(selector)
          : { ok: false, speak: 'Diesen Timer kann ich nicht eindeutig zuordnen.' };
      }
      case 'set_reminder': {
        const reminder = parseSetReminderParam(parsed.data as string);
        const clock = this.deps.reminderClock ?? createSystemReminderClock();
        const dueLocal = reminder ? resolveReminderDueLocal(reminder.schedule, clock) : null;
        if (!reminder || !dueLocal) {
          return { ok: false, speak: 'Zeitpunkt und Inhalt der Erinnerung sind nicht eindeutig.' };
        }
        if (privateContext || mustKeepTurnTransient(
          [reminder.text],
          this.getReminderPersistencePolicy(),
        )) {
          return {
            ok: false,
            speak: 'Diese Erinnerung kann ich aus Datenschutzgründen nicht dauerhaft speichern.',
          };
        }
        try {
          const created = await this.deps.reminders.create({
            dueLocal,
            text: reminder.text,
            originMode,
            privateContext,
          }, signal);
          return {
            ok: true,
            speak: `Ich erinnere dich ${formatReminderDueLocal(
              created.dueLocal,
              clock.toLocal(clock.nowMs()),
            )}: ${ensureSentence(created.text)}`,
          };
        } catch (error) {
          return reminderErrorResult(error instanceof Error ? error : new Error('Reminder creation failed'));
        }
      }
      case 'list_reminders': {
        const scope = parseListReminderParam(parsed.data as string);
        if (!scope) return { ok: false, speak: 'Diesen Zeitraum kann ich nicht auflisten.' };
        try {
          return { ok: true, speak: formatReminderList(await this.deps.reminders.list(scope, signal), scope) };
        } catch (error) {
          return reminderErrorResult(error instanceof Error ? error : new Error('Reminder listing failed'));
        }
      }
      case 'cancel_reminder': {
        const request = parseCancelReminderParam(parsed.data as string);
        if (!request) return { ok: false, speak: 'Diese Erinnerung kann ich nicht eindeutig zuordnen.' };
        let selector: ReminderCancelSelector;
        if (request.kind === 'all' || request.kind === 'id' || request.kind === 'text') {
          selector = request;
        } else {
          const clock = this.deps.reminderClock ?? createSystemReminderClock();
          const dueLocal = resolveReminderDueLocal(request.schedule, clock);
          if (!dueLocal) return { ok: false, speak: 'Dieser Erinnerungszeitpunkt ist nicht eindeutig.' };
          selector = request.text
            ? { kind: 'exact', dueLocal, text: request.text }
            : { kind: 'due', dueLocal };
        }
        try {
          return formatReminderCancelResult(
            await this.deps.reminders.cancel(selector, signal),
            request.kind === 'all',
          );
        } catch (error) {
          return reminderErrorResult(error instanceof Error ? error : new Error('Reminder cancellation failed'));
        }
      }
      case 'lock_screen':
        return this.deps.system.lockScreen(signal);
    }
  }
}
