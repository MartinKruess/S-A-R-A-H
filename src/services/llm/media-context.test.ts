import { describe, it, expect } from 'vitest';
import { MediaContext, MEDIA_CONTEXT_WINDOW_MS } from './media-context.js';

describe('MediaContext.resolve', () => {
  it('"weiter" after a pause resumes (media_play)', () => {
    const c = new MediaContext();
    c.record('media_pause', 1000);
    expect(c.resolve('weiter', 2000)).toEqual({ action: 'media_play', speak: 'Läuft wieder.' });
  });

  it('"weiter" after a skip goes to the next track (media_next)', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('weiter', 2000)).toEqual({ action: 'media_next', speak: 'Nächstes Lied.' });
  });

  it('"nächstes" is always media_next, even right after a pause', () => {
    const c = new MediaContext();
    c.record('media_pause', 1000);
    expect(c.resolve('nächstes', 2000)).toEqual({ action: 'media_next', speak: 'Nächstes Lied.' });
  });

  it('"zurück"/"das vorherige" → media_previous; "stopp"/"halt" → media_pause', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('zurück', 1500)?.action).toBe('media_previous');
    expect(c.resolve('das vorherige', 1500)?.action).toBe('media_previous');
    expect(c.resolve('stopp', 1500)?.action).toBe('media_pause');
    expect(c.resolve('halt', 1500)?.action).toBe('media_pause');
  });

  it('returns null when the window is cold (> WINDOW old)', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('weiter', 1000 + MEDIA_CONTEXT_WINDOW_MS + 1)).toBeNull();
  });

  it('returns null when nothing was recorded yet', () => {
    expect(new MediaContext().resolve('weiter', 5000)).toBeNull();
  });

  it('returns null for a whole sentence (> 3 tokens)', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('erzähl mir mehr davon weiter', 2000)).toBeNull();
  });

  it('returns null for an unknown short word', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('hallo', 2000)).toBeNull();
  });

  it('record refreshes the sliding window', () => {
    const c = new MediaContext();
    c.record('media_next', 0);
    const first = c.resolve('weiter', 10_000);      // 10s < 12s → warm
    expect(first?.action).toBe('media_next');
    c.record(first!.action, 10_000);                 // refresh at 10s (RouterService does this)
    expect(c.resolve('weiter', 15_000)?.action).toBe('media_next'); // 5s after refresh → still warm
  });

  it('normalizes case and surrounding whitespace', () => {
    const c = new MediaContext();
    c.record('media_pause', 1000);
    expect(c.resolve('  WEITER  ', 2000)?.action).toBe('media_play');
  });

  it('tolerates trailing punctuation from Whisper transcripts ("Weiter.")', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('Weiter.', 2000)?.action).toBe('media_next');
  });

  it('tolerates trailing punctuation from Whisper transcripts ("Stopp!")', () => {
    const c = new MediaContext();
    c.record('media_next', 1000);
    expect(c.resolve('Stopp!', 2000)?.action).toBe('media_pause');
  });

  it('tolerates trailing punctuation from Whisper transcripts ("Nächstes.")', () => {
    const c = new MediaContext();
    c.record('media_pause', 1000);
    expect(c.resolve('Nächstes.', 2000)?.action).toBe('media_next');
  });
});
