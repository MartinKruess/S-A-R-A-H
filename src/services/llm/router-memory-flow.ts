import type { AppContext } from '../../core/bootstrap.js';
import { FALLBACK_CONVERSATION_ID } from '../../core/storage/conversation-store.js';
import { Layer2MemoryStore } from '../../core/storage/layer2-memory-store.js';
import {
  mustKeepTurnTransient,
  type TurnPersistencePolicy,
} from '../../core/memory-policy.js';
import type { TurnEnvelope, TurnId } from '../../core/turn-contract.js';
import type { MemoryCurator, MemoryCuratorRunResult } from './memory-curator.js';

const DELETE_ALL_MEMORY_CONFIRMATION_TIMEOUT_MS = 2 * 60_000;

interface RouterMemoryFlowOptions {
  context: AppContext;
  memoryStore: Layer2MemoryStore;
  memoryCurator: MemoryCurator;
  isMemoryPolicyReady: () => boolean;
  isIncognitoActive: () => boolean;
  getConversationId: () => number;
  runMutation: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  refreshCache: () => Promise<void>;
  warnPersistence: () => void;
  emitAssistantResponse: (turnId: TurnId, text: string, signal: AbortSignal) => Promise<void>;
}

/** Owns user-facing long-term-memory commands and explicit Memory Author runs. */
export class RouterMemoryFlow {
  private pendingDeleteAll: { ids: number[]; expiresAt: number } | null = null;

  constructor(private readonly options: RouterMemoryFlowOptions) {}

  reset(): void {
    this.pendingDeleteAll = null;
  }

