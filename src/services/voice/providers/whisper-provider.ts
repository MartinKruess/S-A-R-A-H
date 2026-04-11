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
    this.binaryPath = path.join(resourcesPath, 'whisper', 'whisper-cli.exe');
    this.modelPath = path.join(resourcesPath, 'whisper', 'ggml-small.bin');
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Whisper binary not found: ${this.binaryPath}`);
    }
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Whisper model not found: ${this.modelPath}`);
    }
  }

  async transcribe(audio: Float32Array, sampleRate: number, language = 'de'): Promise<string> {
    const tmpDir = process.env.TEMP ?? process.env.TMP ?? '/tmp';
    const tmpPath = path.join(tmpDir, `sarah-stt-${Date.now()}.wav`);
    const wavBuffer = this.encodeWav(audio, sampleRate);
    fs.writeFileSync(tmpPath, wavBuffer);

    try {
      const result = await this.runWhisper(tmpPath, language);
      return result.trim();
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }

  async destroy(): Promise<void> {
    // No persistent process to clean up
  }

  private encodeWav(samples: Float32Array, sampleRate: number): Buffer {
    const numSamples = samples.length;
    const bytesPerSample = 2; // 16-bit PCM
    const dataSize = numSamples * bytesPerSample;
    const headerSize = 44;
    const buf = Buffer.alloc(headerSize + dataSize);

    // RIFF header
    buf.write('RIFF', 0);
    buf.writeUInt32LE(headerSize - 8 + dataSize, 4);
    buf.write('WAVE', 8);

    // fmt chunk
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);          // chunk size
    buf.writeUInt16LE(1, 20);           // PCM format
    buf.writeUInt16LE(1, 22);           // mono
    buf.writeUInt32LE(sampleRate, 24);  // sample rate
    buf.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
    buf.writeUInt16LE(bytesPerSample, 32); // block align
    buf.writeUInt16LE(16, 34);          // bits per sample

    // data chunk
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);

    // Convert Float32 [-1, 1] to Int16 PCM
    for (let i = 0; i < numSamples; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      const int16 = clamped < 0 ? clamped * 32768 : clamped * 32767;
      buf.writeInt16LE(Math.round(int16), headerSize + i * bytesPerSample);
    }

    return buf;
  }

  private runWhisper(audioPath: string, language: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const args = [
        '--model', this.modelPath,
        '--file', audioPath,
        '--language', language,
        '--no-timestamps',
        '--threads', '4',
      ];

      const proc: ChildProcess = spawn(this.binaryPath, args);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      proc.stdout?.on('data', (data: Buffer) => {
        stdoutChunks.push(data);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderrChunks.push(data);
      });

      proc.on('close', (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
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
