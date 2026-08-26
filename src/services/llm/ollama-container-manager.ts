// src/services/llm/ollama-container-manager.ts
import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import { abortableDelay, runWithTimeout, throwIfAborted } from '../../core/abort-utils.js';

const execFileAsync = promisify(execFile);

const CONTAINER_NAME = 'sarah-ollama';
// Known Docker Desktop CLI location — used to tell "not installed" apart
// from "installed but not on PATH" when spawning `docker` fails with ENOENT.
const DOCKER_DESKTOP_CLI = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';

export type GpuStatus = 'gpu' | 'cpu' | 'unknown';
export type DockerState = 'ok' | 'not-installed' | 'not-on-path' | 'not-running';
export type ContainerState = 'running' | 'stopped' | 'missing' | 'unknown';

export interface ContainerStatus {
  docker: DockerState;
  container: ContainerState;
}

type ExecResult = { stdout: string; stderr: string };
type ExecFn = (cmd: string, args: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<ExecResult>;

export interface ContainerManagerOptions {
  execFn?: ExecFn;
  existsFn?: (filePath: string) => boolean;
  healthTimeoutMs?: number;
  healthPollMs?: number;
  gpuRetryDelayMs?: number;
  requestTimeoutMs?: number;
}

const DOCKER_ERROR_MESSAGES: Record<Exclude<DockerState, 'ok'>, string> = {
  'not-installed':
    'Docker Desktop ist nicht installiert — Sarah benötigt Docker für das Sprachmodell.',
  'not-on-path':
    'Docker ist installiert, aber der Befehl "docker" ist nicht im PATH verfügbar.',
  'not-running': 'Docker Desktop läuft nicht — bitte Docker Desktop starten.',
};

export class OllamaContainerManager {
  private execFn: ExecFn;
  private existsFn: (filePath: string) => boolean;
  private healthTimeoutMs: number;
  private healthPollMs: number;
  private gpuRetryDelayMs: number;
  private requestTimeoutMs: number;

  constructor(
    private baseUrl: string,
    private composePath: string,
    options: ContainerManagerOptions = {},
  ) {
    this.execFn =
      options.execFn ??
      (async (cmd, args, timeoutMs, signal) => {
        const { stdout, stderr } = await execFileAsync(cmd, args, {
          timeout: timeoutMs ?? 15_000,
          signal,
        });
        return { stdout, stderr };
      });
    this.existsFn = options.existsFn ?? ((filePath) => fs.existsSync(filePath));
    this.healthTimeoutMs = options.healthTimeoutMs ?? 30_000;
    this.healthPollMs = options.healthPollMs ?? 500;
    this.gpuRetryDelayMs = options.gpuRetryDelayMs ?? 500;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  async getStatus(signal?: AbortSignal): Promise<ContainerStatus> {
    throwIfAborted(signal);
    try {
      const { stdout } = await this.execFn('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        CONTAINER_NAME,
      ], undefined, signal);
      throwIfAborted(signal);
      return {
        docker: 'ok',
        container: stdout.trim() === 'true' ? 'running' : 'stopped',
      };
    } catch (err) {
      throwIfAborted(signal);
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === 'ENOENT') {
        return {
          docker: this.existsFn(DOCKER_DESKTOP_CLI) ? 'not-on-path' : 'not-installed',
          container: 'unknown',
        };
      }
      // Docker < 29 says "No such object", Docker >= 29 lowercase "no such object"
      if ((e.stderr ?? '').toLowerCase().includes('no such object')) {
        return { docker: 'ok', container: 'missing' };
      }
      return { docker: 'not-running', container: 'unknown' };
    }
  }

  async ensureRunning(signal?: AbortSignal): Promise<void> {
    const status = await this.getStatus(signal);
    if (status.docker !== 'ok') {
      throw new Error(DOCKER_ERROR_MESSAGES[status.docker]);
    }
    if (status.container === 'stopped') {
      await this.runDockerOrThrow(['start', CONTAINER_NAME], 30_000, signal);
    } else if (status.container === 'missing') {
      // Cold image pull can take minutes; still bounded so boot can never hang forever.
      await this.runDockerOrThrow(['compose', '-f', this.composePath, 'up', '-d'], 120_000, signal);
    }
    await this.waitForApi(signal);
  }

  async checkGpu(signal?: AbortSignal): Promise<GpuStatus> {
    const first = await this.readVramStatus(signal);
    if (first !== 'cpu') return first;
    // A model can still be loading right after warmup — retry once before
    // raising a CPU-mode alarm.
    await abortableDelay(this.gpuRetryDelayMs, signal);
    return this.readVramStatus(signal);
  }

  private async readVramStatus(signal?: AbortSignal): Promise<GpuStatus> {
    try {
      return await runWithTimeout(async (requestSignal) => {
        const res = await fetch(`${this.baseUrl}/api/ps`, { signal: requestSignal });
        if (!res.ok) return 'unknown';
        const data = (await res.json()) as { models: { size_vram: number }[] };
        if (!Array.isArray(data.models) || data.models.length === 0) return 'unknown';
        return data.models.some((m) => m.size_vram > 0) ? 'gpu' : 'cpu';
      }, this.requestTimeoutMs, 'Ollama GPU probe timed out', signal);
    } catch {
      throwIfAborted(signal);
      return 'unknown';
    }
  }

  private async runDockerOrThrow(
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.execFn('docker', args, timeoutMs, signal);
    } catch (err) {
      throwIfAborted(signal);
      const e = err as Error & { stderr?: string };
      const detail = e.stderr?.trim() || e.message;
      throw new Error(
        `Ollama-Container konnte nicht gestartet werden: ${detail}`,
      );
    }
  }

  private async waitForApi(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        const res = await runWithTimeout(
          (requestSignal) => fetch(`${this.baseUrl}/api/tags`, { signal: requestSignal }),
          Math.min(this.requestTimeoutMs, remainingMs),
          'Ollama health probe timed out',
          signal,
        );
        if (res.ok) return;
      } catch {
        throwIfAborted(signal);
        // API not up yet — keep polling
      }
      if (Date.now() >= deadline) break;
      await abortableDelay(this.healthPollMs, signal);
    }
    throw new Error(
      `Ollama-Container antwortet nicht (Timeout nach ${Math.max(1, Math.round(this.healthTimeoutMs / 1000))} Sekunden) — bitte Docker-Logs prüfen.`,
    );
  }
}
