import { mustKeepTurnTransient, type TurnPersistencePolicy } from '../../core/memory-policy.js';
import type { TurnId } from '../../core/turn-contract.js';
import { throwIfAborted } from '../../core/abort-utils.js';
import type { SensitiveTurnGuard } from './sensitive-turn-guard.js';
import type { RouterHistoryEntry } from './router-context-builder.js';

const MAX_LIVE_HISTORY_TURNS = 24;

export interface RouterTurnDraft {
  historyUser: string;
  persistedUser: string;
  assistants: string[];
  persistence: TurnPersistencePolicy;
  inheritedTransient: boolean;
  inheritedPrivateContext: boolean;
  externalData: boolean;
  localData: boolean;
  workerOutputStarted: boolean;
  commitStarted: boolean;
  suppressHistory: boolean;
  privateTurn: boolean;
  privateContext: boolean;
  recalledContents: string[];
  sensitiveGuard: SensitiveTurnGuard;
}

interface RouterTurnPersistenceOptions {
  drafts: Map<TurnId, RouterTurnDraft>;
  getHistory: () => RouterHistoryEntry[];
  setHistory: (history: RouterHistoryEntry[]) => void;
  getMemoryPolicyReady: () => boolean;
  getLivePolicy: () => TurnPersistencePolicy;
  isIncognitoActive: () => boolean;
  incognitoTurnIds: Set<TurnId>;
  persistTurn: (
    turnId: TurnId,
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
    policy: TurnPersistencePolicy,
    signal: AbortSignal,
  ) => Promise<void>;
}

/** Commits completed or interrupted turns to bounded live history and durable storage. */
export class RouterTurnPersistence {
  constructor(private readonly options: RouterTurnPersistenceOptions) {}

  async commit(turnId: TurnId, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const draft = this.options.drafts.get(turnId);
    if (!draft) return;
    if (draft.suppressHistory) {
      throwIfAborted(signal);
      this.options.drafts.delete(turnId);
      return;
    }
    const livePolicy = this.options.getLivePolicy();
    const effectivePolicy: TurnPersistencePolicy = {
      allowed: draft.persistence.allowed && this.options.getMemoryPolicyReady() && livePolicy.allowed,
      exclusions: [...new Set([...draft.persistence.exclusions, ...livePolicy.exclusions])],
    };
    const transient = draft.inheritedTransient || draft.externalData || draft.localData || mustKeepTurnTransient(
      [draft.persistedUser, draft.historyUser, ...draft.assistants],
      effectivePolicy,
    );
    if (!transient) {
      await this.options.persistTurn(turnId, [
        { role: 'user', content: draft.persistedUser },
        ...draft.assistants.map((content) => ({ role: 'assistant' as const, content })),
      ], effectivePolicy, signal);
    }
    throwIfAborted(signal);

    let history = this.options.getHistory();
    if (draft.inheritedTransient && !this.options.isIncognitoActive()) {
      history = history.filter((entry) => (
        !entry.transient && !entry.externalData && !entry.localData
      ));
    }
    if (draft.inheritedPrivateContext && !this.options.isIncognitoActive()) {
      this.options.setHistory(history);
      this.options.drafts.delete(turnId);
      return;
    }
    history.push({
      turnId,
      role: 'user',
      content: draft.historyUser,
      transient,
      privateContext: draft.privateContext,
      externalData: false,
      localData: false,
    });
    for (const content of draft.assistants) {
      history.push({
        turnId,
        role: 'assistant',
        content,
        transient,
        privateContext: draft.privateContext,
        externalData: draft.externalData && content === draft.assistants[draft.assistants.length - 1],
        localData: draft.localData && content === draft.assistants[draft.assistants.length - 1],
      });
    }
    if (draft.privateTurn && this.options.isIncognitoActive()) {
      this.options.incognitoTurnIds.add(turnId);
    }
    this.options.setHistory(trimLiveHistory(history));
    this.options.drafts.delete(turnId);
  }

  /** Retains only the user's live-session context after an interrupted worker response. */
  retainInterruptedUser(turnId: TurnId): void {
    const draft = this.options.drafts.get(turnId);
    if (!draft) return;
    this.options.drafts.delete(turnId);
    const transient = draft.inheritedTransient || draft.externalData || draft.localData || mustKeepTurnTransient(
      [draft.persistedUser, draft.historyUser],
      draft.persistence,
    );
    const history = this.options.getHistory();
    history.push({
      turnId,
      role: 'user',
      content: draft.historyUser,
      transient,
      privateContext: draft.privateContext,
      externalData: false,
      localData: false,
    });
    if (draft.privateTurn && this.options.isIncognitoActive()) {
      this.options.incognitoTurnIds.add(turnId);
    }
    this.options.setHistory(trimLiveHistory(history));
  }
}

function trimLiveHistory(history: RouterHistoryEntry[]): RouterHistoryEntry[] {
  const turnIds: TurnId[] = [];
  for (const entry of history) {
    if (turnIds[turnIds.length - 1] !== entry.turnId) turnIds.push(entry.turnId);
  }
  if (turnIds.length <= MAX_LIVE_HISTORY_TURNS) return history;
  const firstKeptTurnId = turnIds[turnIds.length - MAX_LIVE_HISTORY_TURNS];
  const firstKeptIndex = history.findIndex((entry) => entry.turnId === firstKeptTurnId);
  return firstKeptIndex > 0 ? history.slice(firstKeptIndex) : history;
}
