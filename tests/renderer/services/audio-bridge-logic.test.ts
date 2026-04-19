// tests/renderer/services/audio-bridge-logic.test.ts
import { describe, it, expect } from 'vitest';
import type { AudioConfig } from '../../../src/core/config-schema.js';
import {
  computeEffectiveGain,
  decideCaptureReset,
  isCaptureConfigEqual,
} from '../../../src/renderer/services/audio-bridge-logic.js';

function makeAudio(overrides: Partial<AudioConfig> = {}): AudioConfig {
  return {
    inputDeviceId: undefined,
    outputDeviceId: undefined,
    inputMuted: false,
    inputGain: 1.0,
    inputVolume: 1.0,
    outputVolume: 1.0,
    ...overrides,
  };
}

describe('computeEffectiveGain', () => {
  it('returns 0 when muted regardless of gain/volume', () => {
    expect(computeEffectiveGain(makeAudio({ inputMuted: true, inputGain: 1.5, inputVolume: 1 }))).toBe(0);
    expect(computeEffectiveGain(makeAudio({ inputMuted: true, inputGain: 0, inputVolume: 0 }))).toBe(0);
  });

  it('multiplies gain and volume when unmuted', () => {
    expect(computeEffectiveGain(makeAudio({ inputGain: 1.0, inputVolume: 1.0 }))).toBe(1);
    expect(computeEffectiveGain(makeAudio({ inputGain: 1.5, inputVolume: 1.0 }))).toBe(1.5);
    expect(computeEffectiveGain(makeAudio({ inputGain: 1.0, inputVolume: 0.5 }))).toBe(0.5);
    expect(computeEffectiveGain(makeAudio({ inputGain: 1.5, inputVolume: 0.5 }))).toBe(0.75);
  });

  it('handles zero volume without muting the mute flag', () => {
    expect(computeEffectiveGain(makeAudio({ inputGain: 1.0, inputVolume: 0 }))).toBe(0);
  });
});

describe('decideCaptureReset', () => {
  it('returns noop when device id is unchanged', () => {
    expect(decideCaptureReset(undefined, undefined, true)).toBe('noop');
    expect(decideCaptureReset(undefined, undefined, false)).toBe('noop');
    expect(decideCaptureReset('mic-a', 'mic-a', true)).toBe('noop');
    expect(decideCaptureReset('mic-a', 'mic-a', false)).toBe('noop');
  });

  it('returns reset when device changes while capturing', () => {
    expect(decideCaptureReset('mic-a', 'mic-b', true)).toBe('reset');
    expect(decideCaptureReset(undefined, 'mic-b', true)).toBe('reset');
    expect(decideCaptureReset('mic-a', undefined, true)).toBe('reset');
  });

  it('returns updateStored when device changes while idle', () => {
    expect(decideCaptureReset('mic-a', 'mic-b', false)).toBe('updateStored');
    expect(decideCaptureReset(undefined, 'mic-b', false)).toBe('updateStored');
    expect(decideCaptureReset('mic-a', undefined, false)).toBe('updateStored');
  });
});

describe('isCaptureConfigEqual', () => {
  it('returns false when previous is undefined', () => {
    expect(isCaptureConfigEqual(undefined, makeAudio())).toBe(false);
  });

  it('returns true for identical capture-relevant fields', () => {
    const a = makeAudio({ inputDeviceId: 'mic-a', inputGain: 1.2, inputVolume: 0.8 });
    const b = makeAudio({ inputDeviceId: 'mic-a', inputGain: 1.2, inputVolume: 0.8 });
    expect(isCaptureConfigEqual(a, b)).toBe(true);
  });

  it('ignores output-only fields', () => {
    const a = makeAudio({ outputDeviceId: 'out-a', outputVolume: 0.5 });
    const b = makeAudio({ outputDeviceId: 'out-b', outputVolume: 1.0 });
    expect(isCaptureConfigEqual(a, b)).toBe(true);
  });

  it('detects device, mute, gain, and volume changes', () => {
    const base = makeAudio({ inputDeviceId: 'mic-a' });
    expect(isCaptureConfigEqual(base, makeAudio({ inputDeviceId: 'mic-b' }))).toBe(false);
    expect(isCaptureConfigEqual(base, makeAudio({ inputDeviceId: 'mic-a', inputMuted: true }))).toBe(false);
    expect(isCaptureConfigEqual(base, makeAudio({ inputDeviceId: 'mic-a', inputGain: 1.2 }))).toBe(false);
    expect(isCaptureConfigEqual(base, makeAudio({ inputDeviceId: 'mic-a', inputVolume: 0.5 }))).toBe(false);
  });
});
