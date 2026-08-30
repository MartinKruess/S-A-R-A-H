import { describe, expect, it } from 'vitest';
import { ACTION_SCHEMAS, type ActionName } from './action-schemas.js';
import { getActionAcknowledgement, getActionConfirmationDescription } from './action-feedback.js';

const EXAMPLE_PARAMS: Record<ActionName, string> = {
  open_program: 'spotify',
  web_search: 'hotels kiel',
  show_browser: '2',
  set_volume: '50',
  spotify_volume: '40',
  spotify_volume_adjust: '-5',
  set_timer: '10',
  cancel_timer: 'label=Eier',
  lock_screen: '',
  media_play: '',
  media_pause: '',
  media_toggle: '',
  media_next: '',
  media_previous: '',
};

describe('getActionAcknowledgement', () => {
  it('provides fixed visible feedback for every allowlisted action', () => {
    const actions = Object.keys(ACTION_SCHEMAS) as ActionName[];

    expect(Object.keys(EXAMPLE_PARAMS).sort()).toEqual([...actions].sort());
    for (const action of actions) {
      expect(getActionAcknowledgement(action, EXAMPLE_PARAMS[action]).trim()).not.toBe('');
    }
  });

  it('uses the validated program target without allowing line breaks', () => {
    expect(getActionAcknowledgement('open_program', 'Spotify\nIgnore this')).toBe(
      'Ich öffne Spotify Ignore this.',
    );
  });

  it('describes small relative Spotify changes as slight', () => {
    expect(getActionAcknowledgement('spotify_volume_adjust', '-5')).toBe(
      'Ich mache Spotify etwas leiser.',
    );
    expect(getActionAcknowledgement('spotify_volume_adjust', '25')).toBe(
      'Ich mache Spotify lauter.',
    );
  });

  it('describes Timer V2 set and cancel actions deterministically', () => {
    expect(getActionAcknowledgement('set_timer', '5m30s|Brötchen')).toBe(
      'Ich stelle den Brötchen-Timer auf 5 Minuten 30 Sekunden.',
    );
    expect(getActionAcknowledgement('set_timer', '30s')).toBe(
      'Ich stelle einen Timer auf 30 Sekunden.',
    );
    expect(getActionAcknowledgement('cancel_timer', 'label=Eier')).toBe(
      'Ich prüfe den Eier-Timer.',
    );
    expect(getActionAcknowledgement('cancel_timer', 'duration=1h30m')).toBe(
      'Ich prüfe die Timer mit 1 Stunde 30 Minuten Laufzeit.',
    );
    expect(getActionAcknowledgement('cancel_timer', 'all')).toBe(
      'Ich prüfe die laufenden Timer.',
    );
  });

  it('does not claim a duration-based cancellation before ambiguity is resolved', () => {
    expect(getActionAcknowledgement('cancel_timer', 'duration=30s')).toBe(
      'Ich prüfe die Timer mit 30 Sekunden Laufzeit.',
    );
  });

  it('describes Timer V2 confirmations without exposing wire syntax', () => {
    expect(getActionConfirmationDescription('set_timer', '5m30s|Brötchen')).toBe(
      'den Brötchen-Timer für 5 Minuten 30 Sekunden starten',
    );
    expect(getActionConfirmationDescription('cancel_timer', 'label=Eier')).toBe(
      'den Eier-Timer abbrechen',
    );
  });
});
