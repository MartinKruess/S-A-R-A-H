// src/services/llm/ollama-container-manager.ts
import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

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
type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface ContainerManagerOptions {
  execFn?: ExecFn;
  existsFn?: (filePath: string) => boolean;
  healthTimeoutMs?: number;
  healthPollMs?: number;
  gpuRetryDelayMs?: number;
}

const DOCKER_ERROR_MESSAGES: Record<Exclude<DockerState, 'ok'>, string> = {
  'not-installed':
    'Docker Desktop ist nicht installiert — Sarah benötigt Docker für das Sprachmodell.',
  'not-on-path':
    'Docker ist installiert, aber der Befehl "docker" ist nicht im PATH verfügbar.',
  'not-running': 'Docker Desktop läuft nicht — bitte Docker Desktop starten.',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OllamaContainerManager {
  private execFn: ExecFn;
  private existsFn: (filePath: string) => boolean;
  private healthTimeoutMs: number;
  private healthPollMs: number;
  private gpuRetryDelayMs: number;

  constructor(
    private baseUrl: string,
    private composePath: string,
    options: ContainerManagerOptions = {},
  ) {
    this.execFn =
      options.execFn ??
      (async (cmd, args) => {
        const { stdout, stderr } = await execFileAsync(cmd, args);
        return { stdout, stderr };
      });
    this.existsFn = options.existsFn ?? ((filePath) => fs.existsSync(filePath));
    this.healthTimeoutMs = options.healthTimeoutMs ?? 30_000;
    this.healthPollMs = options.healthPollMs ?? 500;
    this.gpuRetryDelayMs = options.gpuRetryDelayMs ?? 500;
  }

  async getStatus(): Promise<ContainerStatus> {
    try {
      const { stdout } = await this.execFn('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        CONTAINER_NAME,
      ]);
      return {
        docker: 'ok',
        container: stdout.trim() === 'true' ? 'running' : 'stopped',
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === 'ENOENT') {
        return {
          docker: this.existsFn(DOCKER_DESKTOP_CLI) ? 'not-on-path' : 'not-installed',
          container: 'unknown',
        };
      }
      if ((e.stderr ?? '').includes('No such object')) {
        return { docker: 'ok', container: 'missing' };
      }
      return { docker: 'not-running', container: 'unknown' };
    }
  }

  async ensureRunning(): Promise<void> {
    const status = await this.getStatus();
    if (status.docker !== 'ok') {
      throw new Error(DOCKER_ERROR_MESSAGES[status.docker]);
    }
    if (status.container === 'stopped') {
      await this.runDockerOrThrow(['start', CONTAINER_NAME]);
    } else if (status.container === 'missing') {
      await this.runDockerOrThrow(['compose', '-f', this.composePath, 'up', '-d']);
    }
    await this.waitForApi();
  }

  async checkGpu(): Promise<GpuStatus> {
    const first = await this.readVramStatus();
    if (first !== 'cpu') return first;
    // A model can still be loading right after warmup — retry once before
    // raising a CPU-mode alarm.
    await sleep(this.gpuRetryDelayMs);
    return this.readVramStatus();
  }

  private async readVramStatus(): Promise<GpuStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/api/ps`);
      if (!res.ok) return 'unknown';
      const data = (await res.json()) as { models: { size_vram: number }[] };
      if (!Array.isArray(data.models) || data.models.length === 0) return 'unknown';
      return data.models.some((m) => m.size_vram > 0) ? 'gpu' : 'cpu';
    } catch {
      return 'unknown';
    }
  }

  private async runDockerOrThrow(args: string[]): Promise<void> {
    try {
      await this.execFn('docker', args);
    } catch (err) {
      const e = err as Error & { stderr?: string };
      const detail = e.stderr?.trim() || e.message;
      throw new Error(
        `Ollama-Container konnte nicht gestartet werden: ${detail}`,
      );
    }
  }

  private async waitForApi(): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/api/tags`);
        if (res.ok) return;
      } catch {
        // API not up yet — keep polling
      }
      await sleep(this.healthPollMs);
    }
    throw new Error(
      `Ollama-Container antwortet nicht (Timeout nach ${Math.round(this.healthTimeoutMs / 1000)} Sekunden) — bitte Docker-Logs prüfen.`,
    );
  }
}
