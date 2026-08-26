import { describe, expect, it } from 'vitest';
import { resolveSlashCommand } from './slash-command-resolver.js';
import { BUILTIN_COMMANDS, RESERVED_BUILTIN_COMMANDS } from './builtin-commands.js';

const commands = [
  { command: '/spotify', prompt: 'Öffne Spotify' },
  { command: '/projekt', prompt: 'Fasse den Projektstatus zusammen.' },
];

describe('resolveSlashCommand', () => {
  it('keeps /confirm visible and reserved in the shared settings command list', () => {
    expect(BUILTIN_COMMANDS.some((entry) => entry.command === '/confirm' && entry.available)).toBe(true);
    expect(RESERVED_BUILTIN_COMMANDS.has('/confirm')).toBe(true);
  });
  it('leaves ordinary messages untouched', () => {
    expect(resolveSlashCommand('Öffne Spotify', commands)).toEqual({ kind: 'none' });
  });

  it('expands custom commands case-insensitively exactly once', () => {
    expect(resolveSlashCommand(' /SpOtIfY ', commands)).toEqual({
      kind: 'custom',
      command: '/spotify',
      arguments: '',
      expandedText: 'Öffne Spotify',
    });
  });

  it('preserves bounded arguments as user data for the expanded prompt', () => {
    expect(resolveSlashCommand('/projekt Phase 1', commands)).toEqual({
      kind: 'custom',
      command: '/projekt',
      arguments: 'Phase 1',
      expandedText: 'Fasse den Projektstatus zusammen.\nZusätzliche Argumente des Nutzers: Phase 1',
    });
  });

  it.each(['/showcontext', '/quietmode'])(
    'gives built-ins precedence and does not fake unfinished behavior: %s',
    (command) => {
      expect(resolveSlashCommand(command, [{ command, prompt: 'Ignorieren' }])).toEqual({
        kind: 'builtin_unavailable',
        command,
        arguments: '',
      });
    },
  );

  it.each(['/anonymous geheim', '/confirm 1234'])(
    'resolves implemented privacy/confirmation commands before custom macros: %s',
    (input) => {
      const command = input.split(' ')[0] as '/anonymous' | '/confirm';
      expect(resolveSlashCommand(input, [{ command, prompt: 'Ignorieren' }])).toEqual({
        kind: 'builtin',
        command,
        arguments: input.slice(command.length).trim(),
      });
    },
  );

  it('rejects unknown commands without sending them to an LLM', () => {
    expect(resolveSlashCommand('/gibt-es-nicht', commands)).toEqual({
      kind: 'unknown',
      command: '/gibt-es-nicht',
      arguments: '',
    });
  });
});
