import { describe, it, expect } from 'vitest';
import {
  formatVSliderValueText,
  computeMarkerPosition,
} from './hud-vslider-format.js';

describe('formatVSliderValueText', () => {
  describe('percent', () => {
    it('formats 0..1 as rounded percent', () => {
      expect(formatVSliderValueText(0, 'percent')).toBe('0 %');
      expect(formatVSliderValueText(0.5, 'percent')).toBe('50 %');
      expect(formatVSliderValueText(0.823, 'percent')).toBe('82 %');
      expect(formatVSliderValueText(1, 'percent')).toBe('100 %');
    });
  });

  describe('multiplier', () => {
    it('formats scalar as ×, one decimal', () => {
      expect(formatVSliderValueText(0, 'multiplier')).toBe('0.0×');
      expect(formatVSliderValueText(1, 'multiplier')).toBe('1.0×');
      expect(formatVSliderValueText(1.23, 'multiplier')).toBe('1.2×');
      expect(formatVSliderValueText(1.5, 'multiplier')).toBe('1.5×');
    });
  });

  describe('raw', () => {
    it('formats scalar with two decimals', () => {
      expect(formatVSliderValueText(0, 'raw')).toBe('0.00');
      expect(formatVSliderValueText(0.42, 'raw')).toBe('0.42');
      expect(formatVSliderValueText(1.2345, 'raw')).toBe('1.23');
    });
  });

  it('returns empty string for non-finite values', () => {
    expect(formatVSliderValueText(Number.NaN, 'percent')).toBe('');
    expect(formatVSliderValueText(Number.POSITIVE_INFINITY, 'multiplier')).toBe('');
  });
});

describe('computeMarkerPosition', () => {
  it('maps a value to its fractional position on [min, max]', () => {
    expect(computeMarkerPosition(0, 0, 1)).toBe(0);
    expect(computeMarkerPosition(1, 0, 1)).toBe(1);
    expect(computeMarkerPosition(0.5, 0, 1)).toBe(0.5);
    expect(computeMarkerPosition(1.0, 0, 1.5)).toBeCloseTo(2 / 3, 6);
  });

  it('clamps values outside [min, max]', () => {
    expect(computeMarkerPosition(-0.3, 0, 1)).toBe(0);
    expect(computeMarkerPosition(2, 0, 1)).toBe(1);
  });

  it('returns 0 for degenerate ranges', () => {
    expect(computeMarkerPosition(0.5, 1, 1)).toBe(0);
    expect(computeMarkerPosition(0.5, 1, 0)).toBe(0);
  });

  it('returns 0 for non-finite inputs', () => {
    expect(computeMarkerPosition(Number.NaN, 0, 1)).toBe(0);
    expect(computeMarkerPosition(0.5, Number.NaN, 1)).toBe(0);
    expect(computeMarkerPosition(0.5, 0, Number.NaN)).toBe(0);
  });
});
