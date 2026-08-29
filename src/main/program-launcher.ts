// src/main/program-launcher.ts
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'child_process';
import type { ProgramEntry } from '../core/config-schema.js';
import { abortableDelay, abortError, throwIfAborted } from '../core/abort-utils.js';
import { classifyProgramPath, verifyProgramPath } from './program-utils.js';

export type { ProgramEntry } from '../core/config-schema.js';

export interface LaunchResult {
  ok: boolean;
  speak?: string;
}

export type MatchResult =
  | { kind: 'hit'; program: ProgramEntry }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'miss'; suggestion?: string };

function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

/** Pure name matcher (Spec §5): exact name → exact alias → prefix → contains. */
export function matchProgram(query: string, programs: ProgramEntry[]): MatchResult {
  const q = normalize(query);
  if (!q) return { kind: 'miss' };

  const stages: ((p: ProgramEntry) => boolean)[] = [
    (p) => normalize(p.name) === q,
    (p) => p.aliases.some((a) => normalize(a) === q),
    (p) => normalize(p.name).startsWith(q) || p.aliases.some((a) => normalize(a).startsWith(q)),
    (p) => normalize(p.name).includes(q) || p.aliases.some((a) => normalize(a).includes(q)),
  ];

  for (const stage of stages) {
    const hits = programs.filter(stage);
    if (hits.length === 1) return { kind: 'hit', program: hits[0] };
    if (hits.length > 1) {
      // Same duplicateGroup or genuinely multiple candidates → honest question.
      return { kind: 'ambiguous', candidates: hits.map((p) => p.name) };
    }
  }

  const near = programs.find((p) => normalize(p.name).slice(0, 3) === q.slice(0, 3));
  return { kind: 'miss', suggestion: near?.name };
}

type SpawnFn = typeof nodeSpawn;
type ExecFileFn = (cmd: string, args: string[], cb: (err: Error | null) => void) => void;
/** Verifies a process is running by image name (e.g. "Spotify.exe"). */
type ProcessCheckFn = (imageName: string, signal?: AbortSignal) => Promise<boolean>;
type PathCheckFn = (programPath: string) => boolean;
type PathClassifier = typeof classifyProgramPath;

/**
 * Normalizes launcher-controlled display text and removes prompt/log control characters.
 *
 * @category Validation
 */
export function sanitizeLauncherText(value: string, maxLength = 100): string {
  return value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function displayProgramName(value: string): string {
  return sanitizeLauncherText(value, 80) || 'das Programm';
}

/**
 * Fallback map for well-known Store apps whose process name can't be derived
 * from the AUMID at scan time. Matched case-insensitively against the AUMID.
 * A `processName` on the ProgramEntry always wins over this.
 * TODO(scanner): populate ProgramEntry.processName during the program scan.
 */
const KNOWN_APPX_PROCESS: readonly { pattern: RegExp; processName: string }[] = [
  { pattern: /SpotifyMusic/i, processName: 'Spotify.exe' },
];

function knownAppxProcess(aumid: string): string | undefined {
  return KNOWN_APPX_PROCESS.find((e) => e.pattern.test(aumid))?.processName;
}

/** Default process check: tasklist filtered by image name (Windows). */
function defaultProcessCheck(imageName: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    nodeExecFile('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], { signal }, (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(String(stdout).toLowerCase().includes(imageName.toLowerCase()));
    });
  });
}

export class ProgramLauncher {
  constructor(
    private spawnFn: SpawnFn = nodeSpawn,
    private execFileFn: ExecFileFn = (cmd, args, cb) => {
      nodeExecFile(cmd, args, (err) => cb(err));
    },
    private verifyProcess: ProcessCheckFn = defaultProcessCheck,
    private appxVerifyDelayMs = 2500,
    private verifyPath: PathCheckFn = verifyProgramPath,
    private classifyPath: PathClassifier = classifyProgramPath,
  ) {}

