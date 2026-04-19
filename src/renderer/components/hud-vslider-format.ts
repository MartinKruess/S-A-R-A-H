/**
 * Pure helpers for the hud-vslider component.
 *
 * Kept DOM-free so formatting logic is unit-testable in a Node vitest
 * environment without pulling the SarahElement base class (which extends
 * HTMLElement and would require a DOM environment).
 */

export type HudVSliderUnit = 'percent' | 'multiplier' | 'raw';

/**
 * Format a slider value into a human-readable screen-reader string.
 *
 * - `percent`:   0..1 fractional → "82 %"
 * - `multiplier`: raw scalar    → "1.2×"
 * - `raw`:        raw scalar    → "0.42"
 *
 * Values are rounded sensibly for the unit so VoiceOver/NVDA don't read
 * "0.8200000000001".
 */
export function formatVSliderValueText(
  value: number,
  unit: HudVSliderUnit,
): string {
  if (!Number.isFinite(value)) return '';
  switch (unit) {
    case 'percent': {
      const pct = Math.round(value * 100);
      return `${pct} %`;
    }
    case 'multiplier': {
      // One decimal is enough — our range 0..1.5 only has 16 perceptible steps.
      return `${value.toFixed(1)}×`;
    }
    case 'raw': {
      return value.toFixed(2);
    }
  }
}

/**
 * Compute the bottom offset (in %) for a marker at `markerValue` on a
 * [min, max] range. Returned as a fractional 0..1 so the caller can render it
 * as `bottom: ${pct * 100}%`. Values outside the range are clamped.
 */
export function computeMarkerPosition(
  markerValue: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(markerValue) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (max <= min) return 0;
  const clamped = Math.max(min, Math.min(max, markerValue));
  return (clamped - min) / (max - min);
}
