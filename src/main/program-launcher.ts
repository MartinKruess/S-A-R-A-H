// src/main/program-launcher.ts
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'child_process';
import type { ProgramEntry } from '../core/config-schema.js';

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

export class ProgramLauncher {
  constructor(
    private spawnFn: SpawnFn = nodeSpawn,
    private execFileFn: ExecFileFn = (cmd, args, cb) => {
      nodeExecFile(cmd, args, (err) => cb(err));
    },
  ) {}

  async launch(query: string, programs: ProgramEntry[]): Promise<LaunchResult> {
    const match = matchProgram(query, programs);
    console.log(
      `[ProgramLauncher] query=${JSON.stringify(query)} programs=${programs.length} → ${match.kind}` +
        (match.kind === 'hit' ? ` (${match.program.name}, type=${match.program.type}, path=${match.program.path})` : ''),
    );
    if (match.kind === 'ambiguous') {
      return { ok: false, speak: `Ich habe mehrere Treffer: ${match.candidates.join(' und ')}. Welches meinst du?` };
    }
    if (match.kind === 'miss') {
      const hint = match.suggestion ? ` Meintest du ${match.suggestion}?` : '';
      return { ok: false, speak: `Ich habe „${query}" nicht gefunden.${hint}` };
    }

    const program = match.program;
    if (program.type === 'updater') {
      return { ok: false, speak: `Der Eintrag für ${program.name} zeigt auf einen Updater — ich starte den nicht.` };
    }
    if (program.type === 'appx') {
      return this.launchAppx(program);
    }
    return this.launchExe(program);
  }

  /** Store apps: verified spike (17.07.) — explorer.exe shell:AppsFolder\<AUMID>. */
  private launchAppx(program: ProgramEntry): Promise<LaunchResult> {
    const aumid = program.path.replace(/^appx:/, '');
    console.log(`[ProgramLauncher] launchAppx explorer.exe shell:AppsFolder\\${aumid}`);
    return new Promise((resolve) => {
      this.execFileFn('explorer.exe', [`shell:AppsFolder\\${aumid}`], (err) => {
        // NOTE: explorer.exe returns exit 0 even for a stale/missing AUMID, so
        // this "ok" only means "explorer accepted the request", not "app is up".
        if (err) {
          console.warn('[ProgramLauncher] launchAppx failed:', aumid, err.message);
          resolve({ ok: false, speak: `${program.name} ließ sich nicht starten — vielleicht ist die App nicht mehr installiert.` });
        } else {
          console.log('[ProgramLauncher] launchAppx explorer accepted (exit 0 — no proof the app is up)');
          resolve({ ok: true });
        }
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
        resolve(
          program.type === 'launcher'
            ? { ok: true, speak: `Ich starte den Launcher von ${program.name}.` }
            : { ok: true },
        );
      });
    });
  }
}
