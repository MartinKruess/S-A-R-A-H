// src/services/actions/system-actions.ts
import { execFile as nodeExecFile } from 'child_process';
import type { LaunchResult } from '../../main/program-launcher.js';
import { throwIfAborted } from '../../core/abort-utils.js';

const UNSUPPORTED: LaunchResult = { ok: false, speak: 'Das unterstützt dein System nicht.' };
const MAX_TIMERS = 5;

type ExecFn = (
  cmd: string,
  args: string[],
  cb: (err: Error | null) => void,
  signal?: AbortSignal,
) => void;

/** Fixed CoreAudio script (verified spike 17.07.) — only the scalar value is inlined. */
const VOLUME_SCRIPT_PREFIX = `Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int f(); int g(); int h(); int i(); int SetMasterVolumeLevelScalar(float fLevel, System.Guid ctx); int j(); int GetMasterVolumeLevelScalar(out float pfLevel); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class Audio {
  static IAudioEndpointVolume Vol() {
    var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice d = null; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d));
    IAudioEndpointVolume v = null; var g = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(d.Activate(ref g, 23, 0, out v)); return v;
  }
  public static void SetVolume(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, System.Guid.Empty)); }
}
'@
[Audio]::SetVolume(`;

interface TimerEntry {
  id: number;
  minutes: number;
  startMs: number;
  handle: ReturnType<typeof setTimeout>;
  detachAbort: () => void;
}

export class SystemActions {
  private execFn: ExecFn;
  private platform: string;
  private onNotify: (speak: string) => void;
  private timers = new Map<number, TimerEntry>();
  private nextTimerId = 1;

  constructor(opts: { execFn?: ExecFn; onNotify?: (speak: string) => void; platform?: string } = {}) {
    this.execFn = opts.execFn ?? ((cmd, args, cb, signal) => {
      nodeExecFile(cmd, args, { signal }, (err, _stdout, stderr) => {
        if (err && stderr) console.warn('[SystemActions] exec stderr:', String(stderr).trim().slice(0, 300));
        cb(err);
      });
    });
    this.onNotify = opts.onNotify ?? (() => {});
    this.platform = opts.platform ?? process.platform;
  }

  setNotifyHandler(fn: (speak: string) => void): void {
    this.onNotify = fn;
  }

  async setVolume(percent: number, signal?: AbortSignal): Promise<LaunchResult> {
    if (this.platform !== 'win32') return UNSUPPORTED;
    const scalar = String(Math.round(percent) / 100);
    const script = `${VOLUME_SCRIPT_PREFIX}${scalar})`;
    return new Promise((resolve) => {
      const args = ['-NoProfile', '-NonInteractive', '-Command', script];
      const done = (err: Error | null): void => {
        if (err) console.warn('[SystemActions] setVolume failed:', `${percent}%`, err.message);
        else console.log('[SystemActions] setVolume ok:', `${percent}% (scalar ${scalar}) — system master volume set`);
        resolve(err ? { ok: false, speak: 'Die Lautstärke ließ sich nicht ändern.' } : { ok: true });
      };
      if (signal) this.execFn('powershell.exe', args, done, signal);
      else this.execFn('powershell.exe', args, done);
    });
  }

  async lockScreen(signal?: AbortSignal): Promise<LaunchResult> {
    if (this.platform !== 'win32') return UNSUPPORTED;
    return new Promise((resolve) => {
      const done = (err: Error | null): void => {
        resolve(err ? { ok: false, speak: 'Das Sperren hat nicht geklappt.' } : { ok: true });
      };
      if (signal) this.execFn('rundll32.exe', ['user32.dll,LockWorkStation'], done, signal);
      else this.execFn('rundll32.exe', ['user32.dll,LockWorkStation'], done);
    });
  }

  /** Wall-clock based timer (R4-Mi2): re-arms after standby instead of firing early. */
  setTimer(minutes: number, signal?: AbortSignal): LaunchResult {
    if (this.platform !== 'win32') return UNSUPPORTED;
    throwIfAborted(signal);
    if (this.timers.size >= MAX_TIMERS) {
      return { ok: false, speak: 'Ich habe schon 5 Timer laufen.' };
    }
    const id = this.nextTimerId++;
    const durationMs = minutes * 60 * 1000;
    const startMs = Date.now();
    let cancel = (): void => {};
    const detachAbort = (): void => signal?.removeEventListener('abort', cancel);
    cancel = (): void => {
      const entry = this.timers.get(id);
      if (!entry) return;
      clearTimeout(entry.handle);
      this.timers.delete(id);
      detachAbort();
    };
    const arm = (delayMs: number): void => {
      const handle = setTimeout(() => {
        const elapsed = Date.now() - startMs;
        if (elapsed < durationMs) {
          arm(durationMs - elapsed); // clock says we are early (standby throttling) — re-arm
          return;
        }
        this.timers.delete(id);
        detachAbort();
        this.onNotify(`Dein ${minutes}-Minuten-Timer ist abgelaufen.`);
      }, delayMs);
      this.timers.set(id, { id, minutes, startMs, handle, detachAbort });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    arm(durationMs);
    return { ok: true };
  }

  clearAllTimers(): void {
    for (const entry of this.timers.values()) {
      clearTimeout(entry.handle);
      entry.detachAbort();
    }
    this.timers.clear();
  }
}
