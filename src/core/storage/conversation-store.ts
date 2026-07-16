import type { StorageProvider, MessageRow } from './storage.interface.js';

/** Sentinel conversationId when the session row could not be created (in-memory mode). */
export const FALLBACK_CONVERSATION_ID = -1;
/** Fixed V1 start-context size (Spec B decision #1). */
export const START_CONTEXT_LIMIT = 20;

const LEGACY_CONVERSATION_ID = 1;

export interface ConversationBoot {
  /** The new session's conversations.id, or FALLBACK_CONVERSATION_ID on failure. */
  conversationId: number;
  /** Last messages from previous sessions, chronological (oldest first). Empty on failure. */
  startContext: MessageRow[];
  /** True when persistence is unavailable for this run. */
  degraded: boolean;
}

/**
 * Owns the conversation-session lifecycle: legacy repair, one session per boot,
 * and loading the start context (last N messages from previous sessions).
 * boot() never throws — every failure degrades to in-memory behavior (Spec B, H4).
 */
export class ConversationStore {
  constructor(private db: StorageProvider) {}

  async boot(): Promise<ConversationBoot> {
    // Order matters (Spec B, H1): repair must run before the session insert.
    // On a fresh conversations table the new session would otherwise take id 1,
    // and the exclusion filter would hide exactly the legacy messages.
    await this.repairLegacy();
    const conversationId = await this.createSession();
    const startContext = await this.loadStartContext(conversationId);
    return {
      conversationId,
      startContext,
      degraded: conversationId === FALLBACK_CONVERSATION_ID,
    };
  }

  private async repairLegacy(): Promise<void> {
    try {
      const existing = await this.db.query('conversations', { id: LEGACY_CONVERSATION_ID });
      if (existing.length > 0) return;
      const legacyMessages = await this.db.query('messages', { conversation_id: LEGACY_CONVERSATION_ID });
      if (legacyMessages.length === 0) return;
      await this.db.insert('conversations', { id: LEGACY_CONVERSATION_ID });
    } catch (err) {
      // Never delete, never block boot — repair is retried on the next start.
      console.warn('[ConversationStore] Legacy repair failed (non-fatal):', err);
    }
  }

  private async createSession(): Promise<number> {
    try {
      return await this.db.insert('conversations', { mode: 'ambient' });
    } catch (err) {
      console.warn('[ConversationStore] Session insert failed — in-memory fallback:', err);
      return FALLBACK_CONVERSATION_ID;
    }
  }

  private async loadStartContext(conversationId: number): Promise<MessageRow[]> {
    try {
      const rows = await this.db.queryMessagesPage({
        excludeConversationId: conversationId,
        limit: START_CONTEXT_LIMIT,
      });
      return rows.reverse(); // DESC (newest first) → chronological
    } catch (err) {
      console.warn('[ConversationStore] Start-context load failed — starting empty:', err);
      return [];
    }
  }
}
