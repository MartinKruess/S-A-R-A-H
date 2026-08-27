export interface IncognitoSectionNode<T> {
  nextElementSibling: T | null;
  remove(): void;
}

/** Resolves the private UI boundary from the exact owning turn. */
export function resolveIncognitoStart<T>(
  turnId: string,
  turnUserBubbles: ReadonlyMap<string, T>,
  lastVisible: T | null,
): T | null {
  return turnUserBubbles.get(turnId) ?? lastVisible;
}

/** Removes only the contiguous private section beginning at its owned bubble. */
export function removeIncognitoSection<T extends IncognitoSectionNode<T>>(start: T | null): void {
  let current = start;
  while (current) {
    const next = current.nextElementSibling;
    current.remove();
    current = next;
  }
}

/** Drops renderer references after their visible bubbles have been removed. */
export function pruneDetachedTurnBubbles<T extends { isConnected: boolean }>(
  turnUserBubbles: Map<string, T>,
): void {
  for (const [turnId, bubble] of turnUserBubbles) {
    if (!bubble.isConnected) turnUserBubbles.delete(turnId);
  }
}
