# Ollama in Docker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Ollama in a Docker container with a frozen CUDA runtime so NVIDIA driver updates can no longer silently break GPU inference, and make Sarah detect and self-heal container/GPU problems at boot.

**Architecture:** A pinned `ollama/ollama:0.32.0` container (compose file at repo root) serves the existing `http://localhost:11434` API — no changes to `OllamaProvider`/`RouterService` logic. A new `OllamaContainerManager` (plain class, no registry) is chained *before* the eagerly-started `routerService.init()` in `boot-sequence.ts` and checks GPU residency via `/api/ps` after warmup.

**Tech Stack:** TypeScript (Electron main process), `child_process.execFile` for Docker CLI (no new npm deps), Docker Compose, vitest.

**Spec:** `docs/superpowers/specs/2026-07-15-ollama-docker-design.md`

## Global Constraints

- TypeScript: never use `unknown`, `never`, or `any` unless absolutely unavoidable (CLAUDE.md)
- Code and commits in English, UI text in German (CLAUDE.md)
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:` (CLAUDE.md)
- Container name is exactly `sarah-ollama`; image pinned to `ollama/ollama:0.32.0`; port bound to `127.0.0.1:11434` only; volume `sarah-ollama-models`
- Health polling timeout **30 s** (never 5 min — analyze-fabel.md Bug 3.2)
- `OLLAMA_FLASH_ATTENTION` stays OFF (caused CUDA 500 crashes on this machine)
- Work happens in worktree `G:\projects\S-A-R-A-H\.claude\worktrees\feat-ollama-docker`, branch `feat/ollama-docker`, PR targets `dev`

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `tests/services/llm/llm-service.test.ts` | **Delete** | Stale duplicate — imports removed `llm-service.ts`; `router-service.test.ts` covers the successor |
| `docker-compose.yml` | Create (repo root) | Declarative container definition (image, GPU, port, volume, restart policy) |
| `src/services/llm/ollama-container-manager.ts` | Create | Container lifecycle (ensureRunning), GPU check (checkGpu), status (getStatus) |
| `tests/services/llm/ollama-container-manager.test.ts` | Create | Unit tests, Docker CLI and fetch fully mocked |
| `src/main.ts` | Modify | Instantiate manager, pass via `BootSequenceDeps` |
| `src/main/boot-sequence.ts` | Modify | Chain `ensureRunning()` before `routerService.init()`, GPU check + boot messages |

---

### Task 1: Housekeeping — remove stale llm-service test

**Files:**
- Delete: `tests/services/llm/llm-service.test.ts`

**Interfaces:** none (pure cleanup). Context: `src/services/llm/llm-service.ts` was renamed to `router-service.ts` in the housekeeping refactor (#15); the old test file still imports the removed module and fails the suite on `dev`. `tests/services/llm/router-service.test.ts` already tests the successor class.

- [ ] **Step 1: Verify the file is stale**

Run: `ls src/services/llm/llm-service.ts`
Expected: `No such file or directory`

Run: `ls tests/services/llm/router-service.test.ts`
Expected: file exists

- [ ] **Step 2: Delete the stale test**

```bash
git rm tests/services/llm/llm-service.test.ts
```

- [ ] **Step 3: Run the full test suite to verify green baseline**

Run: `npm test`
Expected: typecheck passes, **all test files pass** (31 files, 322 tests — previously 1 failed suite)

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(tests): remove stale llm-service test superseded by router-service test"
```

---

### Task 2: docker-compose.yml

**Files:**
- Create: `docker-compose.yml` (repo root)

**Interfaces:**
- Produces: container `sarah-ollama` on `127.0.0.1:11434`, volume `sarah-ollama-models`. Task 3's `ensureRunning()` runs `docker compose -f <path> up -d` against this file; Task 6 uses it for first-time setup.

- [ ] **Step 1: Write the compose file**

```yaml
# S.A.R.A.H. — Ollama LLM backend.
# Frozen CUDA runtime inside the image: NVIDIA driver updates on Windows
# can no longer break GPU inference (see spec 2026-07-15-ollama-docker-design.md).
# Image is pinned deliberately — upgrade only by editing this tag and re-testing.
services:
  ollama:
    image: ollama/ollama:0.32.0
    container_name: sarah-ollama
    restart: unless-stopped
    ports:
      # localhost only — never expose Ollama to the network
      - "127.0.0.1:11434:11434"
    volumes:
      - sarah-ollama-models:/root/.ollama
    # OLLAMA_FLASH_ATTENTION stays OFF (Ollama default): enabling it caused
    # CUDA 500 crashes on this setup (RTX 3050). Do not enable without re-testing.
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]

volumes:
  sarah-ollama-models:
```

