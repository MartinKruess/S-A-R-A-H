import { describe, expect, it, vi } from 'vitest';
import {
  pruneDetachedTurnBubbles,
  removeIncognitoSection,
  resolveIncognitoStart,
} from './incognito-visibility.js';

interface NodeStub {
  nextElementSibling: NodeStub | null;
  isConnected: boolean;
  removeMock: ReturnType<typeof vi.fn>;
  remove(): void;
}

function node(): NodeStub {
  const removeMock = vi.fn();
  return {
    nextElementSibling: null,
    isConnected: true,
    removeMock,
    remove: () => { removeMock(); },
  };
}

describe('incognito chat visibility boundary', () => {
  it('uses the voice transcript owned by the activating turn, not its previous sibling', () => {
    const priorNormal = node();
    const voiceTranscript = node();
    priorNormal.nextElementSibling = voiceTranscript;

    const start = resolveIncognitoStart(
      'voice-turn',
      new Map([['voice-turn', voiceTranscript]]),
      voiceTranscript,
    );
    removeIncognitoSection(start);

    expect(priorNormal.removeMock).not.toHaveBeenCalled();
    expect(voiceTranscript.removeMock).toHaveBeenCalledOnce();
  });

  it('falls back to the newest visible bubble without stepping into normal history', () => {
    const priorNormal = node();
    const newest = node();
    priorNormal.nextElementSibling = newest;

    removeIncognitoSection(resolveIncognitoStart('missing', new Map(), newest));

    expect(priorNormal.removeMock).not.toHaveBeenCalled();
    expect(newest.removeMock).toHaveBeenCalledOnce();
  });

  it('forgets detached private transcript nodes after the section is removed', () => {
    const privateTranscript = node();
    privateTranscript.isConnected = false;
    const visibleNormal = node();
    const references = new Map([
      ['private-turn', privateTranscript],
      ['normal-turn', visibleNormal],
    ]);

    pruneDetachedTurnBubbles(references);

    expect(references.has('private-turn')).toBe(false);
    expect(references.get('normal-turn')).toBe(visibleNormal);
  });
});
