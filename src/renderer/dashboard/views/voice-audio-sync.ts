import type { AudioConfig } from '../../../core/config-schema.js';
import { getSarah } from '../../shared/window-global.js';

/**
 * Shared lifecycle helper for voice panels that mirror `AudioConfig` into
 * their UI. Both `voice-in.ts` and `voice-out.ts` perform the same dance:
 * read the current config on mount, subscribe to echo events, persist patches
 * via a partial-merge, and tear the subscription down on dispose.
 */
export interface VoiceAudioSync {
  /** Persist a partial audio-config patch via `saveConfig`. */
  persist(patch: Partial<AudioConfig>): Promise<boolean>;
  /** Unsubscribe from the audio-config echo stream. */
  dispose(): void;
}

/** Persist one MUTE change and invoke the caller's current-state rollback on failure. */
export async function persistMuteWithRollback(
  audioSync: VoiceAudioSync,
  muted: boolean,
  rollback: () => void,
): Promise<void> {
  if (!await audioSync.persist({ inputMuted: muted })) rollback();
}

/**
 * Create a bound audio-config sync for a voice panel.
 *
 * @param tag      short identifier used in console warnings
 * @param onApply  called once on mount (initial fetch) and on each echo
 */
export function createAudioSync(
  tag: string,
  onApply: (audio: AudioConfig) => void,
): VoiceAudioSync {
  const sarah = getSarah();

  let appliedRevision = 0;
  const applyEvent = (audio: AudioConfig): void => {
    appliedRevision += 1;
    onApply(audio);
  };
  let unsub: (() => void) | null = sarah.onAudioConfigChanged(applyEvent);
  const snapshotRevision = appliedRevision;

  sarah
    .getConfig()
    .then((cfg) => {
      if (appliedRevision === snapshotRevision) onApply(cfg.audio);
    })
    .catch((err: Error) => {
      console.warn(`[${tag}] initial audio config fetch failed:`, err);
    });

  const persist = async (patch: Partial<AudioConfig>): Promise<boolean> => {
    try {
      await sarah.saveConfig({ audio: patch });
      return true;
    } catch (err) {
      console.warn(`[${tag}] audio persist failed:`, err);
      return false;
    }
  };

  const dispose = (): void => {
    if (unsub) {
      unsub();
      unsub = null;
    }
  };

  return { persist, dispose };
}

/**
 * Tolerant float equality for IEEE-754 values that have round-tripped through
 * IPC. Prevents no-op `setValueSilent` writes from echoing back and fighting
 * a user's in-progress drag.
 */
export function near(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}
