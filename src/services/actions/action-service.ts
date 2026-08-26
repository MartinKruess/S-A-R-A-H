// src/services/actions/action-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { MessageBus } from '../../core/message-bus.js';
import type { ProgramLauncher, ProgramEntry, LaunchResult } from '../../main/program-launcher.js';
import type { SystemActions } from './system-actions.js';
import type { SpotifyActions } from './spotify-actions.js';
import type { MediaController } from './media-controller.js';
import { ACTION_SCHEMAS, isActionName } from './action-schemas.js';
import { throwIfAborted, waitForSettlement } from '../../core/abort-utils.js';

/** Structural view of SearchService (Task 9) — keeps this task testable standalone. */
export interface SearchLike {
  runSearch(query: string, signal?: AbortSignal): Promise<string>;
  showResult(param: string, signal?: AbortSignal): Promise<LaunchResult>;
}

export interface ActionDeps {
  launcher: ProgramLauncher;
  getPrograms: () => ProgramEntry[];
  search: SearchLike;
  system: SystemActions;
  spotify: SpotifyActions;
  media: MediaController;
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
  readonly subscriptions = ['action:request'] as const;
  status: ServiceStatus = 'pending';
  private activeActions = new Map<Promise<LaunchResult>, AbortController>();
  private readonly drainTimeoutMs: number;

  constructor(
    private bus: MessageBus,
    private deps: ActionDeps,
    options: ActionServiceOptions = {},
  ) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_ACTION_DRAIN_TIMEOUT_MS;
  }

  async init(): Promise<void> {
    this.deps.system.setNotifyHandler((speak) => {
      this.bus.emit(this.id, 'action:notify', { speak });
    });
    this.status = 'running';
  }

  async destroy(): Promise<void> {
    this.status = 'stopped';
    this.deps.system.setNotifyHandler(() => {});
    this.deps.system.clearAllTimers();
    const active = [...this.activeActions.entries()];
    for (const [, controller] of active) controller.abort();
    if (active.length > 0) {
      await waitForSettlement(
        Promise.allSettled(active.map(([operation]) => operation)),
        this.drainTimeoutMs,
      );
    }
    this.activeActions.clear();
  }

  onMessage(msg: TypedBusMessage): void {
    if (msg.topic !== 'action:request' || this.status !== 'running') return;
    const { requestId, action, param } = msg.data;
    const controller = new AbortController();
    const operation = this.execute(action, param, controller.signal);
    this.activeActions.set(operation, controller);
    void operation
      .then((result) => {
        if (controller.signal.aborted || this.status !== 'running') return;
        this.emitResult(requestId, action, param, result);
      }, (err) => {
        if (controller.signal.aborted || this.status !== 'running') return;
        console.warn('[Actions] dispatch failed:', action, err);
        this.emitResult(requestId, action, param, {
          ok: false,
          speak: action === 'web_search' ? 'Meine Suche klemmt gerade.' : 'Das kann ich noch nicht.',
        });
      })
      .finally(() => {
        this.activeActions.delete(operation);
      });
  }

  private emitResult(requestId: string, action: string, param: string, result: LaunchResult): void {
    console.log(
      `[Actions] ${action}:${JSON.stringify(param)} → ok=${result.ok}` +
        (result.speak != null ? ` speak=${JSON.stringify(result.speak)}` : ' (silent)'),
    );
    // Exactly ONE result per request — also for silent successes (Spec §3).
    this.bus.emit(this.id, 'action:result', {
      requestId,
      action,
      ok: result.ok,
      ...(result.speak != null && { speak: result.speak }),
    });
  }

  private async execute(action: string, param: string, signal: AbortSignal): Promise<LaunchResult> {
    throwIfAborted(signal);
    if (!isActionName(action)) {
      console.warn('[Actions] unknown action refused:', action, param);
      return { ok: false, speak: 'Das kann ich noch nicht.' };
    }
    const parsed = ACTION_SCHEMAS[action].safeParse(param);
    if (!parsed.success) {
      console.warn('[Actions] invalid param refused:', action, JSON.stringify(param));
      return { ok: false, speak: 'Das kann ich noch nicht.' };
    }

    switch (action) {
      case 'open_program':
        if (process.platform !== 'win32') return { ok: false, speak: 'Das unterstützt dein System nicht.' };
        return this.deps.launcher.launch(parsed.data as string, this.deps.getPrograms(), signal);
      case 'web_search':
        return { ok: true, speak: await this.deps.search.runSearch(parsed.data as string, signal) };
      case 'show_browser':
        return this.deps.search.showResult(parsed.data as string, signal);
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
        return this.deps.system.setTimer(parsed.data as number);
      case 'lock_screen':
        return this.deps.system.lockScreen(signal);
    }
  }
}
