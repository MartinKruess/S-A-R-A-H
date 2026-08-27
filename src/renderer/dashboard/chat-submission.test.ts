import { describe, expect, it, vi } from 'vitest';
import {
  beginChatProcessing,
  CHAT_PROCESSING_MESSAGE,
  CHAT_REJECTED_MESSAGE,
  handleRejectedChatSubmission,
  isChatMessageWithinLimit,
  removeChatProcessing,
  shouldRemoveIncompleteAssistantOutput,
  takeChatProcessing,
} from './chat-submission.js';

describe('chat submission rejection', () => {
  it('creates a visible processing bubble synchronously for the submitted turn', () => {
    const bubble = {
      textContent: '',
      classList: { add: vi.fn(), remove: vi.fn() },
      remove: vi.fn(),
    };
    const pending = new Map<string, typeof bubble>();
    const createBubble = vi.fn(() => bubble);

    beginChatProcessing('turn-1', pending, createBubble);

    expect(createBubble).toHaveBeenCalledWith(CHAT_PROCESSING_MESSAGE);
    expect(bubble.classList.add).toHaveBeenCalledWith('processing');
    expect(pending.get('turn-1')).toBe(bubble);
  });

  it('reuses the processing bubble for output and removes it on terminal failure', () => {
    const first = {
      textContent: CHAT_PROCESSING_MESSAGE,
      classList: { add: vi.fn(), remove: vi.fn() },
      remove: vi.fn(),
    };
    const pending = new Map([['turn-1', first]]);

    expect(takeChatProcessing('turn-1', pending)).toBe(first);
    expect(first.classList.remove).toHaveBeenCalledWith('processing');
    expect(first.textContent).toBe('');
    expect(pending.has('turn-1')).toBe(false);

    const second = {
      textContent: CHAT_PROCESSING_MESSAGE,
      classList: { add: vi.fn(), remove: vi.fn() },
      remove: vi.fn(),
    };
    pending.set('turn-2', second);
    removeChatProcessing('turn-2', pending);
    expect(second.remove).toHaveBeenCalledOnce();
    expect(pending.has('turn-2')).toBe(false);
  });

  it('rejects programmatically assigned messages beyond the IPC limit', () => {
    expect(isChatMessageWithinLimit('x'.repeat(4_000))).toBe(true);
    expect(isChatMessageWithinLimit('x'.repeat(4_001))).toBe(false);
  });

  it('removes a silently refused user bubble and reports that it was not sent', () => {
    const remove = vi.fn();
    const showError = vi.fn();
    handleRejectedChatSubmission('turn-1', new Set(), { remove }, showError);
    expect(remove).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledWith(CHAT_REJECTED_MESSAGE);
  });

  it('does not duplicate an error for a turn that already became terminal', () => {
    const remove = vi.fn();
    const showError = vi.fn();
    handleRejectedChatSubmission('turn-1', new Set(['turn-1']), { remove }, showError);
    expect(remove).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('removes incomplete assistant output only for unsuccessful terminals', () => {
    expect(shouldRemoveIncompleteAssistantOutput('canceled')).toBe(true);
    expect(shouldRemoveIncompleteAssistantOutput('error')).toBe(true);
    expect(shouldRemoveIncompleteAssistantOutput('done')).toBe(false);
  });
});
