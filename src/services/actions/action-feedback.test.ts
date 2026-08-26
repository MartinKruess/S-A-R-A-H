import { describe, expect, it } from 'vitest';
import { ACTION_SCHEMAS, type ActionName } from './action-schemas.js';
import { getActionAcknowledgement } from './action-feedback.js';

const EXAMPLE_PARAMS: Record<ActionName, string> = {
  open_program: 'spotify',
  web_search: 'hotels kiel',
  show_browser: '2',
  set_volume: '50',
  spotify_volume: '40',
  spotify_volume_adjust: '-5',
  set_timer: '10',
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
});
