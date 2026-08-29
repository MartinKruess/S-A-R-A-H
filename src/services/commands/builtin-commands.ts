export const BUILTIN_COMMANDS = [
  { command: '/anonymous', description: 'Vertrauliche Nachricht oder Anonymous-Modus ein/aus', available: true },
  { command: '/confirm', description: 'Bestätigt eine zuvor angefragte Aktion', available: true },
  { command: '/showcontext', description: 'Zeigt Sarahs kuratierte Erinnerungen', available: true },
  { command: '/remember', description: 'Speichert eine ausdrückliche Erinnerung', available: true },
  { command: '/correctmemory', description: 'Korrigiert eine Erinnerung anhand ihrer ID', available: true },
  { command: '/forget', description: 'Blendet eine Erinnerung anhand ihrer ID aus', available: true },
  { command: '/deletememory', description: 'Löscht eine Erinnerung anhand ihrer ID endgültig', available: true },
  { command: '/exportmemory', description: 'Exportiert kuratierte Erinnerungen als JSON', available: true },
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
