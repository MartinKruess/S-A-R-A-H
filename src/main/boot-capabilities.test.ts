import { describe, expect, it } from 'vitest';
import { deriveBootCapabilitySteps } from './boot-capabilities.js';

describe('deriveBootCapabilitySteps', () => {
  it('emits ready only for verified ready capabilities', () => {
    expect(deriveBootCapabilitySteps({ state: 'ready' }, { stt: true, tts: true })).toEqual({
      router: 'router-ready',
      stt: 'whisper-ready',
      tts: 'piper-ready',
    });
  });

  it.each(['registered', 'starting', 'degraded', 'unavailable', 'error', 'stopping', 'stopped'] as const)(
    'never maps router state %s to ready',
    (state) => {
      expect(deriveBootCapabilitySteps({ state }, { stt: false, tts: false })).toEqual({
        router: 'router-terminal',
        stt: 'whisper-unavailable',
        tts: 'piper-unavailable',
      });
    },
  );
});
