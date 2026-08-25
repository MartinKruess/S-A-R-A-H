import type { CapabilitySnapshot } from '../core/app-lifecycle-controller.js';

export type RouterBootStep = 'router-ready' | 'router-terminal';
export type SttBootStep = 'whisper-ready' | 'whisper-unavailable';
export type TtsBootStep = 'piper-ready' | 'piper-unavailable';

export interface BootCapabilitySteps {
  router: RouterBootStep;
  stt: SttBootStep;
  tts: TtsBootStep;
}

/** Map verified runtime capabilities to terminal splash steps. */
export function deriveBootCapabilitySteps(
  router: CapabilitySnapshot | undefined,
  voice: Readonly<{ stt: boolean; tts: boolean }>,
): BootCapabilitySteps {
  return {
    router: router?.state === 'ready' ? 'router-ready' : 'router-terminal',
    stt: voice.stt ? 'whisper-ready' : 'whisper-unavailable',
    tts: voice.tts ? 'piper-ready' : 'piper-unavailable',
  };
}
