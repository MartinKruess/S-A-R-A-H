// src/services/voice/tts-provider.interface.ts

export interface TtsProvider {
  /** Unique provider ID, e.g. 'piper' */
  readonly id: string;

  /** Initialize the provider (verify binary exists, load voice model) */
  init(signal?: AbortSignal): Promise<void>;

  /** Convert text to PCM audio. Returns raw PCM Float32Array at 22050 Hz. */
  speak(text: string): Promise<Float32Array>;

  /** Stop any in-progress speech generation and playback */
  stop(): void;

  /** Clean up resources */
  destroy(signal?: AbortSignal): Promise<void>;
}
