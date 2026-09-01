import { describe, expect, it } from 'vitest';
import { getSlashCommandSuggestions } from '../../../src/renderer/dashboard/slash-command-suggestions.js';

describe('getSlashCommandSuggestions', () => {
  it('only opens when the complete input begins with a slash', () => {
    expect(getSlashCommandSuggestions('im Web /browser', [])).toEqual([]);
    expect(getSlashCommandSuggestions(' /show', [])).toEqual([]);
    expect(getSlashCommandSuggestions('/show', []).map(({ command }) => command)).toEqual(['/showcontext']);
  });

  it('lists active built-ins alphabetically and excludes unavailable commands', () => {
    const commands = getSlashCommandSuggestions('/', []).map(({ command }) => command);
    expect(commands).toEqual([...commands].sort((left, right) => left.localeCompare(right, 'de')));
    expect(commands).toContain('/anonymous');
    expect(commands).not.toContain('/quietmode');
  });

  it('includes configured commands without duplicating reserved built-ins', () => {
    const commands = getSlashCommandSuggestions('/', [
      { command: '/spotify', prompt: 'Öffne Spotify' },
      { command: '/showcontext', prompt: 'Kollision' },
    ]).map(({ command }) => command);
    expect(commands).toContain('/spotify');
    expect(commands.filter((command) => command === '/showcontext')).toHaveLength(1);
  });

  it('closes after command arguments begin', () => {
    expect(getSlashCommandSuggestions('/remember Mars', [])).toEqual([]);
  });
});
