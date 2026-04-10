// src/services/voice/providers/porcupine-provider.ts
import * as fs from 'fs';
import * as path from 'path';
import { Porcupine, BuiltinKeyword } from '@picovoice/porcupine-node';
import type { WakeWordProvider } from '../wake-word-provider.interface.js';

/**
 * PorcupineProvider — Wake-word detection via Picovoice Porcupine.
 *
 * Audio frames are fed externally via `processFrame()` since PvRecorder
 * is not bundled with this package. The VoiceService (or AudioManager)
 * should call `processFrame` with 16-bit PCM mono frames at the sample
 * rate reported by Porcupine (typically 16 kHz).
 *
 * To use a custom wake word, pass the absolute path to a `.ppn` file as
 * `keywordPath`. If omitted, the built-in "porcupine" keyword is used.
 */
export class PorcupineProvider implements WakeWordProvider {
  readonly id = 'porcupine';

  private readonly accessKey: string;
  private readonly resourcesPath: string;
  private readonly keywordPath: string | BuiltinKeyword;
  private readonly sensitivity: number;

  private porcupine: Porcupine | null = null;
  private running = false;
  private onDetected: (() => void) | null = null;

  /**
   * @param resourcesPath  Path to app resources directory. If a `.ppn` file
   *                       named `wake-word.ppn` exists there, it is used;
   *                       otherwise the built-in "porcupine" keyword is used.
   * @param accessKey      Picovoice Console AccessKey.
   * @param sensitivity    Detection sensitivity in [0, 1]. Higher = fewer
   *                       misses, more false alarms. Defaults to 0.5.
   */
  constructor(resourcesPath: string, accessKey: string, sensitivity = 0.5) {
    this.resourcesPath = resourcesPath;
    this.accessKey = accessKey;
    this.sensitivity = sensitivity;

    const customPpn = path.join(resourcesPath, 'wake-word.ppn');
    this.keywordPath = fs.existsSync(customPpn) ? customPpn : BuiltinKeyword.PORCUPINE;
  }

  /**
   * Validate access key and instantiate the Porcupine engine.
   * Must be called before `start()`.
   */
  async init(): Promise<void> {
    if (this.accessKey.trim().length === 0) {
      throw new Error('PorcupineProvider: accessKey is empty');
    }

    // If a custom .ppn path is configured, verify it exists on disk.
    if (
      typeof this.keywordPath === 'string' &&
      !Object.values(BuiltinKeyword).includes(this.keywordPath as BuiltinKeyword)
    ) {
      if (!fs.existsSync(this.keywordPath)) {
        throw new Error(`PorcupineProvider: keyword model not found: ${this.keywordPath}`);
      }
    }

    this.porcupine = new Porcupine(
      this.accessKey,
      [this.keywordPath],
      [this.sensitivity],
    );
  }

  /**
   * Begin wake-word detection. Audio must be fed via `processFrame()`.
   * @param onDetected  Callback fired when the wake word is heard.
   */
  start(onDetected: () => void): void {
    if (!this.porcupine) {
      throw new Error('PorcupineProvider: call init() before start()');
    }
    this.onDetected = onDetected;
    this.running = true;
  }

  /** Stop wake-word detection. Frames fed to `processFrame()` are ignored. */
  stop(): void {
    this.running = false;
    this.onDetected = null;
  }

  /**
   * Process a single PCM frame.
   *
   * The frame must be `porcupine.frameLength` samples long (typically 512),
   * 16-bit signed integers, mono, at `porcupine.sampleRate` Hz (16 kHz).
   *
   * Call this method from whatever audio pipeline is active (e.g. an IPC
   * handler receiving chunks from the renderer's Web Audio worklet).
   *
   * @param frame  Int16Array of exactly `frameLength` samples.
   */
  processFrame(frame: Int16Array): void {
    if (!this.running || !this.porcupine || !this.onDetected) return;

    const keywordIndex = this.porcupine.process(frame);
    if (keywordIndex >= 0) {
      this.onDetected();
    }
  }

  /**
   * The number of samples per frame expected by `processFrame()`.
   * Returns 0 before `init()` is called.
   */
  get frameLength(): number {
    return this.porcupine?.frameLength ?? 0;
  }

  /**
   * The sample rate (Hz) expected by `processFrame()`.
   * Returns 0 before `init()` is called.
   */
  get sampleRate(): number {
    return this.porcupine?.sampleRate ?? 0;
  }

  /** Release the native Porcupine instance. */
  async destroy(): Promise<void> {
    this.stop();
    if (this.porcupine) {
      this.porcupine.release();
      this.porcupine = null;
    }
  }
}