- [ ] **Step 2: Validate the file syntax**

Run: `docker compose -f docker-compose.yml config --quiet && echo OK`

Expected: `OK` (no output before it means valid).
**If `docker` is not installed yet** (expected on this machine until Task 6): skip — validation is repeated as the first step of Task 6.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(llm): add docker compose definition for sarah-ollama container"
```

---

### Task 3: OllamaContainerManager — getStatus + ensureRunning

**Files:**
- Create: `src/services/llm/ollama-container-manager.ts`
- Test: `tests/services/llm/ollama-container-manager.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (Docker CLI + fetch, both injectable).
- Produces (used by Task 4 and Task 5):

```ts
export type GpuStatus = 'gpu' | 'cpu' | 'unknown';
export type DockerState = 'ok' | 'not-installed' | 'not-on-path' | 'not-running';
export type ContainerState = 'running' | 'stopped' | 'missing' | 'unknown';
export interface ContainerStatus { docker: DockerState; container: ContainerState; }

export class OllamaContainerManager {
  constructor(baseUrl: string, composePath: string, options?: ContainerManagerOptions);
  getStatus(): Promise<ContainerStatus>;
  ensureRunning(): Promise<void>;   // throws Error with German user-facing message
  checkGpu(): Promise<GpuStatus>;   // implemented in Task 4
}
```

- [ ] **Step 1: Write the failing tests for getStatus**

Create `tests/services/llm/ollama-container-manager.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OllamaContainerManager,
  type ContainerManagerOptions,
} from '../../../src/services/llm/ollama-container-manager';

const BASE_URL = 'http://localhost:11434';
const COMPOSE_PATH = 'G:\\fake\\docker-compose.yml';

type ExecCall = { cmd: string; args: string[] };

function enoentError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('spawn docker ENOENT');
  err.code = 'ENOENT';
  return err;
}

function execError(stderr: string): Error & { stderr: string } {
  const err = new Error('docker exited 1') as Error & { stderr: string };
  err.stderr = stderr;
  return err;
}

function createManager(
  options: Partial<ContainerManagerOptions> & {
    execResults?: Array<{ stdout: string } | Error>;
  } = {},
): { manager: OllamaContainerManager; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const results = [...(options.execResults ?? [])];
  const manager = new OllamaContainerManager(BASE_URL, COMPOSE_PATH, {
    execFn: async (cmd, args) => {
      calls.push({ cmd, args });
      const next = results.shift();
      if (next === undefined) return { stdout: '', stderr: '' };
      if (next instanceof Error) throw next;
      return { stdout: next.stdout, stderr: '' };
    },
    existsFn: options.existsFn ?? (() => false),
    healthTimeoutMs: options.healthTimeoutMs ?? 50,
    healthPollMs: options.healthPollMs ?? 1,
    gpuRetryDelayMs: options.gpuRetryDelayMs ?? 1,
  });
  return { manager, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OllamaContainerManager.getStatus', () => {
  it('reports running container', async () => {
    const { manager } = createManager({ execResults: [{ stdout: 'true\n' }] });
    expect(await manager.getStatus()).toEqual({ docker: 'ok', container: 'running' });
  });

  it('reports stopped container', async () => {
    const { manager } = createManager({ execResults: [{ stdout: 'false\n' }] });
    expect(await manager.getStatus()).toEqual({ docker: 'ok', container: 'stopped' });
  });

  it('reports missing container when inspect says no such object', async () => {
    const { manager } = createManager({
      execResults: [execError('Error: No such object: sarah-ollama')],
    });
    expect(await manager.getStatus()).toEqual({ docker: 'ok', container: 'missing' });
  });

  it('distinguishes docker-not-installed via ENOENT + missing install path', async () => {
    const { manager } = createManager({
      execResults: [enoentError()],
      existsFn: () => false,
    });
    expect(await manager.getStatus()).toEqual({ docker: 'not-installed', container: 'unknown' });
  });

  it('distinguishes docker-not-on-path via ENOENT + existing install path', async () => {
    const { manager } = createManager({
      execResults: [enoentError()],
      existsFn: () => true,
    });
    expect(await manager.getStatus()).toEqual({ docker: 'not-on-path', container: 'unknown' });
  });

  it('reports docker daemon not running on other CLI errors', async () => {
    const { manager } = createManager({
      execResults: [execError('error during connect: the docker daemon is not running')],
    });
    expect(await manager.getStatus()).toEqual({ docker: 'not-running', container: 'unknown' });
  });
});

describe('OllamaContainerManager.ensureRunning', () => {
  function mockHealthyApi(): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"models":[]}', { status: 200 }),
    );
  }

  it('resolves without docker start when container already runs', async () => {
    mockHealthyApi();
    const { manager, calls } = createManager({ execResults: [{ stdout: 'true\n' }] });
    await manager.ensureRunning();
    expect(calls).toHaveLength(1); // inspect only
  });

  it('starts a stopped container and waits for the API', async () => {
    mockHealthyApi();
    const { manager, calls } = createManager({
      execResults: [{ stdout: 'false\n' }, { stdout: '' }],
    });
    await manager.ensureRunning();
    expect(calls[1]).toEqual({ cmd: 'docker', args: ['start', 'sarah-ollama'] });
  });

  it('creates a missing container via docker compose up', async () => {
    mockHealthyApi();
    const { manager, calls } = createManager({
      execResults: [execError('Error: No such object: sarah-ollama'), { stdout: '' }],
    });
    await manager.ensureRunning();
    expect(calls[1]).toEqual({
      cmd: 'docker',
      args: ['compose', '-f', COMPOSE_PATH, 'up', '-d'],
    });
  });

  it('throws a German message when docker is not installed', async () => {
    const { manager } = createManager({ execResults: [enoentError()], existsFn: () => false });
    await expect(manager.ensureRunning()).rejects.toThrow(/Docker Desktop ist nicht installiert/);
  });

  it('throws a German message when docker is installed but not on PATH', async () => {
    const { manager } = createManager({ execResults: [enoentError()], existsFn: () => true });
    await expect(manager.ensureRunning()).rejects.toThrow(/nicht im PATH/);
  });

  it('throws a timeout error when the API never becomes healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const { manager } = createManager({
      execResults: [{ stdout: 'false\n' }, { stdout: '' }],
      healthTimeoutMs: 10,
      healthPollMs: 1,
    });
    await expect(manager.ensureRunning()).rejects.toThrow(/antwortet nicht/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/llm/ollama-container-manager.test.ts`
