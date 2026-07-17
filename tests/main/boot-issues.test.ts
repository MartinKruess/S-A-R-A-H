import { describe, it, expect } from 'vitest';
import { deriveBootIssue } from '../../src/main/boot-issues';

describe('deriveBootIssue', () => {
  it('reports container errors as-is', () => {
    expect(deriveBootIssue('Docker ist nicht gestartet.', 'error')).toEqual({
      message: 'Docker ist nicht gestartet.',
      severity: 'error',
    });
  });

  it('reports router error despite healthy container', () => {
    expect(deriveBootIssue(null, 'error')).toEqual({
      message: 'Sarah-Protokoll nicht erreichbar — Sprachverarbeitung ist gestört.',
      severity: 'error',
    });
  });

  it('returns null when everything is fine', () => {
    expect(deriveBootIssue(null, 'running')).toBeNull();
    expect(deriveBootIssue(null, 'pending')).toBeNull();
  });
});
