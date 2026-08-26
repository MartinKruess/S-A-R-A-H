import { MAX_CHAT_MESSAGE_LENGTH } from '../../core/chat-limits.js';
import type { TurnTerminalStatus } from '../../core/turn-contract.js';

export const CHAT_REJECTED_MESSAGE =
  'Die Nachricht wurde nicht angenommen. Bitte prüfe die Länge und versuche es erneut.';
export const CHAT_PROCESSING_MESSAGE = 'Wird verarbeitet …';

export interface ProcessingBubble {
  textContent: string | null;
  classList: Pick<DOMTokenList, 'add' | 'remove'>;
  remove(): void;
}

export function isChatMessageWithinLimit(text: string): boolean {
  return text.length <= MAX_CHAT_MESSAGE_LENGTH;
}

/** Whether a terminal outcome invalidates an unfinished assistant stream. */
export function shouldRemoveIncompleteAssistantOutput(status: TurnTerminalStatus): boolean {
  return status === 'canceled' || status === 'error';
}

/**
 * @param turnId - Submitted chat turn.
 * @param pending - Open turn-to-placeholder ownership map.
 * @param createBubble - Creates the visible assistant placeholder.
 *
 * - Reuses an existing placeholder for duplicate local notification.
 * - Marks a new placeholder as processing before IPC settles.
 *
 * @returns The placeholder owned by the turn.
 *
 * @category Event Handler
 */
export function beginChatProcessing<T extends ProcessingBubble>(
  turnId: string,
  pending: Map<string, T>,
  createBubble: (text: string) => T,
): T {
  const existing = pending.get(turnId);
  if (existing) return existing;
  const bubble = createBubble(CHAT_PROCESSING_MESSAGE);
  bubble.classList.add('processing');
  pending.set(turnId, bubble);
  return bubble;
}

/**
 * @param turnId - Turn whose first assistant output arrived.
 * @param pending - Open turn-to-placeholder ownership map.
 *
 * - Releases processing styling and clears placeholder text.
 *
 * @returns The reusable bubble, if the turn still owned one.
 *
 * @category Event Handler
 */
export function takeChatProcessing<T extends ProcessingBubble>(
  turnId: string,
  pending: Map<string, T>,
): T | undefined {
  const bubble = pending.get(turnId);
  if (!bubble) return undefined;
  pending.delete(turnId);
  bubble.classList.remove('processing');
  bubble.textContent = '';
  return bubble;
}

/**
 * @param turnId - Rejected, failed, or terminal turn.
 * @param pending - Open turn-to-placeholder ownership map.
 *
 * - Removes the turn-owned placeholder from state and DOM.
 *
 * @returns Nothing.
 *
 * @category Event Handler
 */
export function removeChatProcessing<T extends ProcessingBubble>(
  turnId: string,
  pending: Map<string, T>,
): void {
  const bubble = pending.get(turnId);
  if (!bubble) return;
  pending.delete(turnId);
  bubble.remove();
}

/** Marks a silently refused IPC submission without duplicating an event-stream error. */
export function handleRejectedChatSubmission(
  turnId: string,
  terminalTurns: Set<string>,
  userBubble: { remove(): void },
  showError: (message: string) => void,
): void {
  if (terminalTurns.has(turnId)) return;
  terminalTurns.add(turnId);
  userBubble.remove();
  showError(CHAT_REJECTED_MESSAGE);
}
