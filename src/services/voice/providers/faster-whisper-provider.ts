// src/services/voice/providers/faster-whisper-provider.ts
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { SttProvider } from '../stt-provider.interface.js';

const SERVER_PORT = 8786;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const STARTUP_TIMEOUT_MS = 300_000;
const HEALTH_POLL_MS = 500;

export class FasterWhisperProvider implements SttProvider {
  readonly id = 'faster-whisper';
  private serverProcess: ChildProcess | null = null;
  private scriptPath: string;

  constructor(private resourcesPath: string) {
    this.scriptPath = path.join(resourcesPath, 'whisper', 'faster-whisper-server.py');
  }

  async init(): Promise<void> {
    // Idempotency guard — skip if server is already running
    if (this.serverProcess) return;

    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(`faster-whisper server script not found: ${this.scriptPath}`);
    }

    // Kill any leftover server from a previous run
    try {
      await fetch(`${SERVER_URL}/shutdown`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 1000));
    } catch {
      // No old server running — expected
    }

    // Start the Python server process
    this.serverProcess = spawn('python', [
      this.scriptPath,
      '--port', String(SERVER_PORT),
      '--model', 'small',
      '--device', 'auto',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.serverProcess.stdout?.on('data', (data: Buffer) => {
      console.log(data.toString('utf-8').trimEnd());
    });

    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      console.error(data.toString('utf-8').trimEnd());
    });

    this.serverProcess.on('error', (err) => {
      console.error('[FasterWhisper] Server process error:', err.message);
    });

    // Wait for server to be ready
    await this.waitForServer();
  }

  async transcribe(audio: Float32Array, sampleRate: number, language = 'de'): Promise<string> {
    const wavBuffer = this.encodeWav(audio, sampleRate);
    const tmpDir = process.env.TEMP ?? process.env.TMP ?? '/tmp';
    const tmpPath = path.join(tmpDir, `sarah-stt-${Date.now()}.wav`);
    fs.writeFileSync(tmpPath, wavBuffer);

    try {
      const res = await fetch(`${SERVER_URL}/transcribe?language=${language}&file=${encodeURIComponent(tmpPath)}`, {
        method: 'POST',
      });

      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`faster-whisper error ${res.status}: ${detail}`);
      }

      const text = await res.text();
      return text.trim();
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }

  async destroy(): Promise<void> {
    if (this.serverProcess) {
      try {
        await fetch(`${SERVER_URL}/shutdown`, { method: 'POST' });
      } catch {
        // Server may already be gone
      }
      this.serverProcess.kill();
      this.serverProcess = null;
    }
  }

  private async waitForServer(): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${SERVER_URL}/health`);
        if (res.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }

    throw new Error(`faster-whisper server did not start within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }

  private encodeWav(samples: Float32Array, sampleRate: number): Buffer {
    const numSamples = samples.length;
    const bytesPerSample = 2;
    const dataSize = numSamples * bytesPerSample;
    const headerSize = 44;
    const buf = Buffer.alloc(headerSize + dataSize);

    buf.write('RIFF', 0);
    buf.writeUInt32LE(headerSize - 8 + dataSize, 4);
    buf.write('WAVE', 8);

    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * bytesPerSample, 28);
    buf.writeUInt16LE(bytesPerSample, 32);
    buf.writeUInt16LE(16, 34);

    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < numSamples; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      const int16 = clamped < 0 ? clamped * 32768 : clamped * 32767;
      buf.writeInt16LE(Math.round(int16), headerSize + i * bytesPerSample);
    }

    return buf;
  }
}
