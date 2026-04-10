// src/services/voice/wake-word-provider.interface.ts

export interface WakeWordProvider {
  /** Unique provider ID, e.g. 'porcupine' */
  readonly id: string;

  /** Initialize the provider (load wake-word model) */
  init(): Promise<void>;

  /**
   * Start listening for wake-word. Calls onDetected when wake-word is heard.
   * The provider manages its own audio input for wake-word detection.
   */
  start(onDetected: () => void): void;

  /** Stop listening for wake-word */
  stop(): void;

  /** Clean up resources */
  destroy(): Promise<void>;
}
