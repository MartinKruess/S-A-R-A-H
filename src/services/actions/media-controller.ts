// src/services/actions/media-controller.ts
// Schicht 1 (generic media transport). Platform-neutral MediaController contract;
// WindowsMediaController drives GSMTC via a small self-contained C# helper spoken to
// over JSON stdin/stdout. `run` is injectable for tests.
import { spawn } from 'child_process';

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
  play(target: string): Promise<MediaResult>;
  pause(target: string): Promise<MediaResult>;
  toggle(target: string): Promise<MediaResult>;
  next(target: string): Promise<MediaResult>;
  previous(target: string): Promise<MediaResult>;
}

/** Runs the helper: writes requestJson to stdin, resolves with the stdout JSON line. */
export type HelperRunner = (requestJson: string) => Promise<string>;

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
    this.run = opts.run ?? ((json) => this.defaultRun(json));
  }

  play(target: string): Promise<MediaResult> { return this.send('media_play', target); }
  pause(target: string): Promise<MediaResult> { return this.send('media_pause', target); }
  toggle(target: string): Promise<MediaResult> { return this.send('media_toggle', target); }
  next(target: string): Promise<MediaResult> { return this.send('media_next', target); }
  previous(target: string): Promise<MediaResult> { return this.send('media_previous', target); }

  private async send(action: MediaAction, target: string): Promise<MediaResult> {
    if (this.platform !== 'win32') return UNSUPPORTED;
    let stdout: string;
    try {
      stdout = await this.run(JSON.stringify({ action, target }));
    } catch (err) {
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
  private defaultRun(requestJson: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.helperPath, [], { windowsHide: true });
      let out = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('media-helper timeout'));
      }, HELPER_TIMEOUT_MS);

      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(out.trim());
      });

      child.stdin?.write(`${requestJson}\n`);
      child.stdin?.end();
    });
  }
}
