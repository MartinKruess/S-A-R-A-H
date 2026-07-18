import { describe, it, expect, vi } from 'vitest';
import { matchProgram, ProgramLauncher, type ProgramEntry } from '../../src/main/program-launcher.js';
import { EventEmitter } from 'events';

function prog(over: Partial<ProgramEntry> & { name: string; path: string }): ProgramEntry {
  return { type: 'exe', verified: true, aliases: [], source: 'detected', ...over };
}

const PROGRAMS: ProgramEntry[] = [
  prog({ name: 'Spotify', path: 'appx:SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', type: 'appx', aliases: ['Spotify'] }),
  prog({ name: 'Visual Studio Code', path: 'C:\\vscode\\Code.exe', aliases: ['VS Code', 'Code', 'VSCode'] }),
  prog({ name: 'OpenOffice Writer', path: 'C:\\oo\\writer.exe', aliases: ['OpenOffice'], duplicateGroup: 'openoffice' }),
  prog({ name: 'OpenOffice Calc', path: 'C:\\oo\\calc.exe', aliases: ['OpenOffice'], duplicateGroup: 'openoffice' }),
  prog({ name: 'Discord', path: 'C:\\discord\\Update.exe', type: 'updater', aliases: ['Discord'] }),
  prog({ name: 'Epic Games Launcher', path: 'C:\\epic\\Launcher.exe', type: 'launcher', aliases: ['Epic'] }),
];

describe('matchProgram', () => {
  it('exact name and exact alias beat fuzzy', () => {
    expect(matchProgram('spotify', PROGRAMS)).toEqual({ kind: 'hit', program: PROGRAMS[0] });
    expect(matchProgram('vs code', PROGRAMS)).toEqual({ kind: 'hit', program: PROGRAMS[1] });
  });

  it('normalizes umlauts and case', () => {
    const p = [prog({ name: 'Übersetzer', path: 'C:\\x.exe' })];
    expect(matchProgram('uebersetzer', p)).toEqual({ kind: 'hit', program: p[0] });
  });

  it('prefix match works when unique', () => {
    expect(matchProgram('visual', PROGRAMS)).toEqual({ kind: 'hit', program: PROGRAMS[1] });
  });

  it('duplicateGroup tie → ambiguous with candidate names, never a silent pick', () => {
    const result = matchProgram('openoffice', PROGRAMS);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toEqual(['OpenOffice Writer', 'OpenOffice Calc']);
    }
  });

  it('miss returns a near suggestion when available', () => {
    const result = matchProgram('spotifi', PROGRAMS);
    expect(result.kind).toBe('miss');
  });
});

describe('ProgramLauncher.launch', () => {
  function fakeChild(): EventEmitter & { unref: () => void } {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    return child;
  }

  it('spawns an exe detached and reports silent success', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const launcher = new ProgramLauncher(spawnFn, vi.fn());
    const resultP = launcher.launch('vs code', PROGRAMS);
    setTimeout(() => child.emit('spawn'), 5);
    const result = await resultP;
    expect(spawnFn).toHaveBeenCalledWith('C:\\vscode\\Code.exe', [], { detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('reports spawn errors honestly (EACCES/ENOENT)', async () => {
    const child = fakeChild();
    const launcher = new ProgramLauncher(vi.fn().mockReturnValue(child), vi.fn());
    const resultP = launcher.launch('vs code', PROGRAMS);
    setTimeout(() => child.emit('error', new Error('ENOENT')), 5);
    const result = await resultP;
    expect(result.ok).toBe(false);
    expect(result.speak).toContain('Visual Studio Code');
  });

  it('hard-rejects updater entries with an honest speak (§5b)', async () => {
    const spawnFn = vi.fn();
    const launcher = new ProgramLauncher(spawnFn, vi.fn());
    const result = await launcher.launch('discord', PROGRAMS);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.speak).toBe('Der Eintrag für Discord zeigt auf einen Updater — ich starte den nicht.');
  });

  it('launches appx via explorer.exe shell:AppsFolder and announces launchers neutrally', async () => {
    const execFileFn = vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null));
    const verify = vi.fn().mockResolvedValue(true);
    const launcher = new ProgramLauncher(vi.fn(), execFileFn, verify, 0);
    const result = await launcher.launch('spotify', PROGRAMS);
    expect(execFileFn).toHaveBeenCalledWith(
      'explorer.exe',
      ['shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'],
      expect.any(Function),
    );
    expect(verify).toHaveBeenCalledWith('Spotify.exe');
    expect(result).toEqual({ ok: true });

    const child = fakeChild();
    const launcher2 = new ProgramLauncher(vi.fn().mockReturnValue(child), vi.fn());
    const resultP = launcher2.launch('epic', PROGRAMS);
    setTimeout(() => child.emit('spawn'), 5);
    expect((await resultP).speak).toBe('Ich starte den Launcher von Epic Games Launcher.');
  });

  it('appx: ignores a non-zero explorer exit when the process is actually running (the false-negative bug)', async () => {
    const execFileFn = vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) =>
      cb(new Error('explorer exit 1')),
    );
    const verify = vi.fn().mockResolvedValue(true);
    const launcher = new ProgramLauncher(vi.fn(), execFileFn, verify, 0);
    const result = await launcher.launch('spotify', PROGRAMS);
    expect(verify).toHaveBeenCalledWith('Spotify.exe');
    expect(result).toEqual({ ok: true });
  });

  it('appx: reports honest failure only when the process is verifiably not running', async () => {
    const execFileFn = vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null));
    const verify = vi.fn().mockResolvedValue(false);
    const launcher = new ProgramLauncher(vi.fn(), execFileFn, verify, 0);
    const result = await launcher.launch('spotify', PROGRAMS);
    expect(result.ok).toBe(false);
    expect(result.speak).toContain('Spotify');
  });

  it('appx without a known process name stays optimistic instead of a false failure', async () => {
    const programs = [prog({ name: 'LinkedIn', path: 'appx:7EE7776C.LinkedInforWindows_w1wdnht996qgy!App', type: 'appx' })];
    const execFileFn = vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) =>
      cb(new Error('explorer exit 1')),
    );
    const verify = vi.fn().mockResolvedValue(false);
    const launcher = new ProgramLauncher(vi.fn(), execFileFn, verify, 0);
    const result = await launcher.launch('linkedin', programs);
    expect(verify).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('ambiguous → question, miss → suggestion speak', async () => {
    const launcher = new ProgramLauncher(vi.fn(), vi.fn());
    const amb = await launcher.launch('openoffice', PROGRAMS);
    expect(amb.ok).toBe(false);
    expect(amb.speak).toContain('OpenOffice Writer');
    expect(amb.speak).toContain('OpenOffice Calc');

    const miss = await launcher.launch('fantasieprogramm', PROGRAMS);
    expect(miss.ok).toBe(false);
    expect(miss.speak).toContain('nicht gefunden');
  });
});
