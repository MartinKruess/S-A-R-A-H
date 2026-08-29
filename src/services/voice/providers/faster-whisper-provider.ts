// src/services/voice/providers/faster-whisper-provider.ts
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { SttAvailability, SttProvider } from '../stt-provider.interface.js';
import { normalizeUtterance } from '../normalize-audio.js';
import {
  abortableDelay,
  abortError,
  linkAbortSignals,
  runWithTimeout,
  throwIfAborted,
} from '../../../core/abort-utils.js';

const SERVER_PORT = 8786;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const STARTUP_TIMEOUT_MS = 300_000;
const HEALTH_POLL_MS = 500;
const RESTART_MAX_DELAY_MS = 30_000;
const RESTART_MAX_ATTEMPTS = 5;
const PROCESS_EXIT_TIMEOUT_MS = 1_000;
const HTTP_PROBE_TIMEOUT_MS = 5_000;
const SHUTDOWN_PROBE_TIMEOUT_MS = 1_500;
const PRIVATE_TEMP_PREFIX = 'sarah-private-stt';
const PRIVATE_TEMP_DIRECTORY_PATTERN = /^sarah-private-stt-\d+-[a-z0-9_-]{6,}$/iu;

class WhisperPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhisperPrerequisiteError';
  }
}

export class FasterWhisperProvider implements SttProvider {
  readonly id = 'faster-whisper';
  readonly recoversAfterInitFailure = true;
  private serverProcess: ChildProcess | null = null;
  private scriptPath: string;
  private lifecycleAbort = new AbortController();
  private readonly availabilityListeners = new Set<(state: SttAvailability) => void>();
  private readonly expectedStops = new Set<ChildProcess>();
  private availability: SttAvailability = { available: false };
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  private everReady = false;
  private destroyed = false;
  private tempDirectory: string | null = null;
  private readonly ownedTempFiles = new Set<string>();

  constructor(private resourcesPath: string) {
    this.cleanupStalePrivateTempDirectories();
    this.scriptPath = path.join(resourcesPath, 'whisper', 'faster-whisper-server.py');
  }

  private initPromise: Promise<void> | null = null;

  // init() is single-flight (A8): repeated calls return the same promise.
  init(signal?: AbortSignal): Promise<void> {
    if (this.destroyed) return Promise.reject(abortError('Faster Whisper has been destroyed'));
    if (!this.initPromise) {
      // Initial application startup belongs to the lifecycle caller. Recovery
      // startup is shared provider work: an individual F9 turn may stop waiting
      // for it, but must never kill the replacement process for all later turns.
      const linked = linkAbortSignals(
        this.everReady ? undefined : signal,
        this.lifecycleAbort.signal,
      );
      let attempt!: Promise<void>;
      attempt = this.doInit(linked.signal)
        .catch((error) => {
          if (this.initPromise === attempt) this.initPromise = null;
          if (!this.destroyed && error instanceof Error && error.name !== 'AbortError') {
            const message = error instanceof Error ? error.message : String(error);
            this.publishAvailability(false, message);
            if (!(error instanceof WhisperPrerequisiteError)) this.scheduleRestart();
          }
          throw error;
        })
        .finally(() => linked.dispose());
      this.initPromise = attempt;
    }
    if (!signal || !this.everReady) return this.initPromise;
    return this.waitForSharedInit(this.initPromise, signal);
  }

