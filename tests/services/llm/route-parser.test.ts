import { describe, expect, it } from 'vitest';
import { parseRouteTag } from '../../../src/services/llm/route-parser';

describe('parseRouteTag', () => {
  it.each(['9b', 'backend', 'extern', 'vision'] as const)(
    'parses the strict %s route tag',
    (route) => {
      expect(parseRouteTag(`[ROUTE:${route}]`)).toEqual({ kind: 'route', route });
    },
  );

  it('parses actions and preserves colons inside parameters', () => {
    expect(parseRouteTag('[ACTION:web_search:hotels: kiel]')).toEqual({
      kind: 'action',
      action: 'web_search',
      param: 'hotels: kiel',
    });
  });

  it('parses parameterless actions as an empty parameter', () => {
    expect(parseRouteTag('[ACTION:lock_screen]')).toEqual({
      kind: 'action',
      action: 'lock_screen',
      param: '',
    });
  });

  it('preserves compact Timer V2 parameters for central validation', () => {
    expect(parseRouteTag('[ACTION:set_timer:5m30s|Brötchen]')).toEqual({
      kind: 'action',
      action: 'set_timer',
      param: '5m30s|Brötchen',
    });
    expect(parseRouteTag('[ACTION:cancel_timer:label=Eier]')).toEqual({
      kind: 'action',
      action: 'cancel_timer',
      param: 'label=Eier',
    });
  });

  it.each([
    '',
    'Hallo, wie kann ich helfen?',
    '[ROUTE:self]',
    '[ROUTE:9b] sichtbarer Text',
    '[ACTION:open_program:spotify] sichtbarer Text',
    '[ACTION:set_timer:10][ACTION:lock_screen:]',
    'Text [ACTION:set_volume:50]',
  ])('falls back safely to the worker for invalid output: %s', (output) => {
    expect(parseRouteTag(output)).toEqual({ kind: 'route', route: '9b' });
  });

  it('keeps unknown action names for the central allowlist to reject', () => {
    expect(parseRouteTag('[ACTION:send_all_data:evil]')).toEqual({
      kind: 'action',
      action: 'send_all_data',
      param: 'evil',
    });
  });
});
