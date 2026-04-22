import type { ProgramEntry } from '../../core/config-schema.js';
import type { ProgramOption } from './program-detection.js';
import { getIcon } from './program-detection.js';

/**
 * Merges detected program options with manually-added selected entries
 * that don't appear in the detected list. Avoids duplicates by name.
 */
export function mergeOptions(
  detected: ProgramOption[],
  selected: ProgramEntry[],
): ProgramOption[] {
  const detectedNames = new Set(detected.map(o => o.value));
  const extras: ProgramOption[] = [];
  for (const entry of selected) {
    if (!detectedNames.has(entry.name)) {
      extras.push({ value: entry.name, label: entry.name, icon: getIcon(entry.name) });
    }
  }
  return [...detected, ...extras];
}

/**
 * Rebuilds ProgramEntry[] from selected names using source priority:
 *   1. detected (via detected list)
 *   2. previous manual (from earlier selection)
 *   3. new manual (via buildManualEntry fallback)
 *
 * Preserves input order of names.
 */
export function reconstructEntries(
  names: string[],
  detected: ProgramEntry[],
  previousSelected: ProgramEntry[],
  buildManualEntry: (name: string) => ProgramEntry,
): ProgramEntry[] {
  const detectedByName = new Map(detected.map(e => [e.name, e]));
  const previousByName = new Map(previousSelected.map(e => [e.name, e]));
  return names.map((name) => {
    const d = detectedByName.get(name);
    if (d) return d;
    const p = previousByName.get(name);
    if (p) return p;
    return buildManualEntry(name);
  });
}
