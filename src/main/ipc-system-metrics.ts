import * as os from 'os';
import { z } from 'zod';
import type { BrowserWindow, IpcMain } from 'electron';
import type { SystemMetrics } from '../core/ipc-contract.js';

export interface CpuSnapshot {
  idle: number;
  total: number;
}

export interface SystemMetricsDeps {
  getMainWindow: () => BrowserWindow | null;
  dialogWindows: Map<string, BrowserWindow>;
}

export interface GpuDecision {
  value: number | null;
  nextConsecutiveZeros: number;
  nextDisabled: boolean;
}

const SystemMetricsSchema = z.object({
  cpu: z.number().min(0).max(1),
  ram: z.number().min(0).max(1),
  gpu: z.number().min(0).max(1).nullable(),
  ts: z.number(),
});

const PUSH_INTERVAL_MS = 1000;
const GPU_DISABLE_THRESHOLD = 5;

export function snapshotCpus(): CpuSnapshot[] {
  return os.cpus().map((cpu) => {
    const t = cpu.times;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle: t.idle, total };
  });
}

/**
 * Pure CPU-load computation so it can be unit-tested.
 * Averages the per-core busy fraction: 1 - (idleDelta / totalDelta).
 * Returns 0 when snapshots have no measurable elapsed time (defensive).
 */
export function computeCpuLoad(prev: CpuSnapshot[], curr: CpuSnapshot[]): number {
  if (prev.length === 0 || curr.length === 0) return 0;
  const n = Math.min(prev.length, curr.length);
  let sum = 0;
  let counted = 0;
  for (let i = 0; i < n; i++) {
    const idleDelta = curr[i].idle - prev[i].idle;
    const totalDelta = curr[i].total - prev[i].total;
    if (totalDelta <= 0) continue;
    const busy = 1 - idleDelta / totalDelta;
    sum += Math.max(0, Math.min(1, busy));
    counted++;
  }
  if (counted === 0) return 0;
  return sum / counted;
}

function computeRamLoad(): number {
  const total = os.totalmem();
  if (total <= 0) return 0;
  return (total - os.freemem()) / total;
}

/**
 * GPU-null-sticky heuristic: many integrated GPUs (notably Intel) report 0
 * utilization even under load. After 5 consecutive undefined/0 ticks we
 * permanently disable GPU reads for the rest of the session.
 */
export function decideGpuValue(
  consecutiveZeros: number,
  raw: number | undefined,
  disabled: boolean,
): GpuDecision {
  if (disabled) {
    return { value: null, nextConsecutiveZeros: consecutiveZeros, nextDisabled: true };
  }
  if (raw === undefined || raw === 0) {
    const next = consecutiveZeros + 1;
    if (next >= GPU_DISABLE_THRESHOLD) {
      return { value: null, nextConsecutiveZeros: next, nextDisabled: true };
    }
    return { value: null, nextConsecutiveZeros: next, nextDisabled: false };
  }
  const clamped = Math.max(0, Math.min(1, raw / 100));
  return { value: clamped, nextConsecutiveZeros: 0, nextDisabled: false };
}

type SiGraphicsFn = () => Promise<{
  controllers: Array<{
    utilizationGpu?: number;
    memoryUsed?: number;
    memoryTotal?: number;
  }>;
}>;

async function loadGraphics(): Promise<SiGraphicsFn> {
  const si = await import('systeminformation');
  return si.graphics as SiGraphicsFn;
}

export function registerSystemMetricsHandlers(
  ipcMain: IpcMain,
  deps: SystemMetricsDeps,
): () => void {
  const { getMainWindow, dialogWindows } = deps;

  let prevSnapshot: CpuSnapshot[] = snapshotCpus();
  let latest: SystemMetrics = {
    cpu: 0,
    ram: computeRamLoad(),
    gpu: null,
    ts: Date.now(),
  };

  let graphicsFn: SiGraphicsFn | null = null;
  let graphicsInFlight = false;
  let gpuConsecutiveZeros = 0;
  let gpuDisabled = false;
  let latestGpu: number | null = null;

  ipcMain.handle('get-system-metrics', () => latest);

  const readGpu = (): void => {
    if (gpuDisabled || graphicsInFlight) return;
    graphicsInFlight = true;
    const run = async (): Promise<void> => {
      try {
        if (!graphicsFn) graphicsFn = await loadGraphics();
        const result = await graphicsFn();
        const ctrl = result.controllers[0];
        let raw: number | undefined;
        if (ctrl) {
          if (typeof ctrl.utilizationGpu === 'number') {
            raw = ctrl.utilizationGpu;
          } else if (
            typeof ctrl.memoryUsed === 'number' &&
            typeof ctrl.memoryTotal === 'number' &&
            ctrl.memoryTotal > 0
          ) {
            raw = (ctrl.memoryUsed / ctrl.memoryTotal) * 100;
          }
        }
        const decision = decideGpuValue(gpuConsecutiveZeros, raw, gpuDisabled);
        latestGpu = decision.value;
        gpuConsecutiveZeros = decision.nextConsecutiveZeros;
        gpuDisabled = decision.nextDisabled;
      } catch {
        const decision = decideGpuValue(gpuConsecutiveZeros, undefined, gpuDisabled);
        latestGpu = decision.value;
        gpuConsecutiveZeros = decision.nextConsecutiveZeros;
        gpuDisabled = decision.nextDisabled;
      } finally {
        graphicsInFlight = false;
      }
    };
    void run();
  };

  const tick = (): void => {
    const curr = snapshotCpus();
    const cpu = computeCpuLoad(prevSnapshot, curr);
    prevSnapshot = curr;

    readGpu();

    const candidate: SystemMetrics = {
      cpu,
      ram: computeRamLoad(),
      gpu: latestGpu,
      ts: Date.now(),
    };

    const parsed = SystemMetricsSchema.safeParse(candidate);
    if (!parsed.success) {
      console.warn('[SystemMetrics] skipping invalid tick:', parsed.error.issues);
      return;
    }

    latest = parsed.data;

    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('system:metrics', latest);
    }
    for (const win of dialogWindows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send('system:metrics', latest);
      }
    }
  };

  const interval = setInterval(tick, PUSH_INTERVAL_MS);

  return () => {
    clearInterval(interval);
  };
}
