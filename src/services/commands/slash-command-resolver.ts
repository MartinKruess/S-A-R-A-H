import type { CustomCommand } from '../../core/config-schema.js';
import { BUILTIN_COMMANDS } from './builtin-commands.js';

const AVAILABLE_BUILTIN_COMMANDS: ReadonlySet<string> = new Set(
  BUILTIN_COMMANDS.filter((entry) => entry.available).map((entry) => entry.command),
);
const UNAVAILABLE_BUILTIN_COMMANDS: ReadonlySet<string> = new Set(
  BUILTIN_COMMANDS.filter((entry) => !entry.available).map((entry) => entry.command),
);
const COMMAND_PATTERN = /^(\/[a-z0-9_-]+)(?:\s+([\s\S]*))?$/i;
const MAX_PROMPT_LENGTH = 2_000;
const MAX_ARGUMENT_LENGTH = 500;
const MAX_BUILTIN_ARGUMENT_LENGTH = 4_000;

export type SlashCommandResolution =
  | { kind: 'none' }
  | { kind: 'custom'; command: string; arguments: string; expandedText: string }
  | { kind: 'builtin'; command: '/anonymous' | '/incognito' | '/confirm' | '/showcontext' | '/remember' | '/correctmemory' | '/forget' | '/deletememory' | '/exportmemory'; arguments: string }
  | { kind: 'builtin_unavailable'; command: string; arguments: string }
  | { kind: 'unknown'; command: string; arguments: string };

/**
 * @param text - Unveränderte Nutzereingabe.
 * @param customCommands - In den Einstellungen hinterlegte Prompt-Makros.
 *
 * - Erkennt Slash-Commands deterministisch vor dem Routing-Modell.
 * - Expandiert benutzerdefinierte Commands genau einmal in ihren Prompt.
 * - Führt niemals Shell-Code oder Toolaufrufe direkt aus.
 *
 * @returns Auflösung für den weiteren kontrollierten Verarbeitungspfad.
 *
 * @category Business Logic Validation
 */
export function resolveSlashCommand(
  text: string,
  customCommands: readonly CustomCommand[],
): SlashCommandResolution {
  const trimmed = text.normalize('NFC').trim();
  if (!trimmed.startsWith('/')) return { kind: 'none' };

  const match = trimmed.match(COMMAND_PATTERN);
  if (!match) {
    return {
      kind: 'unknown',
      command: trimmed.split(/\s/, 1)[0].slice(0, 100),
      arguments: '',
    };
  }

  const command = match[1].toLowerCase();
  const rawArgs = (match[2] ?? '').trim();
  const args = rawArgs.slice(
    0,
    AVAILABLE_BUILTIN_COMMANDS.has(command)
      ? MAX_BUILTIN_ARGUMENT_LENGTH
      : MAX_ARGUMENT_LENGTH,
  );
  if (AVAILABLE_BUILTIN_COMMANDS.has(command)) {
    return {
      kind: 'builtin',
      command: command as '/anonymous' | '/incognito' | '/confirm' | '/showcontext' | '/remember' | '/correctmemory' | '/forget' | '/deletememory' | '/exportmemory',
      arguments: args,
    };
  }
  if (UNAVAILABLE_BUILTIN_COMMANDS.has(command)) {
    return { kind: 'builtin_unavailable', command, arguments: args };
  }

  const configured = customCommands.find((entry) => entry.command.trim().toLowerCase() === command);
  if (!configured) return { kind: 'unknown', command, arguments: args };

  const prompt = configured.prompt.trim().slice(0, MAX_PROMPT_LENGTH);
  if (!prompt) return { kind: 'unknown', command, arguments: args };

  return {
    kind: 'custom',
    command,
    arguments: args,
    expandedText: args ? `${prompt}\nZusätzliche Argumente des Nutzers: ${args}` : prompt,
  };
}
