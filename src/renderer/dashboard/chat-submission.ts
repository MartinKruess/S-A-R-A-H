import { MAX_CHAT_MESSAGE_LENGTH } from '../../core/chat-limits.js';

export const CHAT_REJECTED_MESSAGE =
  'Die Nachricht wurde nicht angenommen. Bitte prüfe die Länge und versuche es erneut.';

export function isChatMessageWithinLimit(text: string): boolean {
  return text.length <= MAX_CHAT_MESSAGE_LENGTH;
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
