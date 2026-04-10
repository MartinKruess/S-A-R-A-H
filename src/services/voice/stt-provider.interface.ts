// src/services/voice/stt-provider.interface.ts

export interface SttProvider {
  /** Unique provider ID, e.g. 'whisper' */
  readonly id: string;

  /** Initialize the provider (verify binary exists, load model) */
  init(): Promise<void>;

  /** Transcribe PCM audio to text */
  transcribe(audio: Float32Array, sampleRate: number): Promise<string>;

  /** Clean up resources */
  destroy(): Promise<void>;
}
