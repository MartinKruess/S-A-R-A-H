export const BUILTIN_COMMANDS = [
  { command: '/anonymous', description: 'Nachricht wird nach der Session vergessen', available: true },
  { command: '/confirm', description: 'Bestätigt eine zuvor angefragte Aktion', available: true },
  { command: '/showcontext', description: 'Zeigt alles was Sarah über dich weiß', available: false },
  { command: '/quietmode', description: 'Ruhemodus ein/aus', available: false },
] as const;

export const RESERVED_BUILTIN_COMMANDS: ReadonlySet<string> = new Set(
  BUILTIN_COMMANDS.map((entry) => entry.command),
);

export interface ConfiguredCustomCommand {
  command: string;
  prompt: string;
}

/** Removes only custom commands whose normalized name exactly collides with a built-in. */
export function removeReservedCustomCommandCollisions<T extends ConfiguredCustomCommand>(
  commands: readonly T[],
): T[] {
  return commands.filter(
    (entry) => !RESERVED_BUILTIN_COMMANDS.has(entry.command.normalize('NFC').trim().toLowerCase()),
  );
}