  private waitForSharedInit(attempt: Promise<void>, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => signal.removeEventListener('abort', onAbort);
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onAbort = (): void => finish(() => {
        const reason = signal.reason;
        reject(reason instanceof Error ? reason : abortError());
      });
      signal.addEventListener('abort', onAbort, { once: true });
      attempt.then(
        () => finish(resolve),
        (error: Error) => finish(() => reject(error)),
      );
    });
  }

  onAvailabilityChange(listener: (state: SttAvailability) => void): () => void {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  private async doInit(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    // Idempotency guard — skip if server is already running
    if (this.serverProcess) return;

    if (!fs.existsSync(this.scriptPath)) {
      throw new WhisperPrerequisiteError(
        `faster-whisper server script not found: ${this.scriptPath}`,
      );
    }

    // Kill any leftover server from a previous run
    try {
      await runWithTimeout(
        (requestSignal) => fetch(`${SERVER_URL}/shutdown`, {
          method: 'POST',
          signal: requestSignal,
        }).then(() => undefined),
        SHUTDOWN_PROBE_TIMEOUT_MS,
        'Faster Whisper previous-runtime shutdown probe timed out',
        signal,
      );
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
    const child = spawn('python', [
      this.scriptPath,
      '--port', String(SERVER_PORT),
      // large-v3-turbo: big German accuracy jump over 'small'. int8 keeps VRAM
      // ~2 GB so it coexists with the LLM on an 8 GB GPU (RTX 3050).
      '--model', 'large-v3-turbo',
      '--device', 'auto',
      '--compute-type', 'int8',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.serverProcess = child;

    child.stdout?.on('data', (data: Buffer) => {
      console.log(data.toString('utf-8').trimEnd());
    });

    child.stderr?.on('data', (data: Buffer) => {
      console.error(data.toString('utf-8').trimEnd());
    });

    child.on('error', (err) => {
      console.error('[FasterWhisper] Server process error:', err.message);
      const code = 'code' in err ? err.code : undefined;
      const message = `Failed to start faster-whisper (is Python in PATH?): ${err.message}`;
      const error = code === 'ENOENT' || code === 'EACCES'
        ? new WhisperPrerequisiteError(message)
        : new Error(message);
      if (startupComplete) this.handleRuntimeFailure(child, error.message);
      else rejectOnSpawnError(error);
    });

    const processExited = new Promise<never>((_, reject) => {
      child.once('exit', (code, exitSignal) => {
        if (this.expectedStops.has(child)) return;
        const detail = exitSignal ? `signal ${exitSignal}` : `code ${code ?? 'unknown'}`;
        if (!startupComplete) {
          reject(new Error(`faster-whisper exited before becoming ready (${detail})`));
        } else {
          this.handleRuntimeFailure(child, `faster-whisper server stopped unexpectedly (${detail})`);
        }
      });
    });

    const onAbort = (): void => {
      if (this.serverProcess === child) this.serverProcess = null;
      this.expectedStops.add(child);
      child.kill();
      rejectOnSpawnError(abortError('Faster Whisper startup aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // Wait for server to be ready, abort immediately if the process itself fails.
      await Promise.race([this.waitForServer(signal), spawnFailed, processExited]);
      startupComplete = true;
      this.everReady = true;
      this.restartAttempt = 0;
      this.publishAvailability(true);
    } catch (error) {
      await this.stopProcess(child);
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async transcribe(
    audio: Float32Array,
    sampleRate: number,
    language = 'de',
    signal?: AbortSignal,
  ): Promise<string> {
    this.throwIfRequestAborted(signal);
    await this.init(signal);
    this.throwIfRequestAborted(signal);
    // Normalize the utterance level before Whisper — the capture path applies no
    // AGC, so this is what stops "only works when I shout" quiet/clipped input.
    const wavBuffer = this.encodeWav(normalizeUtterance(audio), sampleRate);
    const tmpPath = path.join(this.getPrivateTempDirectory(), `${randomUUID()}.wav`);
    fs.writeFileSync(tmpPath, wavBuffer, { mode: 0o600, flag: 'wx' });
    this.ownedTempFiles.add(tmpPath);

    try {
      let res: Response;
      try {
        res = await fetch(`${SERVER_URL}/transcribe?language=${language}&file=${encodeURIComponent(tmpPath)}`, {
          method: 'POST',
          signal,
        });
      } catch (value) {
        const reason = signal?.aborted && signal.reason instanceof Error
          ? signal.reason
          : value instanceof Error
            ? value
            : new Error(String(value));
        // Once native transcription has started, aborting only the HTTP request
        // does not stop the single-threaded Whisper work. Recycle the owned
        // process so a following turn cannot queue behind discarded inference.
        await this.recycleRuntime(reason.message);
        throw reason;
      }

      if (!res.ok) {
        const detail = await res.text();
        const error = new Error(`faster-whisper error ${res.status}: ${detail}`);
        if (res.status >= 500) {
          await this.recycleRuntime(`faster-whisper server error ${res.status}`);
        }
        throw error;
      }

      const text = await res.text();
      return text.trim();
    } finally {
      this.cleanupOwnedTempFile(tmpPath);
    }
  }

  private throwIfRequestAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    throw reason instanceof Error ? reason : abortError();
  }

  /** Creates one unpredictable, process-owned STT directory without scanning sibling artifacts. */
  private getPrivateTempDirectory(): string {
    if (this.tempDirectory) return this.tempDirectory;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${PRIVATE_TEMP_PREFIX}-${process.pid}-`));
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      // Windows ACLs are inherited from the current user's temp directory.
    }
    this.tempDirectory = directory;
    return directory;
  }

  /** Removes only abandoned process directories created by Sarah's STT provider. */
  private cleanupStalePrivateTempDirectories(): void {
    const tempRoot = os.tmpdir();
    try {
      for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !PRIVATE_TEMP_DIRECTORY_PATTERN.test(entry.name)) continue;
        const candidate = path.join(tempRoot, entry.name);
        try {
          const metadata = fs.lstatSync(candidate);
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
          fs.rmSync(candidate, { recursive: true, force: true, maxRetries: 1, retryDelay: 10 });
        } catch (error) {
          console.warn('[FasterWhisper] Stale private audio cleanup failed:', error);
        }
      }
    } catch (error) {
      console.warn('[FasterWhisper] Private audio directory scan failed:', error);
    }
  }

  /** Removes only a WAV path created and tracked by this provider instance. */
  private cleanupOwnedTempFile(filePath: string): void {
    if (!this.ownedTempFiles.has(filePath)) return;
    try {
      fs.unlinkSync(filePath);
      this.ownedTempFiles.delete(filePath);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') this.ownedTempFiles.delete(filePath);
      else console.warn('[FasterWhisper] Temporary audio cleanup failed:', error);
    }
  }

  async destroy(signal?: AbortSignal): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.lifecycleAbort.abort();
    const process = this.serverProcess;
    this.serverProcess = null;
    this.initPromise = null;
    if (process) {
      this.expectedStops.add(process);
      try {
        await runWithTimeout(
          (cleanupSignal) => fetch(`${SERVER_URL}/shutdown`, {
            method: 'POST',
            signal: cleanupSignal,
          }).then(() => undefined),
          1_500,
          'Faster Whisper graceful shutdown timed out',
          signal,
        );
      } catch {
        // Server may already be gone
      } finally {
        process.kill();
        await this.waitForProcessExit(process);
        this.expectedStops.delete(process);
      }
    }
    this.availabilityListeners.clear();
    for (const filePath of [...this.ownedTempFiles]) this.cleanupOwnedTempFile(filePath);
    if (this.tempDirectory) {
      try {
        fs.rmdirSync(this.tempDirectory);
        this.tempDirectory = null;
      } catch {
        // Non-empty or locked process-owned directories are left untouched.
      }
    }
  }

  private handleRuntimeFailure(process: ChildProcess, message: string): void {
    if (
      this.destroyed
      || this.expectedStops.has(process)
      || this.serverProcess !== process
    ) return;
    this.serverProcess = null;
    this.initPromise = null;
    this.publishAvailability(false, message);
    this.scheduleRestart();
  }

  private async recycleRuntime(message: string): Promise<void> {
    const process = this.serverProcess;
    this.serverProcess = null;
    this.initPromise = null;
    this.publishAvailability(false, message);
    if (process) await this.stopProcess(process);
    this.scheduleRestart();
  }

  private async stopProcess(process: ChildProcess): Promise<void> {
    this.expectedStops.add(process);
    if (this.serverProcess === process) this.serverProcess = null;
    process.kill();
    await this.waitForProcessExit(process);
    this.expectedStops.delete(process);
  }

  private waitForProcessExit(process: ChildProcess): Promise<void> {
    if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (timer) clearTimeout(timer);
        process.removeListener('exit', finish);
        resolve();
      };
      process.once('exit', finish);
      timer = setTimeout(finish, PROCESS_EXIT_TIMEOUT_MS);
      timer.unref?.();
    });
  }

  private scheduleRestart(): void {
    if (this.destroyed || this.restartTimer || this.restartAttempt >= RESTART_MAX_ATTEMPTS) return;
    const delayMs = Math.min(1_000 * (2 ** this.restartAttempt), RESTART_MAX_DELAY_MS);
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.init().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[FasterWhisper] Automatic restart failed:', message);
      });
    }, delayMs);
    this.restartTimer.unref?.();
  }

  async retry(signal?: AbortSignal): Promise<void> {
    if (this.destroyed) throw abortError('Faster Whisper has been destroyed');
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.restartAttempt = 0;
    await this.init(signal);
  }

  private publishAvailability(available: boolean, message?: string): void {
    const next = message ? { available, message } : { available };
    if (this.availability.available === next.available && this.availability.message === next.message) return;
    this.availability = next;
    for (const listener of this.availabilityListeners) listener({ ...next });
  }

  private async waitForServer(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        const res = await runWithTimeout(
          (requestSignal) => fetch(`${SERVER_URL}/health`, { signal: requestSignal }),
          Math.min(HTTP_PROBE_TIMEOUT_MS, remainingMs),
          'Faster Whisper health probe timed out',
          signal,
        );
        if (res.ok) return;
      } catch {
        throwIfAborted(signal);
        // Server not ready yet
      }
      if (Date.now() >= deadline) break;
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