  async launch(query: string, programs: ProgramEntry[], signal?: AbortSignal): Promise<LaunchResult> {
    throwIfAborted(signal);
    const safeQuery = sanitizeLauncherText(query);
    const match = matchProgram(safeQuery, programs);
    console.log(
      `[ProgramLauncher] query=${JSON.stringify(safeQuery)} programs=${programs.length} → ${match.kind}` +
        (match.kind === 'hit'
          ? ` (${displayProgramName(match.program.name)}, type=${match.program.type}, path=${JSON.stringify(match.program.path)})`
          : ''),
    );
    if (match.kind === 'ambiguous') {
      const candidates = match.candidates
        .slice(0, 5)
        .map(displayProgramName)
        .join(' und ');
      const suffix = match.candidates.length > 5 ? ' und weitere' : '';
      return { ok: false, speak: `Ich habe mehrere Treffer: ${candidates}${suffix}. Welches meinst du?` };
    }
    if (match.kind === 'miss') {
      const hint = match.suggestion ? ` Meintest du ${displayProgramName(match.suggestion)}?` : '';
      return { ok: false, speak: `Ich habe „${safeQuery || 'dieses Programm'}" nicht gefunden.${hint}` };
    }

    const program = match.program;
    const safeProgram = { ...program, name: displayProgramName(program.name) };
    const currentType = this.classifyPath(program.path);
    if (program.type === 'updater' || currentType === 'updater') {
      return { ok: false, speak: `Der Eintrag für ${safeProgram.name} zeigt auf einen Updater — ich starte den nicht.` };
    }
    if (currentType !== program.type) {
      return { ok: false, speak: `Der Eintrag für ${safeProgram.name} hat widersprüchliche Startdaten — ich starte den nicht.` };
    }
    if (currentType === 'appx') {
      if (!program.verified) {
        return { ok: false, speak: `Der Eintrag für ${safeProgram.name} ist nicht verifiziert — ich starte den nicht.` };
      }
      return this.launchAppx(safeProgram, signal);
    }
    if (!this.verifyPath(program.path)) {
      return { ok: false, speak: `${safeProgram.name} ist am gespeicherten Ort nicht mehr verfügbar.` };
    }
    return this.launchExe(safeProgram);
  }

  /**
   * Store apps: explorer.exe shell:AppsFolder\<AUMID>. explorer's exit code is
   * unreliable in BOTH directions (exit 0 for a stale AUMID = false positive;
   * non-zero while the shell service still launches the app = false negative,
   * which is the "Spotify läuft, meldet aber nicht installiert"-Bug). So we
   * ignore the exit code and verify via a process check when we know the image
   * name. Without a process identity we report that the delegated launch could
   * not be verified instead of claiming success without evidence.
   */
  private launchAppx(program: ProgramEntry, signal?: AbortSignal): Promise<LaunchResult> {
    const aumid = program.path.replace(/^appx:/, '');
    const processName = program.processName ?? knownAppxProcess(aumid);
    console.log(
      `[ProgramLauncher] launchAppx explorer.exe shell:AppsFolder\\${aumid}` +
        ` (verify=${processName ?? 'none'})`,
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      const finish = (result: LaunchResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => fail(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });

      this.execFileFn('explorer.exe', [`shell:AppsFolder\\${aumid}`], (err) => {
        if (settled) return;
        if (err) console.warn('[ProgramLauncher] launchAppx explorer exit non-zero (ignored):', aumid, err.message);

        if (!processName) {
          console.warn('[ProgramLauncher] launchAppx no processName → launch not verifiable');
          finish({
            ok: false,
            speak: `Ich habe ${program.name} zum Starten übergeben, konnte den Start aber nicht bestätigen.`,
          });
          return;
        }

        void (async () => {
          try {
            await abortableDelay(this.appxVerifyDelayMs, signal);
            const running = signal
              ? await this.verifyProcess(processName, signal)
              : await this.verifyProcess(processName);
            throwIfAborted(signal);
            console.log(`[ProgramLauncher] launchAppx verify ${processName} → running=${running}`);
            finish(
              running
                ? { ok: true }
                : { ok: false, speak: `${program.name} ließ sich nicht starten — vielleicht ist die App nicht mehr installiert.` },
            );
          } catch (error) {
            fail(error);
          }
        })();
      });
    });
  }

  private launchExe(program: ProgramEntry): Promise<LaunchResult> {
    return new Promise((resolve) => {
      const child = this.spawnFn(program.path, [], { detached: true, stdio: 'ignore' });
      let settled = false;
      child.once('error', (err: Error) => {
        if (settled) return;
        settled = true;
        console.warn('[ProgramLauncher] spawn error:', program.path, err);
        resolve({ ok: false, speak: `${program.name} ließ sich nicht starten.` });
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve({ ok: true });
      });
    });
  }
}
