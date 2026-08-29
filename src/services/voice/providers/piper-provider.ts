// src/services/voice/providers/piper-provider.ts
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { TtsAvailability, TtsProvider } from '../tts-provider.interface.js';
import { abortError, throwIfAborted } from '../../../core/abort-utils.js';

const PIPER_PROBE_TIMEOUT_MS = 5_000;

async function probePiperExecutable(binaryPath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const process = spawn(binaryPath, ['--help'], { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => {
      process.kill();
      finish(abortError('Piper availability probe aborted'));
    };
    const timeout = setTimeout(() => {
      process.kill();
      finish(new Error('Piper availability probe timed out'));
    }, PIPER_PROBE_TIMEOUT_MS);
    timeout.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    process.once('error', (error) => finish(new Error(`Failed to start piper: ${error.message}`)));
    process.once('close', (code, closeSignal) => {
      if (code === 0) finish();
      else if (code === null) finish(new Error(`Piper probe terminated by signal ${closeSignal ?? 'unknown'}`));
      else finish(new Error(`Piper probe exited with code ${code}`));
    });
  });
}

export interface PiperProviderOptions {
  probe?: (binaryPath: string, signal?: AbortSignal) => Promise<void>;
}

export class PiperProvider implements TtsProvider {
  readonly id = 'piper';
  private binaryPath: string;
  private voicePath: string;
  private readonly activeProcesses = new Map<ChildProcess, (error: Error) => void>();
  private readonly availabilityListeners = new Set<(state: TtsAvailability) => void>();
  private available: boolean | null = null;
  private readonly probe: (binaryPath: string, signal?: AbortSignal) => Promise<void>;

  /**
   * @param resourcesPath — path to app resources directory
   */
  constructor(resourcesPath: string, options: PiperProviderOptions = {}) {
    this.binaryPath = path.join(resourcesPath, 'piper', 'piper.exe');
    this.voicePath = path.join(resourcesPath, 'piper', 'de_DE-thorsten-medium.onnx');
    this.probe = options.probe ?? probePiperExecutable;
  }

  private initPromise: Promise<void> | null = null;

  // init() is single-flight (A8): repeated calls return the same promise.
  init(_signal?: AbortSignal): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit(_signal).then(
        () => { this.publishAvailability(true); },
        (error) => {
          this.publishAvailability(false, error instanceof Error ? error.message : String(error));
          throw error;
        },
      );
    }
    return this.initPromise;
  }

  onAvailabilityChange(listener: (state: TtsAvailability) => void): () => void {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  private async doInit(signal?: AbortSignal): Promise<void> {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Piper binary not found: ${this.binaryPath}`);
    }
    if (!fs.existsSync(this.voicePath)) {
      throw new Error(`Piper voice not found: ${this.voicePath}`);
    }
    await this.probe(this.binaryPath, signal);
  }

  async speak(text: string, signal?: AbortSignal): Promise<Float32Array> {
    throwIfAborted(signal);
    const synthesis = new Promise<Float32Array>((resolve, reject) => {
      const args = [
        '--model', this.voicePath,
        '--output_raw',
      ];

      const process = spawn(this.binaryPath, args);
      const chunks: Buffer[] = [];
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        this.activeProcesses.delete(process);
        signal?.removeEventListener('abort', onAbort);
        if (timeout) clearTimeout(timeout);
        timeout = null;
      };
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        process.kill();
        rejectOnce(abortError('Piper speech generation aborted'));
      };
      this.activeProcesses.set(process, rejectOnce);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      process.stdout?.on('data', (data: Buffer) => {
        chunks.push(data);
      });

      process.stderr?.on('data', () => {
        // Piper logs progress to stderr, ignore
      });

      process.on('close', (code, closeSignal) => {
        if (settled) {
          cleanup();
          return;
        }

        if (code === 0) {
          const combined = Buffer.concat(chunks);
          if (combined.byteLength === 0 || combined.byteLength % 2 !== 0) {
            rejectOnce(new Error('Piper returned invalid PCM audio'));
            return;
          }
          settled = true;
          cleanup();
          // Piper outputs 16-bit signed PCM at 22050 Hz — convert to Float32
          const int16 = new Int16Array(
            combined.buffer,
            combined.byteOffset,
            combined.byteLength / 2,
          );
          const float32 = new Float32Array(int16.length);
          for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768;
          }
          resolve(float32);
        } else if (code === null) {
          rejectOnce(new Error(`Piper terminated by signal ${closeSignal ?? 'unknown'}`));
        } else {
          rejectOnce(new Error(`Piper exited with code ${code}`));
        }
      });

      process.on('error', (err) => {
        rejectOnce(new Error(`Failed to start piper: ${err.message}`));
      });

      // A process that exits while stdin is being written emits EPIPE on the
      // stream, not necessarily on ChildProcess itself. Keep an error listener
      // installed for the whole child lifetime so this becomes a normal
      // synthesis rejection rather than an uncaught process-level exception.
      process.stdin?.on('error', (err) => {
        process.kill();
        rejectOnce(new Error(`Failed to send text to piper: ${err.message}`));
      });

      // Timeout after 30 seconds
      timeout = setTimeout(() => {
        process.kill();
        rejectOnce(new Error('Piper speech generation timed out'));
      }, 30_000);

      // Send text to piper via stdin. Native stream implementations can throw
      // synchronously in addition to emitting their normal `error` event.
      try {
        process.stdin?.write(text);
        process.stdin?.end();
      } catch (value) {
        process.kill();
        const message = value instanceof Error ? value.message : String(value);
        rejectOnce(new Error(`Failed to send text to piper: ${message}`));
      }
    });
    return synthesis.then(
      (audio) => {
        this.publishAvailability(true);
        return audio;
      },
      (error) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          this.publishAvailability(false, error instanceof Error ? error.message : String(error));
        }
        throw error;
      },
    );
  }

  stop(): void {
    for (const [process, reject] of this.activeProcesses) {
      process.kill();
      reject(abortError('Piper speech generation stopped'));
    }
  }

  async destroy(): Promise<void> {
    this.stop();
    this.availabilityListeners.clear();
  }

  private publishAvailability(available: boolean, message?: string): void {
    if (this.available === available) return;
    this.available = available;
    const state: TtsAvailability = available
      ? { available: true }
      : { available: false, ...(message ? { message } : {}) };
    for (const listener of this.availabilityListeners) listener(state);
  }
}
