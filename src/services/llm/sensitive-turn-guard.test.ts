import { describe, expect, it } from 'vitest';
import {
  createSensitiveTurnGuard,
  redactSensitiveLiterals,
  redactSensitiveLiveContext,
} from './sensitive-turn-guard.js';

describe('sensitive turn guard', () => {
  it('redacts exact password values from output and reusable live context', () => {
    const input = 'Mein Passwort lautet Sommer2024!';
    const guard = createSensitiveTurnGuard(input);

    expect(redactSensitiveLiterals('Du hast Sommer2024! genannt.', guard))
      .toBe('Du hast [VERTRAULICHE_DATEN] genannt.');
    expect(redactSensitiveLiveContext(input, guard)).not.toContain('Sommer2024!');
  });

  it('redacts reformatted IBAN and card values learned from the turn', () => {
    const guard = createSensitiveTurnGuard(
      'IBAN DE89370400440532013000 und Karte 4111 1111 1111 1111',
    );

    expect(redactSensitiveLiterals(
      'DE89 3704 0044 0532 0130 00 / 4111-1111-1111-1111',
      guard,
    )).toBe('[VERTRAULICHE_DATEN] / [VERTRAULICHE_DATEN]');
  });

  it('does not censor ordinary output without a sensitive input literal', () => {
    const guard = createSensitiveTurnGuard('Erkläre mir sichere Passwörter allgemein.');
    const output = 'Ein langes Passwort ist sinnvoll.';

    expect(guard.hasSensitiveInput).toBe(false);
    expect(redactSensitiveLiterals(output, guard)).toBe(output);
  });
});
