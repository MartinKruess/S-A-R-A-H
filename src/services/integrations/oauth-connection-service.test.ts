import { describe, it, expect, vi } from 'vitest';
import { OAuthConnectionService } from './oauth-connection-service.js';
import type { OAuthProvider } from './providers.js';
import type { TokenStore, StoredToken } from './token-store.js';

/** In-memory TokenStore fake (no filesystem, no crypto). */
function fakeStore(initial: Record<string, StoredToken> = {}): TokenStore {
  const data: Record<string, StoredToken> = { ...initial };
  return {
    get: (id: string) => data[id],
    has: (id: string) => id in data,
    set: (id: string, t: StoredToken) => {
      data[id] = t;
    },
    delete: (id: string) => {
      delete data[id];
    },
  } as unknown as TokenStore;
}

const spotify: OAuthProvider = {
  id: 'spotify',
  displayName: 'Spotify',
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
  scopes: ['user-modify-playback-state', 'user-read-playback-state'],
  clientId: 'client-123',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function makeService(opts: {
  store: TokenStore;
  fetchFn?: typeof fetch;
  now?: () => number;
  provider?: OAuthProvider;
}): OAuthConnectionService {
  return new OAuthConnectionService({
    providers: [opts.provider ?? spotify],
    tokenStore: opts.store,
    fetchFn: opts.fetchFn ?? ((async () => jsonResponse({})) as unknown as typeof fetch),
    openExternal: () => {},
    now: opts.now ?? (() => 1_000_000),
    redirectPort: 8888,
  });
}

describe('OAuthConnectionService', () => {
  it('getAccessToken returns the stored token when not expired', async () => {
    const now = () => 1_000_000;
    const store = fakeStore({
      spotify: { refreshToken: 'r', accessToken: 'valid-at', expiresAt: now() + 5 * 60_000, scope: 's' },
    });
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const svc = makeService({ store, fetchFn, now });

    expect(await svc.getAccessToken('spotify')).toBe('valid-at');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('getAccessToken refreshes when expired and persists the new access token', async () => {
    const now = () => 1_000_000;
    const store = fakeStore({
      spotify: { refreshToken: 'old-refresh', accessToken: 'stale', expiresAt: now() + 1000, scope: 's' },
    });
    const fetchFn = vi.fn(async () =>
      jsonResponse({ access_token: 'fresh-at', refresh_token: 'new-refresh', expires_in: 3600, scope: 's2' }),
    ) as unknown as typeof fetch;
    const svc = makeService({ store, fetchFn, now });

    expect(await svc.getAccessToken('spotify')).toBe('fresh-at');
    const stored = store.get('spotify');
    expect(stored?.accessToken).toBe('fresh-at');
    expect(stored?.refreshToken).toBe('new-refresh');
    expect(stored?.expiresAt).toBe(now() + 3600 * 1000);
  });

  it('getAccessToken keeps the old refresh token when the refresh response omits it', async () => {
    const now = () => 1_000_000;
    const store = fakeStore({
      spotify: { refreshToken: 'keep-me', accessToken: 'stale', expiresAt: now() + 1000, scope: 's' },
    });
    const fetchFn = vi.fn(async () =>
      jsonResponse({ access_token: 'fresh-at', expires_in: 3600, scope: 's' }),
    ) as unknown as typeof fetch;
    const svc = makeService({ store, fetchFn, now });

    expect(await svc.getAccessToken('spotify')).toBe('fresh-at');
    expect(store.get('spotify')?.refreshToken).toBe('keep-me');
  });

  it('getAccessToken: refresh failure → disconnected + null', async () => {
    const now = () => 1_000_000;
    const store = fakeStore({
      spotify: { refreshToken: 'revoked', accessToken: 'stale', expiresAt: now() + 1000, scope: 's' },
    });
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: 'invalid_grant' }, false, 400),
    ) as unknown as typeof fetch;
    const svc = makeService({ store, fetchFn, now });

    expect(await svc.getAccessToken('spotify')).toBeNull();
    expect(store.has('spotify')).toBe(false);
  });

  it('getAccessToken: no stored token → null', async () => {
    const svc = makeService({ store: fakeStore() });
    expect(await svc.getAccessToken('spotify')).toBeNull();
  });

  it('getAccessToken: empty clientId → null (not connectable)', async () => {
    const now = () => 1_000_000;
    const store = fakeStore({
      spotify: { refreshToken: 'r', accessToken: 'valid-at', expiresAt: now() + 5 * 60_000, scope: 's' },
    });
    const svc = makeService({ store, now, provider: { ...spotify, clientId: '' } });
    expect(await svc.getAccessToken('spotify')).toBeNull();
  });

  it('listConnections reflects connected state and expiresAt', async () => {
    const now = () => 1_000_000;
    const store = fakeStore({
      spotify: { refreshToken: 'r', accessToken: 'at', expiresAt: 42, scope: 's' },
    });
    const svc = makeService({ store, now });
    expect(svc.listConnections()).toEqual([
      { id: 'spotify', displayName: 'Spotify', connected: true, expiresAt: 42 },
    ]);

    await svc.disconnect('spotify');
    expect(svc.listConnections()).toEqual([
      { id: 'spotify', displayName: 'Spotify', connected: false, expiresAt: undefined },
    ]);
  });

  it('getStatus returns per-provider info; undefined for unknown provider', () => {
    const svc = makeService({ store: fakeStore() });
    expect(svc.getStatus('spotify')?.connected).toBe(false);
    expect(svc.getStatus('github')).toBeUndefined();
  });

  it('connect rejects with a clear error when clientId is empty', async () => {
    const svc = makeService({ store: fakeStore(), provider: { ...spotify, clientId: '' } });
    await expect(svc.connect('spotify')).rejects.toThrow(/SPOTIFY_CLIENT_ID fehlt/);
  });
});
