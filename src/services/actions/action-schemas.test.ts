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

  it('spotify_volume accepts 0..100, rejects outside', () => {
    expect(ACTION_SCHEMAS.spotify_volume.safeParse('0').success).toBe(true);
    expect(ACTION_SCHEMAS.spotify_volume.safeParse('100').success).toBe(true);
    expect(ACTION_SCHEMAS.spotify_volume.safeParse('101').success).toBe(false);
    expect(ACTION_SCHEMAS.spotify_volume.safeParse('-1').success).toBe(false);
    expect(ACTION_SCHEMAS.spotify_volume.safeParse('50.5').success).toBe(false);
  });

  it('spotify_volume_adjust accepts signed -100..100', () => {
    expect(ACTION_SCHEMAS.spotify_volume_adjust.safeParse('-25').success).toBe(true);
    expect(ACTION_SCHEMAS.spotify_volume_adjust.safeParse('-100').success).toBe(true);
    expect(ACTION_SCHEMAS.spotify_volume_adjust.safeParse('100').success).toBe(true);
    expect(ACTION_SCHEMAS.spotify_volume_adjust.safeParse('0').success).toBe(true);
    expect(ACTION_SCHEMAS.spotify_volume_adjust.safeParse('-101').success).toBe(false);
    expect(ACTION_SCHEMAS.spotify_volume_adjust.safeParse('101').success).toBe(false);
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

  it('media_* accept empty target and short program names, reject overlong', () => {
    for (const name of ['media_play', 'media_pause', 'media_toggle', 'media_next', 'media_previous'] as const) {
      expect(ACTION_SCHEMAS[name].safeParse('').success).toBe(true);
      expect(ACTION_SCHEMAS[name].safeParse('spotify').success).toBe(true);
      expect(ACTION_SCHEMAS[name].safeParse('x'.repeat(41)).success).toBe(false);
    }
  });

  it('isActionName is a strict allowlist', () => {
    expect(isActionName('open_program')).toBe(true);
    expect(isActionName('send_all_data')).toBe(false);
    expect(isActionName('')).toBe(false);
  });

  it('isActionName knows the five media_* names', () => {
    expect(isActionName('media_play')).toBe(true);
    expect(isActionName('media_previous')).toBe(true);
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
    expect(looksLikeActionCommand('Mach die Musik leiser')).toBe(true);
    expect(looksLikeActionCommand('Spotify leiser')).toBe(true);
  });

  it('matches infinitive and polite phrasings (the "kannst du … starten" bug)', () => {
    expect(looksLikeActionCommand('Kannst du zuerst Spotify starten bitte?')).toBe(true);
    expect(looksLikeActionCommand('Kannst du bitte Chrome öffnen?')).toBe(true);
    expect(looksLikeActionCommand('Würdest du das zweite Ergebnis zeigen?')).toBe(true);
    expect(looksLikeActionCommand('Kannst du Hotels in Kiel suchen?')).toBe(true);
    expect(looksLikeActionCommand('Google mal das Wetter')).toBe(true);
    expect(looksLikeActionCommand('Kannst du den Bildschirm sperren?')).toBe(true);
  });

  it('does not match plain chat, including hint substrings inside words', () => {
    expect(looksLikeActionCommand('Was war das Kolosseum?')).toBe(false);
    expect(looksLikeActionCommand('Die Eröffnung war 80 n. Chr.')).toBe(false); // 'öffnung' mid-word ≠ Stamm 'öffn' am Wortanfang
    expect(looksLikeActionCommand('Ich möchte das nicht versuchen')).toBe(false); // 'such' in "versuchen" nicht am Wortanfang
    expect(looksLikeActionCommand('Erzähl mir mehr davon')).toBe(false);
  });

  it('matches media transport hint words, including the bare commands', () => {
    expect(looksLikeActionCommand('Pausiere die Musik')).toBe(true);
    expect(looksLikeActionCommand('Pause')).toBe(true);
    expect(looksLikeActionCommand('Nächstes Lied')).toBe(true);
    expect(looksLikeActionCommand('Ein Lied vor')).toBe(true);
    expect(looksLikeActionCommand('1 Lied zurück')).toBe(true);
    expect(looksLikeActionCommand('Musik starten')).toBe(true);
    expect(looksLikeActionCommand('Skip mal')).toBe(true);
  });
});