  async handleCommand(envelope: TurnEnvelope, signal: AbortSignal): Promise<void> {
    if (envelope.command.kind !== 'memory') return;
    const { context, memoryStore, emitAssistantResponse } = this.options;
    const trust = context.parsedConfig.trust;
    if (this.options.isIncognitoActive()) {
      await emitAssistantResponse(
        envelope.turnId,
        'Im Anonymous-Modus kann ich Erinnerungen weder anzeigen noch verändern. Beende ihn zuerst mit /anonymous.',
        signal,
      );
      return;
    }
    if (!trust.memoryAllowed) {
      await emitAssistantResponse(envelope.turnId, 'Das Gedächtnis ist in den Einstellungen deaktiviert.', signal);
      return;
    }
    if (!this.options.isMemoryPolicyReady()) {
      await emitAssistantResponse(
        envelope.turnId,
        'Das Gedächtnis ist wegen eines Speicherfehlers vorübergehend gesperrt.',
        signal,
      );
      return;
    }

    const { command, arguments: args } = envelope.command;
    if (command === '/showcontext') {
      if (!trust.showContextEnabled) {
        await emitAssistantResponse(envelope.turnId, '/showcontext ist in den Einstellungen deaktiviert.', signal);
        return;
      }
      const memories = await memoryStore.listWithTopics({ includeDeleted: true });
      const byTopic = new Map<string, typeof memories>();
      for (const memory of memories) {
        const key = `${memory.topic.id}:${memory.topic.title}`;
        byTopic.set(key, [...(byTopic.get(key) ?? []), memory]);
      }
      const text = memories.length === 0
        ? 'Ich habe derzeit keine kuratierten Erinnerungen gespeichert.'
        : [...byTopic]
          .map(([topicKey, topicMemories]) => {
            const title = topicKey.slice(topicKey.indexOf(':') + 1);
            return [`## ${title}`, ...topicMemories.map((memory) => {
              const status = memory.deleted_at !== null || memory.status === 'deleted'
                ? 'deleted'
                : memory.status;
              return `${memory.id} [${memory.kind}, ${status}, Revision ${memory.revision}] ${memory.content} `
                + `(Quelle: Session ${memory.source_conversation_id ?? 'unbekannt'}, Turn ${memory.source_turn_id}, ${memory.created_at})`;
            })].join('\n');
          }).join('\n\n');
      await emitAssistantResponse(envelope.turnId, text, signal);
      return;
    }

    if (command === '/exportmemory') {
      if (!trust.showContextEnabled) {
        await emitAssistantResponse(envelope.turnId, '/exportmemory ist in den Einstellungen deaktiviert.', signal);
        return;
      }
      const memories = await memoryStore.listWithTopics({ includeDeleted: true });
      await emitAssistantResponse(envelope.turnId, JSON.stringify({
        exportedAt: new Date().toISOString(),
        memories: memories.map((memory) => ({
          id: memory.id,
          kind: memory.kind,
          content: memory.content,
          topic: memory.topic,
          status: memory.deleted_at !== null ? 'deleted' : memory.status,
          revision: memory.revision,
          supersededBy: memory.superseded_by_id,
          deletedAt: memory.deleted_at,
          evidence: {
            excerpt: memory.evidence,
            confirmationCount: memory.confirmation_count,
            lastConfirmedAt: memory.last_confirmed_at,
            sources: memory.sources.map((source) => ({
              type: source.source_type,
              conversationId: source.source_conversation_id,
              turnId: source.source_turn_id,
              observedAt: source.observed_at,
            })),
          },
          source: {
            conversationId: memory.source_conversation_id,
            turnId: memory.source_turn_id,
            createdAt: memory.created_at,
          },
        })),
      }, null, 2), signal);
      return;
    }

    if (command === '/remember') {
      const result = await this.authorExplicitMemory(envelope.turnId, args, signal);
      await emitAssistantResponse(envelope.turnId, memoryAuthorResponse(result), signal);
      return;
    }

    if (command === '/deletememory' && /^all(?:\s|$)/iu.test(args)) {
      await this.handleDeleteAll(envelope.turnId, args, signal);
      return;
    }

    const match = args.match(/^(\d+)(?:\s+([\s\S]+))?$/u);
    const id = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      await emitAssistantResponse(envelope.turnId, 'Bitte gib eine gültige Erinnerungs-ID an.', signal);
      return;
    }
    const changed = await this.options.runMutation(() => command === '/correctmemory'
      ? memoryStore.correct(
        id,
        match?.[2] ?? '',
        { allowed: true, exclusions: trust.memoryExclusions },
      )
      : command === '/forget'
        ? memoryStore.forget(id)
        : memoryStore.delete(id), signal);
    if (changed) await this.options.refreshCache();
    await emitAssistantResponse(
      envelope.turnId,
      changed ? `Erinnerung ${id} wurde aktualisiert.` : `Erinnerung ${id} wurde nicht gefunden oder konnte nicht geändert werden.`,
      signal,
    );
  }

  async authorExplicitMemory(
    turnId: TurnId,
    content: string,
    signal: AbortSignal,
  ): Promise<MemoryCuratorRunResult> {
    signal.throwIfAborted();
    const { context, memoryStore, memoryCurator } = this.options;
    const trust = context.parsedConfig.trust;
    const policy: TurnPersistencePolicy = {
      allowed: this.options.isMemoryPolicyReady()
        && trust.memoryAllowed
        && !this.options.isIncognitoActive(),
      exclusions: [...trust.memoryExclusions],
    };
    if (mustKeepTurnTransient([content], policy)) return { status: 'blocked' };
    const conversationId = this.options.getConversationId();
    if (conversationId === FALLBACK_CONVERSATION_ID) {
      this.options.warnPersistence();
      return { status: 'failed' };
    }
    try {
      return await this.options.runMutation(async () => {
        await memoryCurator.cancelAndWait();
        signal.throwIfAborted();
        const stagingId = await memoryStore.stageTurn(
          conversationId,
          turnId,
          [{ role: 'user', content }],
          policy,
        );
        if (stagingId == null) return { status: 'blocked' } as const;
        return memoryCurator.runStaging(stagingId, signal);
      }, signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      console.warn('[Router] Explicit Memory Author reconciliation failed');
      this.options.warnPersistence();
      return { status: 'failed' };
    }
  }

  private async handleDeleteAll(turnId: TurnId, args: string, signal: AbortSignal): Promise<void> {
    const { memoryStore, emitAssistantResponse } = this.options;
    const operation = args.slice(3).trim().toLowerCase();
    if (operation === 'abbrechen' || operation === 'cancel') {
      this.pendingDeleteAll = null;
      await emitAssistantResponse(turnId, 'Das Löschen aller Erinnerungen wurde abgebrochen.', signal);
      return;
    }
    if (operation === 'bestätigen' || operation === 'confirm') {
      const pending = this.pendingDeleteAll;
      this.pendingDeleteAll = null;
      if (!pending || pending.expiresAt < Date.now()) {
        await emitAssistantResponse(
          turnId,
          'Es gibt keine gültige Löschanfrage. Starte sie erneut mit /deletememory all.',
          signal,
        );
        return;
      }
      try {
        const deleted = await this.options.runMutation(() => memoryStore.deleteAll(pending.ids), signal);
        await this.options.refreshCache();
        await emitAssistantResponse(
          turnId,
          `${deleted} kuratierte ${deleted === 1 ? 'Erinnerung wurde' : 'Erinnerungen wurden'} endgültig gelöscht.`,
          signal,
        );
      } catch (error) {
        if (error instanceof Error
          && error.message === 'Curated memories changed after deletion was requested') {
          await emitAssistantResponse(
            turnId,
            'Die Erinnerungen haben sich seit der Anfrage geändert. Es wurde nichts gelöscht. Starte /deletememory all erneut.',
            signal,
          );
          return;
        }
        throw error;
      }
      return;
    }
    if (operation !== '') {
      await emitAssistantResponse(
        turnId,
        'Nutze /deletememory all, danach /deletememory all bestätigen oder /deletememory all abbrechen.',
        signal,
      );
      return;
    }
    const memories = await memoryStore.list({ includeDeleted: true });
    if (memories.length === 0) {
      this.pendingDeleteAll = null;
      await emitAssistantResponse(turnId, 'Es sind keine kuratierten Erinnerungen gespeichert.', signal);
      return;
    }
    this.pendingDeleteAll = {
      ids: memories.map(({ id }) => id),
      expiresAt: Date.now() + DELETE_ALL_MEMORY_CONFIRMATION_TIMEOUT_MS,
    };
    await emitAssistantResponse(
      turnId,
      `Alle ${memories.length} kuratierten Erinnerungen endgültig löschen? `
        + 'Bestätige mit /deletememory all bestätigen oder brich mit /deletememory all abbrechen ab.',
      signal,
    );
  }
}

export function memoryAuthorResponse(result: MemoryCuratorRunResult): string {
  if (result.status === 'blocked') return 'Das kann ich aus Datenschutzgründen nicht als Erinnerung übernehmen.';
  if (result.status !== 'applied') {
    return 'Ich konnte das gerade nicht zuverlässig einordnen. Es wurde keine neue Erinnerung bestätigt.';
  }
  const { action, memoryId } = result.result;
  if (action === 'ignore') return 'Das war bereits passend gespeichert; es wurde kein Duplikat angelegt.';
  const id = memoryId == null ? '' : ` ${memoryId}`;
  const descriptions = {
    add: `Erinnerung${id} wurde thematisch eingeordnet.`,
    update: `Erinnerung${id} wurde mit dem vorhandenen Wissen aktualisiert.`,
    merge: `Erinnerung${id} wurde mit passenden Einträgen zusammengeführt.`,
    supersede: `Erinnerung${id} ersetzt die veraltete Aussage.`,
  } as const;
  return descriptions[action];
}
