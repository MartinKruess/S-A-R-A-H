// src/services/voice/tts-provider.interface.ts

export interface TtsProvider {
  /** Unique provider ID, e.g. 'piper' */
  readonly id: string;

  /** Initialize the provider (verify binary exists, load voice model) */
  init(): Promise<void>;

  /** Convert text to PCM audio. Returns raw PCM Float32Array at 22050 Hz. */
  speak(text: string): Promise<Float32Array>;

  /** Stop any in-progress speech generation and playback */
  stop(): void;

  /** Clean up resources */
  destroy(): Promise<void>;
}
