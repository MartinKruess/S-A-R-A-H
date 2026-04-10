// src/services/voice/sentence-buffer.ts

const FORCE_FLUSH_LIMIT = 500;

// ── Abbreviation protection ───────────────────────────────────────────────────
//
// We temporarily replace known abbreviation dots with a U+0000 placeholder so
// the splitter regex cannot match them as sentence boundaries.

const PLACEHOLDER = '\x01';

// Longer patterns must come first so they match before shorter sub-patterns.
// Each string is a literal (not a regex); we'll escape them for the RegExp.
const ABBREVIATIONS: string[] = [
  'z. B.', // must come before 'z.B.' — both are in the list
  'z.B.',
  'bzw.',
  'd.h.',
  'u.a.',
  'ca.',
  'etc.',
  'Nr.',
  'Dr.',
  'Prof.',
  'Str.',
  'Abs.',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ABBREV_RE = new RegExp(ABBREVIATIONS.map(escapeRegExp).join('|'), 'g');

/** Replace dots inside known abbreviations with the placeholder character. */
function protectAbbreviations(text: string): string {
  return text.replace(ABBREV_RE, (m) => m.replace(/\./g, PLACEHOLDER));
}

/** Restore placeholder characters back to dots. */
function restoreDots(text: string): string {
  return text.replace(new RegExp(PLACEHOLDER, 'g'), '.');
}

// ── Numbered-list protection ──────────────────────────────────────────────────
//
// Patterns like "1. " or "42. " where the dot is immediately followed by a
// space and an uppercase letter (or the start of further text) are NOT sentence
// boundaries.  We protect them the same way.

// Matches: one or more digits, a literal dot, and a space — anywhere in text.
const NUMBERED_LIST_RE = /(\d+)\.( )/g;

function protectNumberedLists(text: string): string {
  return text.replace(NUMBERED_LIST_RE, (_, digits, space) => `${digits}${PLACEHOLDER}${space}`);
}

// ── Core splitter ─────────────────────────────────────────────────────────────
//
// After protection, we split on:
//   1. "..."  followed by whitespace or end-of-string
//   2. [.!?]  followed by whitespace or end-of-string
//   3. "\n\n" paragraph break
//
// Boundaries are kept at the END of their preceding segment by using a
// positive lookahead for the trailing whitespace/EOS.

// The regex uses a capturing split so delimiters are preserved in the array.
// We use a two-step approach: first mark split points, then split on them.
const BOUNDARY_MARK = '\x02';

function markBoundaries(text: string): string {
  return (
    text
      // Paragraph break
      .replace(/\n\n/g, `\n\n${BOUNDARY_MARK}`)
      // Ellipsis followed by whitespace or EOS
      .replace(/\.\.\.(?=\s|$)/g, `...${BOUNDARY_MARK}`)
      // Single terminal punctuation followed by whitespace or EOS
      .replace(/([.!?])(?=\s|$)/g, `$1${BOUNDARY_MARK}`)
  );
}

/**
 * Splits `text` into segments.  The LAST segment is always the incomplete
 * remainder.  All earlier segments are complete sentences.
 */
function extractSentences(raw: string): string[] {
  const protected_ = protectNumberedLists(protectAbbreviations(raw));
  const marked = markBoundaries(protected_);
  const parts = marked.split(BOUNDARY_MARK);

  // Restore placeholder dots and trim
  return parts.map((p) => restoreDots(p).trim());
}

// ── SentenceBuffer ────────────────────────────────────────────────────────────

export class SentenceBuffer {
  private buffer = '';

  /**
   * Appends `chunk` to the internal buffer and returns any complete sentences
   * detected.  Detected sentences are removed from the buffer.
   */
  push(chunk: string): string[] {
    this.buffer += chunk;

    const sentences: string[] = [];

    // Drain complete sentences, handling force-flush in between
    while (true) {
      const parts = extractSentences(this.buffer);

      // Only one part means no boundary was found yet
      if (parts.length <= 1) {
        // Nothing extractable — check force-flush
        if (this.buffer.length >= FORCE_FLUSH_LIMIT) {
          const forced = this.forceFlush();
          if (forced !== null) {
            sentences.push(forced);
            continue;
          }
        }
        break;
      }

      // All parts except the last are complete sentences
      for (let i = 0; i < parts.length - 1; i++) {
        const s = parts[i].trim();
        if (s.length > 0) {
          sentences.push(s);
        }
      }

      this.buffer = parts[parts.length - 1];
      break;
    }

    return sentences;
  }

  /**
   * Returns remaining buffer content and clears it.
   * Returns `null` when the buffer is empty.
   */
  flush(): string | null {
    const trimmed = this.buffer.trim();
    this.buffer = '';
    return trimmed.length > 0 ? trimmed : null;
  }

  /** Discards all buffered content. */
  reset(): void {
    this.buffer = '';
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Force-splits at the last comma or space so TTS latency is bounded when
   * there is no punctuation boundary in a long stretch of text.
   */
  private forceFlush(): string | null {
    const commaIdx = this.buffer.lastIndexOf(',');
    const spaceIdx = this.buffer.lastIndexOf(' ');
    // Pick the later split point; +1 because we cut AFTER the delimiter
    const splitIdx = Math.max(commaIdx + 1, spaceIdx + 1);

    if (splitIdx <= 0) return null;

    const segment = this.buffer.slice(0, splitIdx).trim();
    this.buffer = this.buffer.slice(splitIdx);

    return segment.length > 0 ? segment : null;
  }
}
