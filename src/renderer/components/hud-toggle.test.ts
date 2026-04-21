import { describe, it, expect } from 'vitest';
import {
  ariaPressedFor,
  nextPressedState,
  shouldTriggerToggle,
} from './hud-toggle-logic.js';

describe('ariaPressedFor', () => {
  it('maps boolean to the correct aria-pressed string', () => {
    expect(ariaPressedFor(false)).toBe('false');
    expect(ariaPressedFor(true)).toBe('true');
  });
});

describe('nextPressedState', () => {
  it('flips the pressed state', () => {
    expect(nextPressedState(false)).toBe(true);
    expect(nextPressedState(true)).toBe(false);
  });
});

describe('shouldTriggerToggle', () => {
  it('triggers on Enter keydown (native button convention)', () => {
    expect(shouldTriggerToggle('Enter', 'keydown')).toBe(true);
    expect(shouldTriggerToggle('Enter', 'keyup')).toBe(false);
  });

  it('triggers on Space keyup (so auto-repeat does not double-fire)', () => {
    expect(shouldTriggerToggle(' ', 'keydown')).toBe(false);
    expect(shouldTriggerToggle(' ', 'keyup')).toBe(true);
  });

  it('ignores arrow keys, Tab, Escape, letters', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'Escape', 'a', 'M']) {
      expect(shouldTriggerToggle(key, 'keydown')).toBe(false);
      expect(shouldTriggerToggle(key, 'keyup')).toBe(false);
    }
  });
});

/**
 * Simulated toggle lifecycle — exercises the exact transitions the component
 * runs, without needing a DOM. If the pure helpers stay correct, the
 * shadow-DOM side just mirrors this state onto aria-pressed.
 */
describe('hud-toggle state lifecycle', () => {
  it('click → toggled → aria reflects new state', () => {
    let pressed = false;
    const dispatched: boolean[] = [];

    const toggle = (): void => {
      pressed = nextPressedState(pressed);
      dispatched.push(pressed);
    };

    expect(ariaPressedFor(pressed)).toBe('false');
    toggle();
    expect(pressed).toBe(true);
    expect(ariaPressedFor(pressed)).toBe('true');
    expect(dispatched).toEqual([true]);

    toggle();
    expect(pressed).toBe(false);
    expect(ariaPressedFor(pressed)).toBe('false');
    expect(dispatched).toEqual([true, false]);
  });

  it('Space keydown is suppressed; keyup triggers the toggle', () => {
    let pressed = false;
    const runs: boolean[] = [];

    const handleKey = (key: string, phase: 'keydown' | 'keyup'): void => {
      if (shouldTriggerToggle(key, phase)) {
        pressed = nextPressedState(pressed);
        runs.push(pressed);
      }
    };

    handleKey(' ', 'keydown');
    expect(runs).toEqual([]);
    handleKey(' ', 'keyup');
    expect(runs).toEqual([true]);

    handleKey('Enter', 'keydown');
    expect(runs).toEqual([true, false]);
  });
});
