// src/services/voice/providers/piper-provider.ts
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { TtsProvider } from '../tts-provider.interface.js';

export class PiperProvider implements TtsProvider {
  readonly id = 'piper';
  private binaryPath: string;
  private voicePath: string;
  private activeProcess: ChildProcess | null = null;

  /**
   * @param resourcesPath — path to app resources directory
   */
  constructor(resourcesPath: string) {
    this.binaryPath = path.join(resourcesPath, 'piper', 'piper.exe');
    this.voicePath = path.join(resourcesPath, 'piper', 'de_DE-thorsten-medium.onnx');
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Piper binary not found: ${this.binaryPath}`);
    }
    if (!fs.existsSync(this.voicePath)) {
      throw new Error(`Piper voice not found: ${this.voicePath}`);
    }
  }

  async speak(text: string): Promise<Float32Array> {
    return new Promise<Float32Array>((resolve, reject) => {
      const args = [
        '--model', this.voicePath,
        '--output_raw',
      ];

      this.activeProcess = spawn(this.binaryPath, args);
      const chunks: Buffer[] = [];
      let rejected = false;

      this.activeProcess.stdout?.on('data', (data: Buffer) => {
        chunks.push(data);
      });

      this.activeProcess.stderr?.on('data', () => {
        // Piper logs progress to stderr, ignore
      });

      this.activeProcess.on('close', (code) => {
        this.activeProcess = null;
        if (rejected) return;

        if (code === 0 || code === null) {
          const combined = Buffer.concat(chunks);
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
        } else {
          reject(new Error(`Piper exited with code ${code}`));
        }
      });

      this.activeProcess.on('error', (err) => {
        this.activeProcess = null;
        rejected = true;
        reject(new Error(`Failed to start piper: ${err.message}`));
      });

      // Send text to piper via stdin
      this.activeProcess.stdin?.write(text);
      this.activeProcess.stdin?.end();

      // Timeout after 30 seconds
      const timeout = setTimeout(() => {
        rejected = true;
        this.stop();
        reject(new Error('Piper speech generation timed out'));
      }, 30_000);

      this.activeProcess.on('close', () => clearTimeout(timeout));
    });
  }

  stop(): void {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.activeProcess = null;
    }
  }

  async destroy(): Promise<void> {
    this.stop();
  }
}
