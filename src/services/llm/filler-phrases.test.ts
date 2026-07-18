import { describe, it, expect, afterEach } from 'vitest';
import { getFeedback, feedbackTexts, type FillerCategory } from './filler-phrases.js';

/**
 * getFeedback carries module-internal history state (recentTexts) and reads the
 * shared feedbackTexts pools. To keep cases independent, each test uses its own
 * category (so its history ring starts empty) and any pool override is restored
 * afterwards. rng is stubbed to make selection deterministic.
 */
describe('filler-phrases getFeedback', () => {
  const originals = new Map<FillerCategory, string[]>();

  function overridePool(category: FillerCategory, pool: string[]): void {
    if (!originals.has(category)) originals.set(category, feedbackTexts[category]);
    feedbackTexts[category] = pool;
  }

  afterEach(() => {
    for (const [category, pool] of originals) {
      feedbackTexts[category] = pool;
    }
    originals.clear();
  });

  it('never repeats a phrase still inside the history window, even when rng forces collisions', () => {
    // Pool of 3, window of 2, rng pinned to 0 → always the first *available* item.
    // If exclusion were ignored, index 0 would return 'A' every call.
    overridePool('programReady', ['A', 'B', 'C']);
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(getFeedback('programReady', 2, () => 0));
    }

    // With rng=0 and a 3-item pool / window 2, the deterministic cycle is A,B,C,A,B,C.
    expect(results).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
    // Assert the excluded set is respected: no phrase repeats within any window of 2.
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).not.toBe(results[i - 1]);
    }
  });

  it('honors the history window size — a phrase reappears only once it leaves the window', () => {
    // Pool of 4, window of 2, rng pinned to 0. 'A' is used at call 1, is excluded
    // while inside the 2-entry window (calls 2 and 3), and becomes available again
    // at call 4 (it has left the window).
    overridePool('programLoading', ['A', 'B', 'C', 'D']);
    const results = Array.from({ length: 4 }, () => getFeedback('programLoading', 2, () => 0));

    expect(results[0]).toBe('A');
    expect(results.slice(1, 3)).not.toContain('A'); // excluded while in the window
    expect(results[3]).toBe('A'); // available again after leaving the window
  });

  it('returns the fallback phrase when the pool is empty', () => {
    overridePool('programStarting', []);
    expect(getFeedback('programStarting', 4, () => 0)).toBe('Einen Moment bitte.');
  });

  it('returns the single item for a one-item pool without looping', () => {
    overridePool('memoryLoading', ['Nur der eine.']);
    // Called repeatedly: must always return the item and never hang despite the
    // history containing it (available falls back to the full pool).
    expect(getFeedback('memoryLoading', 4, () => 0)).toBe('Nur der eine.');
    expect(getFeedback('memoryLoading', 4, () => 0)).toBe('Nur der eine.');
    expect(getFeedback('memoryLoading', 4, () => 0)).toBe('Nur der eine.');
  });

  it('exposes the wired categories with the expected phrase content', () => {
    expect(feedbackTexts.frontendThinking).toContain('Lass mich das kurz durchdenken.');
    expect(feedbackTexts.frontendThinking.length).toBeGreaterThanOrEqual(10);
    expect(feedbackTexts.switchingBack).toEqual(['Einen Moment.', 'Sofort.', 'Mach ich gleich.']);
  });
});
