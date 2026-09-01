import { describe, expect, it } from 'vitest';
import { MEMORY_EXCLUSION_CATEGORY_IDS, mustKeepTurnTransient } from '../../src/core/memory-policy.js';
import { MAX_MEMORY_EXCLUSIONS, MAX_MEMORY_EXCLUSION_LENGTH } from '../../src/core/memory-exclusions.js';

describe('mustKeepTurnTransient', () => {
  const browserPolicy = { allowed: true, exclusions: ['Browser-Daten'] } as const;

  it('recognizes actual HTTP(S) URLs as browser data without requiring the word URL', () => {
    expect(mustKeepTurnTransient(['Privat: https://example.com/private'], browserPolicy)).toBe(true);
    expect(mustKeepTurnTransient(['Siehe HTTP://EXAMPLE.COM/path?q=1.'], browserPolicy)).toBe(true);
  });

  it('recognizes spoken or copied domains as browser data without requiring a scheme', () => {
    expect(mustKeepTurnTransient(['Ich besuchte www.beispiel.de heute'], browserPolicy)).toBe(true);
    expect(mustKeepTurnTransient(['Ich war auf beispiel.de/geheim'], browserPolicy)).toBe(true);
  });

  it.each(['Browserdaten', 'Browserverlauf'])('recognizes browser exclusion alias %s', (exclusion) => {
    expect(mustKeepTurnTransient(
      ['Ich war auf beispiel.de/geheim'],
      { allowed: true, exclusions: [exclusion] },
    )).toBe(true);
  });

  it('does not mistake email addresses or other protocols for web URLs', () => {
    expect(mustKeepTurnTransient(['mailto:person@example.com'], browserPolicy)).toBe(false);
  });

  it.each([
    'Mein Passwort ist Fuchs-17.',
    'Mein Kennwort lautet Fuchs-17.',
    'Die PIN lautet 1937.',
    'Die TAN ist 123456.',
    'Mein Einmalcode lautet A1B2C3.',
    'Der API-Key ist abc-123.',
    'Der Access-Token lautet token-123.',
    'Der Refresh Token ist refresh-123.',
    'Der OTP ist 848484.',
    'Der Recovery-Code lautet recover-123.',
    'Das Client-Secret ist secret-123.',
    'Mein 2FA-Code ist 481516.',
    'Der Verifizierungscode lautet 654321.',
    'Mein Auth-Token ist auth-123.',
    'Bearer-Token: bearer-123.',
    'Mein SSH Private Key beginnt mit AAAA.',
    'Mein MFA-Code ist 123456.',
    'Der TOTP-Code lautet 654321.',
    'Mein Backup-Code ist backup-123.',
    'Der GitHub-Token lautet ghp_example.',
    'Meine Seed Phrase lautet alpha beta gamma.',
    'JWT: eyJhbGciOiJIUzI1NiJ9.example.signature',
    'Kartennummer: 4111 1111 1111 1111',
    'Meine IBAN ist DE89 3704 0044 0532 0130 00.',
    'Steueridentifikationsnummer: 12345678901',
    'API_KEY=abc-123',
    'OPENAI_CLIENT_SECRET=abc-123',
    'ACCESS_TOKEN=abc-123',
    'API\u200B_KEY=abc-123',
    'Pass\u200Dwort: Fuchs-17',
  ])('never persists secrets even without configured exclusions: %s', (content) => {
    expect(mustKeepTurnTransient([content], { allowed: true, exclusions: [] })).toBe(true);
  });

  it.each([
    'Die Monkey Island Reihe ist großartig.',
    'Wir verwenden passwordless Login.',
    'Der API_KEYBOARD_MODE beschreibt nur ein UI-Layout.',
    'Die Datei heißt client_secretary.txt.',
    '/confirm 83838383-8383-4383-8383-838383838383',
  ])('does not block harmless substrings that resemble secret labels: %s', (content) => {
    expect(mustKeepTurnTransient([content], { allowed: true, exclusions: [] })).toBe(false);
  });

  it.each([
    'Ich gehe heute tanzen.',
    'Wir waren beim Tanzkurs.',
    'Der Pinguin im Zoo war lustig.',
    'Ich mag Tannenbaeume.',
    'Der Tanker liegt im Hafen.',
  ])('does not block words that merely begin like an assignment label: %s', (content) => {
    expect(mustKeepTurnTransient([content], { allowed: true, exclusions: [] })).toBe(false);
  });

  it('does not classify action confirmation control text as private data', () => {
    expect(mustKeepTurnTransient([
      'Öffne Spotify',
      'Bitte bestätige die Aktion open_program mit dem Parameter „spotify“. Antworte mit /confirm ab12cdef-1234-4123-8123-123456789abc.',
    ], { allowed: true, exclusions: [] })).toBe(false);
  });

  it.each([
    'Meine Passwörter: a1, b2.',
    'The passwords are stored here.',
    'Mein PW ist Fuchs17.',
    'pwd=Fuchs17',
    'Mein Netflix-Login: martin@example.de / Sommer2024!',
    'Meine Zugangsdaten: martin / Sommer2024!',
  ])('never persists common plural, abbreviated or login secret labels: %s', (content) => {
    expect(mustKeepTurnTransient([content], { allowed: true, exclusions: [] })).toBe(true);
  });

  it('matches category vocabulary as complete tokens instead of substrings', () => {
    const policy = { allowed: true, exclusions: ['Finanzen'] } as const;
    expect(mustKeepTurnTransient(['Wir sitzen auf einer Parkbank.'], policy)).toBe(false);
    expect(mustKeepTurnTransient(['Das Bankkontomodell ist nur ein Klassenname.'], policy)).toBe(false);
    expect(mustKeepTurnTransient(['Meine Bank hat das Konto gesperrt.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Mein Bankkonto wurde gesperrt.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Ich bin Kunde bei der Sparkasse.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Ich habe eine neue Kreditkarte.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Meine Kontonummer hat sich geändert.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Die BIC lautet TESTDE00.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Mein Depot ist gewachsen.'], policy)).toBe(true);
  });

  it('never stores common bank or insurance data labels even without configured exclusions', () => {
    const policy = { allowed: true, exclusions: [] } as const;
    expect(mustKeepTurnTransient(['Kontonummer: 123456789'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Meine BIC lautet TESTDE00.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Mein Depot enthält Fonds.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Versicherungsnummer: ABC-123'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Das Depotmuseum ist heute geöffnet.'], policy)).toBe(false);
    expect(mustKeepTurnTransient(['Das Bicycle-Modell ist rot.'], policy)).toBe(false);
  });

  it('matches insurance compounds for a dedicated custom category', () => {
    const policy = { allowed: true, exclusions: ['Versicherung'] } as const;
    expect(mustKeepTurnTransient(['Meine Versicherungsnummer ist ABC-123.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Der Versicherungsschein liegt bereit.'], policy)).toBe(true);
  });

  it('recognizes representative health terms for the health category', () => {
    expect(mustKeepTurnTransient(
      ['Ich habe Diabetes.'],
      { allowed: true, exclusions: ['Gesundheit'] },
    )).toBe(true);
    expect(mustKeepTurnTransient(
      ['Mein Gesundheitszustand hat sich verändert.'],
      { allowed: true, exclusions: ['Gesundheit'] },
    )).toBe(true);
    expect(mustKeepTurnTransient(
      ['Mein Blutdruck ist heute erhöht.'],
      { allowed: true, exclusions: ['Gesundheit'] },
    )).toBe(true);
    expect(mustKeepTurnTransient(
      ['Ich hatte früher Depressionen.'],
      { allowed: true, exclusions: ['Gesundheit'] },
    )).toBe(true);
    expect(mustKeepTurnTransient(
      ['Der Depressionsroman wurde ausgezeichnet.'],
      { allowed: true, exclusions: ['Gesundheit'] },
    )).toBe(false);
  });

  it.each([
    MEMORY_EXCLUSION_CATEGORY_IDS.HEALTH,
    'Gesundheitsdaten',
    'Medizinische Daten',
    'Medical data',
  ])('maps the stable health category and legacy/display alias %s to one contract', (exclusion) => {
    expect(mustKeepTurnTransient(
      ['Meine Schwangerschaft wird von einer Ärztin begleitet.'],
      { allowed: true, exclusions: [exclusion] },
    )).toBe(true);
  });

  it.each([
    'Mein HIV-Test war negativ.',
    'Die Krebsdiagnose wurde bestätigt.',
    'Ich habe morgen einen Termin beim Psychiater.',
    'Ich nehme Ibuprofen gegen die Schmerzen.',
    'My doctor discussed the cancer treatment.',
    'The blood pressure result was high.',
    'She is pregnant and takes medication.',
  ])('keeps representative health data transient when the health category is enabled: %s', (content) => {
    expect(mustKeepTurnTransient(
      [content],
      { allowed: true, exclusions: [MEMORY_EXCLUSION_CATEGORY_IDS.HEALTH] },
    )).toBe(true);
  });

  it('does not silently turn the optional health category into a global storage prohibition', () => {
    expect(mustKeepTurnTransient(
      ['Ich nehme Ibuprofen gegen Kopfschmerzen.'],
      { allowed: true, exclusions: [] },
    )).toBe(false);
  });

  it.each([
    { exclusions: Array.from({ length: MAX_MEMORY_EXCLUSIONS + 1 }, (_, index) => `topic-${index}`) },
    { exclusions: ['x'.repeat(MAX_MEMORY_EXCLUSION_LENGTH + 1)] },
  ])('fails closed when an oversized exclusion policy bypasses config validation', ({ exclusions }) => {
    expect(mustKeepTurnTransient(['Harmloser Inhalt'], { allowed: true, exclusions })).toBe(true);
  });

  it('fails closed for all content when the third-party-name category is enabled', () => {
    const policy = { allowed: true, exclusions: ['Namen Dritter'] } as const;
    expect(mustKeepTurnTransient(['Peter kommt morgen vorbei.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Heute ist das Wetter sonnig.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Der Petersdom steht in Rom.'], policy)).toBe(true);
  });

  it('matches custom multi-word exclusions only as a complete token sequence', () => {
    const policy = { allowed: true, exclusions: ['Projekt Eule'] } as const;
    expect(mustKeepTurnTransient(['Projekt Eule bleibt geheim.'], policy)).toBe(true);
    expect(mustKeepTurnTransient(['Das Projekt Eulenfeder ist sichtbar.'], policy)).toBe(false);
  });
});
