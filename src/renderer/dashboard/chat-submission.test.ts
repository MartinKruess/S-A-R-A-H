import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_REJECTED_MESSAGE,
  handleRejectedChatSubmission,
  isChatMessageWithinLimit,
  shouldRemoveIncompleteAssistantOutput,
} from './chat-submission.js';

describe('chat submission rejection', () => {
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
