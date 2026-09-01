import { describe, expect, it } from 'vitest';
import { prepareSpeechText } from '../../../src/services/voice/speech-text.js';

describe('prepareSpeechText', () => {
  it.each([
    ['Ich erinnere dich um 14:30 Uhr: Erinnerungstest.', 'Ich erinnere dich um 14 Uhr 30: Erinnerungstest.'],
    ['Der Termin beginnt um 08:05 Uhr.', 'Der Termin beginnt um 8 Uhr 5.'],
    ['Um 14:00 Uhr beginnt der Termin.', 'Um 14 Uhr beginnt der Termin.'],
    ['Von 09:15 Uhr bis 10:45 Uhr.', 'Von 9 Uhr 15 bis 10 Uhr 45.'],
  ])('normalizes German display time for speech: %s', (input, expected) => {
    expect(prepareSpeechText(input)).toBe(expected);
  });

  it.each([
    'Das Verhältnis ist 14:30.',
    'https://localhost:14/test',
    'Version 14:30:05 Uhr',
    'Es ist 24:30 Uhr.',
  ])('leaves non-matching colon syntax unchanged: %s', (input) => {
    expect(prepareSpeechText(input)).toBe(input);
  });
});
