import { describe, it, expect } from 'vitest';
import { ACTION_SCHEMAS, isActionName, looksLikeActionCommand } from './action-schemas.js';

describe('ACTION_SCHEMAS boundaries', () => {
  it('set_volume accepts 0..100, rejects outside and non-integers', () => {
    expect(ACTION_SCHEMAS.set_volume.safeParse('0').success).toBe(true);
    expect(ACTION_SCHEMAS.set_volume.safeParse('100').success).toBe(true);
    expect(ACTION_SCHEMAS.set_volume.safeParse('101').success).toBe(false);
    expect(ACTION_SCHEMAS.set_volume.safeParse('-1').success).toBe(false);
    expect(ACTION_SCHEMAS.set_volume.safeParse('50.5').success).toBe(false);
    expect(ACTION_SCHEMAS.set_volume.safeParse('laut').success).toBe(false);
  });

  it('set_timer accepts 1..1440 minutes', () => {
    expect(ACTION_SCHEMAS.set_timer.safeParse('1').success).toBe(true);
    expect(ACTION_SCHEMAS.set_timer.safeParse('1440').success).toBe(true);
    expect(ACTION_SCHEMAS.set_timer.safeParse('0').success).toBe(false);
    expect(ACTION_SCHEMAS.set_timer.safeParse('1441').success).toBe(false);
  });

  it('query lengths: web_search 2..200, open_program 1..100, show_browser 1..100', () => {
    expect(ACTION_SCHEMAS.web_search.safeParse('a').success).toBe(false);
    expect(ACTION_SCHEMAS.web_search.safeParse('ab').success).toBe(true);
    expect(ACTION_SCHEMAS.web_search.safeParse('x'.repeat(201)).success).toBe(false);
    expect(ACTION_SCHEMAS.open_program.safeParse('').success).toBe(false);
    expect(ACTION_SCHEMAS.show_browser.safeParse('').success).toBe(false);
  });

  it('lock_screen accepts only the empty param (R4-Mi3)', () => {
    expect(ACTION_SCHEMAS.lock_screen.safeParse('').success).toBe(true);
    expect(ACTION_SCHEMAS.lock_screen.safeParse('jetzt').success).toBe(false);
  });

  it('isActionName is a strict allowlist', () => {
    expect(isActionName('open_program')).toBe(true);
    expect(isActionName('send_all_data')).toBe(false);
    expect(isActionName('')).toBe(false);
  });
});

describe('looksLikeActionCommand (Heuristik-Gate, §3)', () => {
  it('matches imperative commands with hint words, case-insensitive', () => {
    expect(looksLikeActionCommand('Öffne Spotify')).toBe(true);
    expect(looksLikeActionCommand('öffne spotify')).toBe(true);
    expect(looksLikeActionCommand('Such mal Hotels in Kiel')).toBe(true);
    expect(looksLikeActionCommand('Stell einen Timer auf 10 Minuten')).toBe(true);
    expect(looksLikeActionCommand('Mach die Lautstärke auf 50')).toBe(true);
    expect(looksLikeActionCommand('Sperr den Bildschirm')).toBe(true);
    expect(looksLikeActionCommand('Zeig mir das zweite')).toBe(true);
  });

  it('does not match plain chat, including hint substrings inside words', () => {
    expect(looksLikeActionCommand('Was war das Kolosseum?')).toBe(false);
    expect(looksLikeActionCommand('Die Eröffnung war 80 n. Chr.')).toBe(false); // 'öffnung' ≠ Wort 'öffne'
    expect(looksLikeActionCommand('Erzähl mir mehr davon')).toBe(false);
  });
});
