// src/services/voice/tts-provider.interface.ts

export interface TtsAvailability {
  available: boolean;
  message?: string;
}

export interface TtsProvider {
  /** Unique provider ID, e.g. 'piper' */
  readonly id: string;

  /** Initialize the provider (verify binary exists, load voice model) */
  init(signal?: AbortSignal): Promise<void>;

  /** Convert text to PCM audio. Returns raw PCM Float32Array at 22050 Hz. */
  speak(text: string, signal?: AbortSignal): Promise<Float32Array>;

  /** Subscribe to runtime synthesis failures and successful recovery. */
  onAvailabilityChange?(listener: (state: TtsAvailability) => void): () => void;

  /** Stop any in-progress speech generation and playback */
  stop(): void;

  /** Clean up resources */
  destroy(signal?: AbortSignal): Promise<void>;
}
