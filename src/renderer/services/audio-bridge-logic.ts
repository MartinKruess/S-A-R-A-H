// src/renderer/services/audio-bridge-logic.ts
//
// Pure helpers for AudioBridge capture-path decisions. Kept DOM-free so they
// can be unit-tested without mocking AudioContext/MediaDevices.

import type { AudioConfig } from '../../core/config-schema.js';

/**
 * Effective capture gain before it reaches the AudioWorklet.
 *
 * When muted, the GainNode ramps to 0. Otherwise inputGain (0..1.5, mic boost)
 * multiplies inputVolume (0..1, user-facing linear).
 */
export function computeEffectiveGain(audio: AudioConfig): number {
  if (audio.inputMuted) return 0;
  return audio.inputGain * audio.inputVolume;
}

/**
 * Decide what the AudioBridge should do when a new audio config arrives,
 * based purely on the input-device id transition and whether capture is
 * currently active.
 *
 * - `reset`         — device changed while capturing; stop + re-init capture
 * - `updateStored`  — device changed while idle; just remember the new id
 * - `noop`          — device did not change; ramps handled elsewhere
 */
export type CaptureResetDecision = 'reset' | 'updateStored' | 'noop';

export function decideCaptureReset(
  prevDeviceId: string | undefined,
  nextDeviceId: string | undefined,
  capturing: boolean,
): CaptureResetDecision {
  if (prevDeviceId === nextDeviceId) return 'noop';
  return capturing ? 'reset' : 'updateStored';
}

/**
 * Determine whether two AudioConfig slices are effectively identical from the
 * capture path's perspective. Output-only fields are ignored — the playback
 * side uses {@link isPlaybackConfigEqual}. Used to make `applyAudioConfig`
 * idempotent for capture reactions.
 */
export function isCaptureConfigEqual(
  a: AudioConfig | undefined,
  b: AudioConfig,
): boolean {
  if (!a) return false;
  return (
    a.inputDeviceId === b.inputDeviceId &&
    a.inputMuted === b.inputMuted &&
    a.inputGain === b.inputGain &&
    a.inputVolume === b.inputVolume
  );
}

/**
 * Determine whether two AudioConfig slices are identical from the playback
 * path's perspective. Input-only fields are ignored — the capture side uses
 * {@link isCaptureConfigEqual}. Kept symmetric so `applyAudioConfig` can
 * short-circuit the playback branch independently.
 */
export function isPlaybackConfigEqual(
  a: AudioConfig | undefined,
  b: AudioConfig,
): boolean {
  if (!a) return false;
  return (
    a.outputDeviceId === b.outputDeviceId &&
    a.outputVolume === b.outputVolume
  );
}
