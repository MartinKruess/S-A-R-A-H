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
import type { Trust } from '../../core/config-schema.js';
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
  confirmationGate?: ActionConfirmationGate;
  getConfirmationLevel?: () => ConfirmationLevel;
  getFileAccess?: () => Trust['fileAccess'];
  getWebAccessAllowed?: () => boolean;
}

export interface ActionServiceOptions {
  drainTimeoutMs?: number;
}

const DEFAULT_ACTION_DRAIN_TIMEOUT_MS = 2_000;

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
    operation: Promise<LaunchResult>;
    controller: AbortController;
  }>();
  private readonly seenRequestIds = new Set<string>();
  private readonly drainTimeoutMs: number;
  private readonly confirmationGate: ActionConfirmationGate;
  private readonly getConfirmationLevel: () => ConfirmationLevel;
  private readonly getFileAccess: () => Trust['fileAccess'];
  private readonly getWebAccessAllowed: () => boolean;

  constructor(
    private bus: MessageBus,
    private deps: ActionDeps,
    options: ActionServiceOptions = {},
  ) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_ACTION_DRAIN_TIMEOUT_MS;
    this.confirmationGate = deps.confirmationGate ?? new ActionConfirmationGate();
    this.getConfirmationLevel = deps.getConfirmationLevel ?? (() => 'standard');
    this.getFileAccess = deps.getFileAccess ?? (() => 'specific-folders');
    this.getWebAccessAllowed = deps.getWebAccessAllowed ?? (() => true);
  }

  async init(): Promise<void> {
    this.deps.system.setNotifyHandler((speak) => {
      this.bus.emit(this.id, 'action:notify', { notificationId: randomUUID(), speak });
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
    const { turnId, requestId, action, param, sourceRequestId, confirmation } = msg.data;
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
      controller.signal,
    );
    this.activeActions.set(requestId, { turnId, operation, controller });
    void operation
      .then((result) => {
        // The adapter side effect is authoritative once its result is ready.
        // Remove it before emitting because a synchronous terminal listener
        // must not cancel a successfully accepted long-lived effect (timer).
        this.activeActions.delete(requestId);
        if (
          controller.signal.aborted
          || this.status !== 'running'
          || this.bus.isTurnTerminal(turnId)
        ) return;
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
    result: LaunchResult,
  ): void {
    console.log('[Actions] completed', { action, ok: result.ok, hasSpeech: result.speak != null });
    // Exactly ONE result per request — also for silent successes (Spec §3).
    this.bus.emit(this.id, 'action:result', {
      turnId,
      requestId,
      action,
      ok: result.ok,
      ...(result.speak != null && { speak: result.speak }),
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
    signal: AbortSignal,
  ): Promise<LaunchResult> {
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
      case 'set_timer':
        return this.deps.system.setTimer(parsed.data as number, signal);
      case 'lock_screen':
        return this.deps.system.lockScreen(signal);
    }
  }
}
