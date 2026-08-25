// src/services/actions/media-controller.ts
// Layer 1 (generic media transport). Platform-neutral MediaController contract;
// WindowsMediaController drives GSMTC via a small self-contained C# helper spoken to
// over JSON stdin/stdout. `run` is injectable for tests.
import { spawn } from 'child_process';
import { abortError, throwIfAborted } from '../../core/abort-utils.js';

export interface MediaResult {
  ok: boolean;
  speak?: string;
}

export type MediaAction =
  | 'media_play'
  | 'media_pause'
  | 'media_toggle'
  | 'media_next'
  | 'media_previous';

export interface MediaController {
  play(target: string, signal?: AbortSignal): Promise<MediaResult>;
  pause(target: string, signal?: AbortSignal): Promise<MediaResult>;
  toggle(target: string, signal?: AbortSignal): Promise<MediaResult>;
  next(target: string, signal?: AbortSignal): Promise<MediaResult>;
  previous(target: string, signal?: AbortSignal): Promise<MediaResult>;
}

/** Runs the helper: writes requestJson to stdin, resolves with the stdout JSON line. */
export type HelperRunner = (requestJson: string, signal?: AbortSignal) => Promise<string>;

const UNSUPPORTED: MediaResult = { ok: false, speak: 'Das unterstützt dein System nicht.' };
const GENERIC: MediaResult = { ok: false, speak: 'Das hat gerade nicht geklappt.' };
const HELPER_TIMEOUT_MS = 4000;

interface HelperResponse {
  success?: boolean;
  error?: string;
}

export class WindowsMediaController implements MediaController {
  private run: HelperRunner;
  private platform: string;

  constructor(
    private helperPath: string,
    opts: { run?: HelperRunner; platform?: string } = {},
  ) {
    this.platform = opts.platform ?? process.platform;
    this.run = opts.run ?? ((json, signal) => this.defaultRun(json, signal));
  }

  play(target: string, signal?: AbortSignal): Promise<MediaResult> { return this.send('media_play', target, signal); }
  pause(target: string, signal?: AbortSignal): Promise<MediaResult> { return this.send('media_pause', target, signal); }
  toggle(target: string, signal?: AbortSignal): Promise<MediaResult> { return this.send('media_toggle', target, signal); }
  next(target: string, signal?: AbortSignal): Promise<MediaResult> { return this.send('media_next', target, signal); }
  previous(target: string, signal?: AbortSignal): Promise<MediaResult> { return this.send('media_previous', target, signal); }

  private async send(action: MediaAction, target: string, signal?: AbortSignal): Promise<MediaResult> {
    throwIfAborted(signal);
    if (this.platform !== 'win32') return UNSUPPORTED;
    let stdout: string;
    try {
      stdout = signal
        ? await this.run(JSON.stringify({ action, target }), signal)
        : await this.run(JSON.stringify({ action, target }));
    } catch (err) {
      if (signal?.aborted) throw abortError();
      console.warn('[MediaController] helper exec failed:', action, (err as Error).message);
      return GENERIC;
    }
    return this.mapResponse(stdout);
  }

  private mapResponse(stdout: string): MediaResult {
    let res: HelperResponse;
    try {
      res = JSON.parse(stdout) as HelperResponse;
    } catch {
      console.warn('[MediaController] bad helper output:', stdout.slice(0, 200));
      return GENERIC;
    }
    if (res.success === true) return { ok: true };
    switch (res.error) {
      case 'NO_MEDIA_SESSION': return { ok: false, speak: 'Ich sehe gerade keine laufende Wiedergabe.' };
      case 'NO_MATCHING_SESSION': return { ok: false, speak: 'Ich finde gerade keine passende Wiedergabe.' };
      case 'ACTION_NOT_SUPPORTED': return { ok: false, speak: 'Das kann der aktuelle Player nicht.' };
      default: return GENERIC;
    }
  }

  /** Spawns the helper, feeds requestJson on stdin, resolves stdout; kills on timeout. */
  private defaultRun(requestJson: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.helperPath, [], { windowsHide: true });
      let out = '';
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill();
        reject(new Error('media-helper timeout'));
      }, HELPER_TIMEOUT_MS);
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      });
      child.on('close', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(out.trim());
      });

      // A helper that dies on launch makes stdin.write emit 'error' (EPIPE);
      // without a listener that becomes an uncaught exception. Swallow it —
      // the close/timeout handlers already settle the promise.
      child.stdin?.on('error', () => {});

      child.stdin?.write(`${requestJson}\n`);
      child.stdin?.end();
    });
  }
}
