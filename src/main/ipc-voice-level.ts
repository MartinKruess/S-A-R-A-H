import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import type { VoiceLevel } from '../core/ipc-contract.js';

export interface VoiceLevelDeps {
  getMainWindow: () => BrowserWindow | null;
  dialogWindows: Map<string, BrowserWindow>;
}

const BAR_COUNT = 16;
const MIN_EMIT_INTERVAL_MS = 33;

const VoiceLevelSchema = z.object({
  rms: z.number().min(0).max(1),
  bars: z.array(z.number().min(0).max(1)).length(BAR_COUNT),
  ts: z.number(),
});

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  return Math.max(0, Math.min(1, rms));
}

export function updateBars(bars: number[], newValue: number): number[] {
  const clamped = Math.max(0, Math.min(1, newValue));
  const next = bars.length >= BAR_COUNT ? bars.slice(bars.length - BAR_COUNT + 1) : bars.slice();
  next.push(clamped);
  while (next.length < BAR_COUNT) {
    next.unshift(0);
  }
  return next;
}

export function registerVoiceLevelForwarder(deps: VoiceLevelDeps): {
  onChunk: (chunk: Float32Array) => void;
  stop: () => void;
} {
  const { getMainWindow, dialogWindows } = deps;

  let bars: number[] = new Array<number>(BAR_COUNT).fill(0);
  let lastRms = 0;
  let lastEmit = 0;
  let pendingTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const broadcast = (): void => {
    if (stopped) return;
    const candidate: VoiceLevel = {
      rms: lastRms,
      bars: bars.slice(),
      ts: Date.now(),
    };
    const parsed = VoiceLevelSchema.safeParse(candidate);
    if (!parsed.success) {
      console.warn('[VoiceLevel] skipping invalid payload:', parsed.error.issues);
      return;
    }
    lastEmit = candidate.ts;

    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('voice:level', parsed.data);
    }
    for (const win of dialogWindows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send('voice:level', parsed.data);
      }
    }
  };

  const onChunk = (chunk: Float32Array): void => {
    if (stopped) return;
    const rms = computeRms(chunk);
    lastRms = rms;
    bars = updateBars(bars, rms);

    const now = Date.now();
    const elapsed = now - lastEmit;
    if (elapsed >= MIN_EMIT_INTERVAL_MS) {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      broadcast();
      return;
    }
    if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        broadcast();
      }, MIN_EMIT_INTERVAL_MS - elapsed);
    }
  };

  const stop = (): void => {
    stopped = true;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  return { onChunk, stop };
}
