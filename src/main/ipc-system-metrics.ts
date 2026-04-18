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

const SystemMetricsSchema = z.object({
  cpu: z.number().min(0).max(1),
  ram: z.number().min(0).max(1),
  gpu: z.number().min(0).max(1).nullable(),
  ts: z.number(),
});

const PUSH_INTERVAL_MS = 1000;

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

export function registerSystemMetricsHandlers(
  ipcMain: IpcMain,
  deps: SystemMetricsDeps,
): () => void {
  const { getMainWindow, dialogWindows } = deps;

  let prevSnapshot: CpuSnapshot[] = snapshotCpus();
  let latest: SystemMetrics = {
    cpu: 0,
    ram: computeRamLoad(),
    // TODO Phase 6: real GPU load via `systeminformation`. v1 stays null.
    gpu: null,
    ts: Date.now(),
  };

  ipcMain.handle('get-system-metrics', () => latest);

  const tick = () => {
    const curr = snapshotCpus();
    const cpu = computeCpuLoad(prevSnapshot, curr);
    prevSnapshot = curr;

    const candidate: SystemMetrics = {
      cpu,
      ram: computeRamLoad(),
      gpu: null,
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
