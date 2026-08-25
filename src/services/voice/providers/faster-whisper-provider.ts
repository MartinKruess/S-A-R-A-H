// src/services/voice/providers/faster-whisper-provider.ts
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { SttProvider } from '../stt-provider.interface.js';
import { normalizeUtterance } from '../normalize-audio.js';
import {
  abortableDelay,
  abortError,
  linkAbortSignals,
  throwIfAborted,
} from '../../../core/abort-utils.js';

const SERVER_PORT = 8786;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const STARTUP_TIMEOUT_MS = 300_000;
const HEALTH_POLL_MS = 500;

export class FasterWhisperProvider implements SttProvider {
  readonly id = 'faster-whisper';
  private serverProcess: ChildProcess | null = null;
  private scriptPath: string;
  private lifecycleAbort = new AbortController();

  constructor(private resourcesPath: string) {
    this.scriptPath = path.join(resourcesPath, 'whisper', 'faster-whisper-server.py');
  }

  private initPromise: Promise<void> | null = null;

  // init() is single-flight (A8): repeated calls return the same promise.
  init(signal?: AbortSignal): Promise<void> {
    if (!this.initPromise) {
      const linked = linkAbortSignals(signal, this.lifecycleAbort.signal);
      this.initPromise = this.doInit(linked.signal).finally(() => linked.dispose());
    }
    return this.initPromise;
  }

  private async doInit(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    // Idempotency guard — skip if server is already running
    if (this.serverProcess) return;

    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(`faster-whisper server script not found: ${this.scriptPath}`);
    }

    // Kill any leftover server from a previous run
    try {
      await fetch(`${SERVER_URL}/shutdown`, { method: 'POST', signal });
      await abortableDelay(1000, signal);
    } catch {
      throwIfAborted(signal);
      // No old server running — expected
    }

    // Rejects immediately if Python is not found or the process fails to start
    let rejectOnSpawnError!: (err: Error) => void;
    const spawnFailed = new Promise<never>((_, reject) => {
      rejectOnSpawnError = reject;
    });
    let startupComplete = false;

    // Start the Python server process
    this.serverProcess = spawn('python', [
      this.scriptPath,
      '--port', String(SERVER_PORT),
      // large-v3-turbo: big German accuracy jump over 'small'. int8 keeps VRAM
      // ~2 GB so it coexists with the LLM on an 8 GB GPU (RTX 3050).
      '--model', 'large-v3-turbo',
      '--device', 'auto',
      '--compute-type', 'int8',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.serverProcess.stdout?.on('data', (data: Buffer) => {
      console.log(data.toString('utf-8').trimEnd());
    });

    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      console.error(data.toString('utf-8').trimEnd());
    });

    this.serverProcess.on('error', (err) => {
      console.error('[FasterWhisper] Server process error:', err.message);
      this.serverProcess = null;
      rejectOnSpawnError(new Error(`Failed to start faster-whisper (is Python in PATH?): ${err.message}`));
    });

    const processExited = new Promise<never>((_, reject) => {
      this.serverProcess?.once('exit', (code, exitSignal) => {
        this.serverProcess = null;
        if (!startupComplete) {
          const detail = exitSignal ? `signal ${exitSignal}` : `code ${code ?? 'unknown'}`;
          reject(new Error(`faster-whisper exited before becoming ready (${detail})`));
        }
      });
    });

    const onAbort = (): void => {
      this.serverProcess?.kill();
      this.serverProcess = null;
      rejectOnSpawnError(abortError('Faster Whisper startup aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // Wait for server to be ready, abort immediately if the process itself fails.
      await Promise.race([this.waitForServer(signal), spawnFailed, processExited]);
      startupComplete = true;
    } catch (error) {
      await this.destroy();
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async transcribe(audio: Float32Array, sampleRate: number, language = 'de'): Promise<string> {
    // Normalize the utterance level before Whisper — the capture path applies no
    // AGC, so this is what stops "only works when I shout" quiet/clipped input.
    const wavBuffer = this.encodeWav(normalizeUtterance(audio), sampleRate);
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
    this.lifecycleAbort.abort();
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

  private async waitForServer(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${SERVER_URL}/health`, { signal });
        if (res.ok) return;
      } catch {
        throwIfAborted(signal);
        // Server not ready yet
      }
      await abortableDelay(HEALTH_POLL_MS, signal);
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
