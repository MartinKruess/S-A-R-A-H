import { describe, expect, it } from 'vitest';
import { createAudioDevicePatch } from './audio-section.js';

describe('audio settings patches', () => {
  it('persists only the changed device field instead of a stale audio snapshot', () => {
    expect(createAudioDevicePatch('inputDeviceId', 'mic-new')).toEqual({ inputDeviceId: 'mic-new' });
    expect(createAudioDevicePatch('outputDeviceId', 'speaker-new')).toEqual({ outputDeviceId: 'speaker-new' });
    expect(createAudioDevicePatch('inputDeviceId', '')).toEqual({ inputDeviceId: undefined });
  });
});
