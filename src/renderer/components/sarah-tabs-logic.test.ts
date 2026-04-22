import { describe, it, expect } from 'vitest';
import {
  keyToTabAction,
  nextTabIndex,
  resolveInitialTabId,
} from './sarah-tabs-logic.js';

describe('keyToTabAction', () => {
  it('maps ArrowRight to next', () => {
    expect(keyToTabAction('ArrowRight')).toBe('next');
  });

  it('maps ArrowLeft to prev', () => {
    expect(keyToTabAction('ArrowLeft')).toBe('prev');
  });

  it('maps Home to first', () => {
    expect(keyToTabAction('Home')).toBe('first');
  });

  it('maps End to last', () => {
    expect(keyToTabAction('End')).toBe('last');
  });

  it('maps Enter and Space to activate', () => {
    expect(keyToTabAction('Enter')).toBe('activate');
    expect(keyToTabAction(' ')).toBe('activate');
  });

  it('returns null for unrelated keys', () => {
    for (const key of ['a', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown']) {
      expect(keyToTabAction(key)).toBeNull();
    }
  });
});

describe('nextTabIndex', () => {
  it('moves forward with wrap-around', () => {
    expect(nextTabIndex(0, 'next', 3)).toBe(1);
    expect(nextTabIndex(1, 'next', 3)).toBe(2);
    expect(nextTabIndex(2, 'next', 3)).toBe(0);
  });

  it('moves backward with wrap-around', () => {
    expect(nextTabIndex(2, 'prev', 3)).toBe(1);
    expect(nextTabIndex(1, 'prev', 3)).toBe(0);
    expect(nextTabIndex(0, 'prev', 3)).toBe(2);
  });

  it('jumps to first and last', () => {
    expect(nextTabIndex(2, 'first', 5)).toBe(0);
    expect(nextTabIndex(0, 'last', 5)).toBe(4);
  });

  it('returns same index for zero-length tab list', () => {
    expect(nextTabIndex(0, 'next', 0)).toBe(0);
    expect(nextTabIndex(0, 'last', 0)).toBe(0);
  });
});

describe('resolveInitialTabId', () => {
  const valid = ['profile', 'personal', 'management', 'control', 'security'];

  it('returns hash value if valid', () => {
    expect(resolveInitialTabId('#personal', 'profile', valid)).toBe('personal');
    expect(resolveInitialTabId('#security', 'profile', valid)).toBe('security');
  });

  it('returns default for unknown hash', () => {
    expect(resolveInitialTabId('#unknown', 'profile', valid)).toBe('profile');
  });

  it('returns default for empty hash', () => {
    expect(resolveInitialTabId('', 'profile', valid)).toBe('profile');
    expect(resolveInitialTabId('#', 'profile', valid)).toBe('profile');
  });

  it('strips leading # from hash', () => {
    expect(resolveInitialTabId('#profile', 'profile', valid)).toBe('profile');
    expect(resolveInitialTabId('profile', 'profile', valid)).toBe('profile');
  });
});
