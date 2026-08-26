import { describe, expect, it } from 'vitest';
import type { RuntimeSnapshot } from './app-lifecycle-controller.js';
import { isChatAvailable } from './chat-availability.js';

function snapshot(
  state: RuntimeSnapshot['state'],
  routerState?: RuntimeSnapshot['state'],
): RuntimeSnapshot {
  return {
    state,
    generation: 1,
    updatedAt: 1,
    capabilities: routerState ? { router: { state: routerState } } : {},
  };
}

describe('isChatAvailable', () => {
  it.each(['ready', 'degraded'] as const)(
    'accepts work in %s state when the router is ready',
    (state) => expect(isChatAvailable(snapshot(state, 'ready'))).toBe(true),
  );

  it.each(['registered', 'starting', 'unavailable', 'error', 'stopping', 'stopped'] as const)(
    'rejects work while the application is %s',
    (state) => expect(isChatAvailable(snapshot(state, 'ready'))).toBe(false),
  );

  it.each(['registered', 'starting', 'degraded', 'unavailable', 'error', 'stopping', 'stopped'] as const)(
    'rejects work when the router is %s',
    (state) => expect(isChatAvailable(snapshot('degraded', state))).toBe(false),
  );

  it('rejects work when no router capability was published', () => {
    expect(isChatAvailable(snapshot('degraded'))).toBe(false);
  });
});
