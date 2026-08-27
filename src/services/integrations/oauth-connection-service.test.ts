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
    getStatus: () => ({ state: 'ready' }),
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

  it('coalesces parallel refreshes per provider into one token rotation', async () => {
    const now = () => 1_000_000;
    const store = fakeStore({
      spotify: { refreshToken: 'old-refresh', accessToken: 'stale', expiresAt: now() + 1000, scope: 's' },
    });
    let resolveFetch: (response: Response) => void = () => {};
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
    const svc = makeService({ store, fetchFn, now });

    const first = svc.getAccessToken('spotify');
    const second = svc.getAccessToken('spotify');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }));
    await expect(Promise.all([first, second])).resolves.toEqual(['fresh', 'fresh']);
    expect(store.get('spotify')?.refreshToken).toBe('rotated');
  });

  it('does not delete a newer token when an older in-flight refresh fails', async () => {
    const now = () => 1_000_000;
    const stale: StoredToken = {
      refreshToken: 'old-refresh', accessToken: 'stale', expiresAt: now() + 1000, scope: 's',
    };
    const fresh: StoredToken = {
      refreshToken: 'rotated', accessToken: 'fresh', expiresAt: now() + 3600_000, scope: 's',
    };
    const store = fakeStore({ spotify: stale });
    let rejectFetch: (error: Error) => void = () => {};
    const fetchFn = vi.fn(() => new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    })) as unknown as typeof fetch;
    const svc = makeService({ store, fetchFn, now });

    const refreshing = svc.getAccessToken('spotify');
    store.set('spotify', fresh);
    rejectFetch(new Error('late refresh failure'));

    await expect(refreshing).resolves.toBeNull();
    expect(store.get('spotify')).toEqual(fresh);
  });

  it('getAccessToken: invalid_grant definitively disconnects the provider', async () => {
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

  it.each([
    ['network failure', new TypeError('network unavailable')],
    ['timeout', new DOMException('request timed out', 'TimeoutError')],
  ])('getAccessToken: %s preserves the stored refresh token', async (_label, failure) => {
    const now = () => 1_000_000;
    const stored: StoredToken = {
      refreshToken: 'keep', accessToken: 'stale', expiresAt: now() + 1000, scope: 's',
    };
    const store = fakeStore({ spotify: stored });
    const fetchFn = vi.fn(async () => {
      throw failure;
    }) as unknown as typeof fetch;
    const svc = makeService({ store, fetchFn, now });

    expect(await svc.getAccessToken('spotify')).toBeNull();
    expect(store.get('spotify')).toEqual(stored);
  });

  it('getAccessToken: HTTP 5xx preserves the stored refresh token', async () => {
    const now = () => 1_000_000;
    const stored: StoredToken = {
      refreshToken: 'keep', accessToken: 'stale', expiresAt: now() + 1000, scope: 's',
    };
    const store = fakeStore({ spotify: stored });
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: 'server_error' }, false, 503),
    ) as unknown as typeof fetch;
    const svc = makeService({ store, fetchFn, now });

    expect(await svc.getAccessToken('spotify')).toBeNull();
    expect(store.get('spotify')).toEqual(stored);
  });

  it('getAccessToken: shutdown abort preserves the stored connection', async () => {
    const now = () => 1_000_000;
    const store = fakeStore({
      spotify: { refreshToken: 'keep', accessToken: 'stale', expiresAt: now() + 1000, scope: 's' },
    });
    const fetchFn = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('refresh aborted')), { once: true });
    })) as unknown as typeof fetch;
    const svc = makeService({ store, fetchFn, now });
    const controller = new AbortController();

    const refreshing = svc.getAccessToken('spotify', controller.signal);
    controller.abort();

    await expect(refreshing).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.has('spotify')).toBe(true);
    expect(store.get('spotify')?.refreshToken).toBe('keep');
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

  it('destroy aborts an active connect flow and rejects future connects', async () => {
    const svc = new OAuthConnectionService({
      providers: [spotify],
      tokenStore: fakeStore(),
      fetchFn: (async () => jsonResponse({})) as unknown as typeof fetch,
      openExternal: () => {},
      redirectPort: 0,
    });
    const connecting = svc.connect('spotify');

    await svc.destroy();

    await expect(connecting).rejects.toThrow(/Anwendung wird beendet/);
    await expect(svc.connect('spotify')).rejects.toThrow(/Anwendung wird beendet/);
  });
});
