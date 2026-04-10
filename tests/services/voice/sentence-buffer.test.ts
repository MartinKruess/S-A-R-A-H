// tests/services/voice/sentence-buffer.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SentenceBuffer } from '../../../src/services/voice/sentence-buffer.js';

describe('SentenceBuffer', () => {
  let buf: SentenceBuffer;

  beforeEach(() => {
    buf = new SentenceBuffer();
  });

  // ── Basic sentence detection ──────────────────────────────────────────────

  it('simple sentence with trailing space', () => {
    expect(buf.push('Hallo Welt. ')).toEqual(['Hallo Welt.']);
  });

  it('multiple sentences in one chunk', () => {
    expect(buf.push('Eins. Zwei. ')).toEqual(['Eins.', 'Zwei.']);
  });

  it('sentence split across two chunks', () => {
    expect(buf.push('Hal')).toEqual([]);
    expect(buf.push('lo Welt. ')).toEqual(['Hallo Welt.']);
  });

  it('exclamation and question marks', () => {
    expect(buf.push('Was? Ja! ')).toEqual(['Was?', 'Ja!']);
  });

  // ── German abbreviations ──────────────────────────────────────────────────

  it('does not split on "z.B." abbreviation', () => {
    expect(buf.push('Das ist z.B. ein Test. Hier weiter. ')).toEqual([
      'Das ist z.B. ein Test.',
      'Hier weiter.',
    ]);
  });

  it('does not split on "z. B." (with space) abbreviation', () => {
    expect(buf.push('Das ist z. B. ein Test. Fertig. ')).toEqual([
      'Das ist z. B. ein Test.',
      'Fertig.',
    ]);
  });

  it('does not split on "bzw." abbreviation', () => {
    expect(buf.push('Apfel bzw. Birne sind Früchte. Ende. ')).toEqual([
      'Apfel bzw. Birne sind Früchte.',
      'Ende.',
    ]);
  });

  it('does not split on "Dr." abbreviation', () => {
    expect(buf.push('Dr. Müller ist hier. Ende. ')).toEqual([
      'Dr. Müller ist hier.',
      'Ende.',
    ]);
  });

  it('does not split on "ca." abbreviation', () => {
    expect(buf.push('Es dauert ca. 5 Minuten. Danke. ')).toEqual([
      'Es dauert ca. 5 Minuten.',
      'Danke.',
    ]);
  });

  it('does not split on "etc." abbreviation', () => {
    expect(buf.push('Obst, Gemüse etc. sind gesund. Ende. ')).toEqual([
      'Obst, Gemüse etc. sind gesund.',
      'Ende.',
    ]);
  });

  // ── Ellipsis ──────────────────────────────────────────────────────────────

  it('ellipsis is a sentence boundary', () => {
    expect(buf.push('Hmm... okay. ')).toEqual(['Hmm...', 'okay.']);
  });

  it('ellipsis at end of buffer (no trailing space) is still a boundary', () => {
    // "..." at end-of-string is a valid boundary — first push already emits it
    expect(buf.push('Hmm...')).toEqual(['Hmm...']);
    expect(buf.push(' okay. ')).toEqual(['okay.']);
  });

  // ── Numbered lists ────────────────────────────────────────────────────────

  it('numbered list item is NOT a sentence boundary', () => {
    expect(buf.push('1. Schritt eins. ')).toEqual(['1. Schritt eins.']);
  });

  it('numbered list items across multiple sentences stay grouped correctly', () => {
    const result = buf.push('1. Punkt. 2. Anderer Punkt. ');
    // "1. Punkt." is one sentence, "2. Anderer Punkt." is another
    expect(result).toEqual(['1. Punkt.', '2. Anderer Punkt.']);
  });

  // ── Paragraph breaks ──────────────────────────────────────────────────────

  it('paragraph break is a sentence boundary', () => {
    expect(buf.push('Absatz eins.\n\nAbsatz zwei. ')).toEqual([
      'Absatz eins.',
      'Absatz zwei.',
    ]);
  });

  it('paragraph break alone is a boundary', () => {
    expect(buf.push('Erste Zeile\n\nZweite Zeile. ')).toEqual([
      'Erste Zeile',
      'Zweite Zeile.',
    ]);
  });

  // ── Force-flush ───────────────────────────────────────────────────────────

  it('force-flushes at last space after 500 chars without boundary', () => {
    // Build a 510-char string with no sentence-ending punctuation
    const words = 'Hallo Welt und alles Gute von hier '.repeat(20); // well over 500 chars
    const result = buf.push(words);

    expect(result.length).toBeGreaterThan(0);
    for (const s of result) {
      expect(s.length).toBeGreaterThan(0);
      expect(s).toBe(s.trim());
    }
  });

  it('force-flushes at last comma when no space is closer', () => {
    const longNoSpace = 'a'.repeat(200) + ',b' + 'c'.repeat(300);
    const result = buf.push(longNoSpace);
    expect(result.length).toBeGreaterThan(0);
  });

  // ── flush() ──────────────────────────────────────────────────────────────

  it('flush() returns remaining incomplete text', () => {
    buf.push('Unvollständig');
    expect(buf.flush()).toBe('Unvollständig');
  });

  it('flush() returns null when buffer is empty', () => {
    expect(buf.flush()).toBeNull();
  });

  it('flush() clears the buffer so subsequent flush() returns null', () => {
    buf.push('Etwas');
    buf.flush();
    expect(buf.flush()).toBeNull();
  });

  it('flush() returns null after all sentences were already emitted by push()', () => {
    buf.push('Fertig. ');
    expect(buf.flush()).toBeNull();
  });

  // ── reset() ──────────────────────────────────────────────────────────────

  it('reset() clears the buffer', () => {
    buf.push('Halb');
    buf.reset();
    expect(buf.flush()).toBeNull();
  });

  it('reset() allows fresh start without old state', () => {
    buf.push('Alter Text. ');
    buf.reset();
    expect(buf.push('Neuer Satz. ')).toEqual(['Neuer Satz.']);
  });

  // ── Empty / edge cases ────────────────────────────────────────────────────

  it('never returns empty strings', () => {
    const results = buf.push('   .   .   ');
    for (const s of results) {
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it('pushing empty string returns empty array', () => {
    expect(buf.push('')).toEqual([]);
  });

  it('whitespace-only push returns empty array and flush returns null', () => {
    expect(buf.push('   ')).toEqual([]);
    expect(buf.flush()).toBeNull();
  });

  it('no false splits inside words with periods (URL-like)', () => {
    // "www.example.com" should not be split — no trailing space after the dots
    const result = buf.push('Besuche www.example.com bitte. ');
    expect(result).toEqual(['Besuche www.example.com bitte.']);
  });

  // ── Trimming ──────────────────────────────────────────────────────────────

  it('trims leading/trailing whitespace from returned sentences', () => {
    const result = buf.push('  Hallo.   Welt.  ');
    for (const s of result) {
      expect(s).toBe(s.trim());
    }
  });

  // ── Multi-chunk streaming simulation ─────────────────────────────────────

  it('streaming simulation: chunks arriving one char at a time', () => {
    const text = 'Eins. Zwei. Drei. ';
    const allSentences: string[] = [];
    for (const ch of text) {
      allSentences.push(...buf.push(ch));
    }
    expect(allSentences).toEqual(['Eins.', 'Zwei.', 'Drei.']);
  });
});
