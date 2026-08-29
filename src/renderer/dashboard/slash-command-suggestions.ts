import type { CustomCommand } from '../../core/config-schema.js';
import {
  BUILTIN_COMMANDS,
  removeReservedCustomCommandCollisions,
} from '../../services/commands/builtin-commands.js';

export interface SlashCommandSuggestion {
  command: string;
  description: string;
}

/**
 * @param input - Complete current chat input.
 * @param customCommands - Configured prompt macros.
 *
 * - Opens only while the complete input starts with a slash command token.
 * - Combines active built-ins and non-colliding custom commands.
 * - Filters by the typed prefix and sorts alphabetically.
 *
 * @returns Commands that may be inserted into the chat input.
 *
 * @category Transformation
 */
export function getSlashCommandSuggestions(
  input: string,
  customCommands: readonly CustomCommand[],
): SlashCommandSuggestion[] {
  if (!input.startsWith('/') || /\s/u.test(input)) return [];
  const prefix = input.normalize('NFC').toLowerCase();
  const builtins = BUILTIN_COMMANDS
    .filter(({ available }) => available)
    .map(({ command, description }) => ({ command, description }));
  const custom = removeReservedCustomCommandCollisions(customCommands).map(({ command }) => ({
    command: command.normalize('NFC').trim().toLowerCase(),
    description: 'Eigener Befehl',
  }));
  const unique = new Map<string, SlashCommandSuggestion>();
  for (const suggestion of [...builtins, ...custom]) {
    if (!suggestion.command.startsWith(prefix)) continue;
    if (!unique.has(suggestion.command)) unique.set(suggestion.command, suggestion);
  }
  return [...unique.values()].sort((left, right) => left.command.localeCompare(right.command, 'de'));
}
