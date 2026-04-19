/**
 * Pure helpers for hud-toggle.
 *
 * Kept DOM-free so the small state-machine (pressed ↔ aria-pressed string
 * mapping, keyboard trigger rules) is unit-testable in a Node vitest
 * environment without pulling the SarahElement base class.
 */

export type ToggleKey = 'Enter' | ' ' | 'keyup- ' | 'keydown-Enter';

/** aria-pressed attribute value for a given pressed state. */
export function ariaPressedFor(pressed: boolean): 'true' | 'false' {
  return pressed ? 'true' : 'false';
}

/**
 * Returns true if the given key event should trigger a toggle action.
 *
 * Convention (matches native <button> semantics):
 *   - `Enter` on keydown triggers.
 *   - `Space` on keyup triggers (so auto-repeat doesn't fire multiple times).
 *
 * Pass the `phase` (`'keydown' | 'keyup'`) so callers can centralise this
 * check instead of duplicating it in keydown and keyup handlers.
 */
export function shouldTriggerToggle(key: string, phase: 'keydown' | 'keyup'): boolean {
  if (phase === 'keydown' && key === 'Enter') return true;
  if (phase === 'keyup' && key === ' ') return true;
  return false;
}

/** Pure state transition: next pressed state given the previous one. */
export function nextPressedState(prev: boolean): boolean {
  return !prev;
}
