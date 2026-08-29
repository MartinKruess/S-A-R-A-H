export const MAX_MEMORY_EXCLUSIONS = 16;
export const MAX_MEMORY_EXCLUSION_LENGTH = 80;

/** Normalizes one user-configured memory exclusion without changing its meaning. */
export function normalizeMemoryExclusion(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

/** Preserves the first display form while removing normalized case-insensitive duplicates. */
export function normalizeMemoryExclusions(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const label = normalizeMemoryExclusion(value);
    const key = label.toLocaleLowerCase('de-DE');
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(label);
  }
  return normalized;
}

/** Rejects untrusted policy arrays that bypassed the config schema. */
export function areMemoryExclusionsWithinLimits(values: readonly string[]): boolean {
  return values.length <= MAX_MEMORY_EXCLUSIONS && values.every((value) => {
    const normalized = normalizeMemoryExclusion(value);
    return normalized.length > 0 && normalized.length <= MAX_MEMORY_EXCLUSION_LENGTH;
  });
}