Expected: FAIL — `Cannot find module '../../../src/services/llm/ollama-container-manager'`

- [ ] **Step 3: Write the implementation**

Create `src/services/llm/ollama-container-manager.ts`:

```ts
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
      await this.execFn('docker', ['start', CONTAINER_NAME]);
    } else if (status.container === 'missing') {
      await this.execFn('docker', ['compose', '-f', this.composePath, 'up', '-d']);
    }
    await this.waitForApi();
  }

  async checkGpu(): Promise<GpuStatus> {
    // Implemented in Task 4.
    return 'unknown';
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
      'Ollama-Container antwortet nicht (Timeout nach 30 Sekunden) — bitte Docker-Logs prüfen.',
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/llm/ollama-container-manager.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors

```bash
git add src/services/llm/ollama-container-manager.ts tests/services/llm/ollama-container-manager.test.ts
git commit -m "feat(llm): add OllamaContainerManager with self-healing ensureRunning"
```

---

### Task 4: checkGpu with retry

**Files:**
- Modify: `src/services/llm/ollama-container-manager.ts` (replace the `checkGpu` stub)
- Test: `tests/services/llm/ollama-container-manager.test.ts` (append describe block)

**Interfaces:**
- Consumes: `OllamaContainerManager` from Task 3.
- Produces: `checkGpu(): Promise<GpuStatus>` — `'gpu'` when any loaded model has `size_vram > 0`; `'cpu'` only after one retry (delay `gpuRetryDelayMs`) still reports 0; `'unknown'` when nothing is loaded or the API is unreachable. Task 5 relies on exactly these semantics.

- [ ] **Step 1: Write the failing tests**

Append to `tests/services/llm/ollama-container-manager.test.ts`:

```ts
describe('OllamaContainerManager.checkGpu', () => {
  function psResponse(sizeVram: number): Response {
    return new Response(
      JSON.stringify({ models: [{ model: 'phi4-mini:3.8b', size_vram: sizeVram }] }),
      { status: 200 },
    );
  }

  it('returns gpu when a loaded model resides in VRAM', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(psResponse(2_000_000_000));
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('gpu');
  });

  it('returns cpu only after the retry also reports zero VRAM', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(psResponse(0));
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('cpu');
    expect(spy).toHaveBeenCalledTimes(2); // first read + one retry
  });

  it('returns gpu when the retry sees the model arrive in VRAM (no false alarm)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(psResponse(0))
      .mockResolvedValueOnce(psResponse(2_000_000_000));
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('gpu');
  });

  it('returns unknown when no model is loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"models":[]}', { status: 200 }),
    );
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('unknown');
  });

  it('returns unknown when the API is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const { manager } = createManager();
    expect(await manager.checkGpu()).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/services/llm/ollama-container-manager.test.ts`
Expected: the two `gpu`/`cpu` assertions FAIL (stub returns `'unknown'`), unknown-cases pass

- [ ] **Step 3: Replace the stub with the implementation**

In `src/services/llm/ollama-container-manager.ts`, replace:

```ts
  async checkGpu(): Promise<GpuStatus> {
    // Implemented in Task 4.
    return 'unknown';
  }
```

with:

```ts
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
```

- [ ] **Step 4: Run all manager tests to verify they pass**

Run: `npx vitest run tests/services/llm/ollama-container-manager.test.ts`
Expected: PASS (17 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors

```bash
git add src/services/llm/ollama-container-manager.ts tests/services/llm/ollama-container-manager.test.ts
git commit -m "feat(llm): add checkGpu VRAM residency check with single retry"
```

---

### Task 5: Wire manager into main.ts and boot-sequence.ts

**Files:**
- Modify: `src/main.ts` (instantiation next to `RouterService`, ~line 78; deps at ~line 131)
- Modify: `src/main/boot-sequence.ts` (deps interface, init chain lines 29–35, boot-ready handler lines 44–54)

**Interfaces:**
- Consumes: `OllamaContainerManager`, `ensureRunning()`, `checkGpu()` from Tasks 3–4; `docker-compose.yml` path from Task 2.
- Produces: boot flow that (1) self-heals the container before router init, (2) surfaces Docker errors on the boot screen via the existing `'router'` boot-status step, (3) warns visibly on CPU mode. No new IPC contracts — `BootStatus` step union stays unchanged.

- [ ] **Step 1: Instantiate the manager in `src/main.ts`**

Add to the imports (next to the existing llm imports, top of file):

```ts
import { OllamaContainerManager } from './services/llm/ollama-container-manager.js';
```

After `appContext.registry.register(routerService);` (line 79), add:

```ts
  // Plain class, deliberately not a SarahService/registry entry (YAGNI —
  // registry integration comes with the cockpit status display).
  const containerManager = new OllamaContainerManager(
    llmConfig.baseUrl,
    path.join(app.getAppPath(), 'docker-compose.yml'),
  );
```

In the `registerBootHandlers({ ... })` call (line 131), add `containerManager`:

```ts
  registerBootHandlers({
    getMainWindow,
    getAppContext,
    routerService,
    whisperProvider,
    piperProvider,
    containerManager,
  });
```

- [ ] **Step 2: Chain ensureRunning in `src/main/boot-sequence.ts`**

Add the type import at the top:

```ts
import type { OllamaContainerManager } from '../services/llm/ollama-container-manager.js';
```

Extend the deps interface:

```ts
export interface BootSequenceDeps {
  getMainWindow: () => BrowserWindow | null;
  getAppContext: () => AppContext;
  routerService: RouterService;
  whisperProvider: FasterWhisperProvider;
  piperProvider: PiperProvider;
  containerManager: OllamaContainerManager;
}
```

Update the destructuring:

```ts
  const { getMainWindow, getAppContext, routerService, whisperProvider, piperProvider, containerManager } = deps;
```

Replace the eager router init (lines 33–35):

```ts
  const routerReady = routerService.init().catch((err) => {
    console.error('[Boot] Router init failed:', err);
  });
```

with:

```ts
  // Container must be up before router init — chained so the promise still
  // starts eagerly at registration time (orb-reveal timing unchanged).
  let containerError: string | null = null;
  const routerReady = containerManager
    .ensureRunning()
    .then(() => routerService.init())
    .catch((err) => {
      containerError = err instanceof Error ? err.message : String(err);
      console.error('[Boot] Ollama container/router init failed:', err);
    });
```

- [ ] **Step 3: Surface errors and GPU state in the boot-ready handler**

In the `boot-ready` handler, replace:

```ts
      await routerReady;

      // Signal router ready — renderer starts orb reveal immediately
      send('router-ready');
```

with:

```ts
      await routerReady;

      if (containerError) {
        send('router', containerError);
      } else {
        const gpu = await containerManager.checkGpu();
        if (gpu === 'cpu') {
          console.warn('[Boot] Ollama is running WITHOUT GPU (CPU mode)');
          send('router', 'Warnung: Ollama läuft ohne GPU — Antworten werden sehr langsam.');
          // Keep the warning readable before router-ready hides the status line
          await new Promise((r) => setTimeout(r, 3000));
        }
      }

      // Signal router ready — renderer starts orb reveal immediately
      send('router-ready');
```

- [ ] **Step 4: Typecheck and run the full suite**

Run: `npm test`
Expected: typecheck passes, all test files pass (32 files — 31 previous + the new manager suite)

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/main/boot-sequence.ts
git commit -m "feat(boot): self-heal ollama container and detect CPU mode at boot"
```

---

### Task 6: MANUAL — Docker Desktop setup and end-to-end verification (Martin + Claude)

**Files:** none (machine setup). This task is executed interactively with Martin at the keyboard — **do not dispatch to a subagent.**

**Interfaces:**
- Consumes: `docker-compose.yml` (Task 2), wired boot flow (Task 5).
- Produces: running `sarah-ollama` container with both models pulled; native Ollama autostart disabled.

- [ ] **Step 1: Install WSL2 + Docker Desktop** (Martin, guided)

```powershell
wsl --install --no-distribution
```

Reboot if prompted. Then download and install Docker Desktop from https://www.docker.com/products/docker-desktop/ — during setup keep "Use WSL 2 based engine" checked; afterwards in Docker Desktop Settings → General enable **"Start Docker Desktop when you sign in"**.

Verify: `docker version` shows Client and Server sections.

- [ ] **Step 2: Stop native Ollama and disable its autostart** (Martin)

Quit the Ollama tray icon, then remove it from autostart (Task-Manager → Autostart → Ollama → Deaktivieren). Do **not** uninstall yet — it stays as fallback during the trial period.

Verify port is free: `curl.exe -s http://localhost:11434/api/tags` → connection refused.

- [ ] **Step 3: Validate compose file and start the container**

```powershell
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml up -d
docker ps
```

Expected: `sarah-ollama` with status `Up`.

- [ ] **Step 4: Pull both models into the volume (~8.5 GB download, one-time)**

```powershell
docker exec sarah-ollama ollama pull phi4-mini:3.8b
docker exec sarah-ollama ollama pull qwen3:8b
```

- [ ] **Step 5: Verify GPU inside the container**

```powershell
docker logs sarah-ollama 2>&1 | Select-String -Pattern "inference compute"
```

Expected: a line containing `library=CUDA` and `NVIDIA GeForce RTX 3050`.

- [ ] **Step 6: End-to-end checks (Arbeitsteilung)**

Martin runs `npm start` and verifies:
1. Normal boot: Sarah boots, chat answers at normal speed
2. Self-healing: `docker stop sarah-ollama` → start Sarah → container comes up automatically, boot completes
3. Error path: quit Docker Desktop → start Sarah → boot shows „Docker Desktop läuft nicht — bitte Docker Desktop starten." instead of hanging
4. Voice roundtrip: answer latency comparable to the ~5.4 s warm baseline
5. Self-heal recreate: `docker rm -f sarah-ollama` → start Sarah → container is recreated from compose and boot completes
6. Fehlerpfad Boot-Screen: Meldung bleibt ~3 s sichtbar (dwell), bevor der Orb-Reveal startet

- [ ] **Step 7: Commit nothing — create the PR**

All code is committed in Tasks 1–5. Follow the finishing-a-development-branch skill: push `feat/ollama-docker`, open a PR targeting `dev`.

---

## Self-Review (done at plan time)

- **Spec coverage:** §5 → Task 2; §6 → Tasks 3–4; §7 → Task 5; §8 error paths → Tasks 3 (messages) + 5 (boot surfacing); §9 → Task 6; §11 tests → Tasks 3–4 (incl. ENOENT distinction and GPU retry case); housekeeping finding → Task 1. §10 (out of scope) intentionally has no tasks.
- **Placeholder scan:** all steps carry complete code/commands; no TBDs.
- **Type consistency:** `GpuStatus`/`ContainerStatus`/`ContainerManagerOptions` defined once in Task 3, consumed verbatim in Tasks 4–5; `containerManager` dep name identical in main.ts and boot-sequence.ts.
