// src/services/voice/providers/whisper-provider.ts
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { SttProvider } from '../stt-provider.interface.js';

export class WhisperProvider implements SttProvider {
  readonly id = 'whisper';
  private binaryPath: string;
  private modelPath: string;

  /**
   * @param resourcesPath — path to app resources directory (e.g. process.resourcesPath)
   */
  constructor(resourcesPath: string) {
    this.binaryPath = path.join(resourcesPath, 'whisper', 'whisper.exe');
    this.modelPath = path.join(resourcesPath, 'whisper', 'models', 'ggml-small.bin');
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Whisper binary not found: ${this.binaryPath}`);
    }
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Whisper model not found: ${this.modelPath}`);
    }
  }

  async transcribe(audio: Float32Array, sampleRate: number): Promise<string> {
    // Write PCM to temp file (whisper.cpp reads raw PCM files)
    const tmpDir = process.env.TEMP ?? process.env.TMP ?? '/tmp';
    const tmpPath = path.join(tmpDir, `sarah-stt-${Date.now()}.raw`);
    const buffer = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    fs.writeFileSync(tmpPath, buffer);

    try {
      const result = await this.runWhisper(tmpPath);
      return result.trim();
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }

  async destroy(): Promise<void> {
    // No persistent process to clean up
  }

  private runWhisper(audioPath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const args = [
        '--model', this.modelPath,
        '--file', audioPath,
        '--language', 'de',
        '--output-txt',
        '--no-timestamps',
        '--threads', '4',
      ];

      const proc: ChildProcess = spawn(this.binaryPath, args);
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Whisper exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start whisper: ${err.message}`));
      });

      // Timeout after 30 seconds
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('Whisper transcription timed out'));
      }, 30_000);

      proc.on('close', () => clearTimeout(timeout));
    });
  }
}
