import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import {
  generatePkce,
  randomState,
  buildAuthorizeUrl,
  exchangeCode,
  OAuthTokenEndpointError,
  refreshTokens,
} from '../../../src/services/integrations/oauth-pkce.js';
import type { OAuthProvider } from '../../../src/services/integrations/providers.js';

const provider: OAuthProvider = {
  id: 'spotify',
  displayName: 'Spotify',
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
  scopes: ['user-modify-playback-state', 'user-read-playback-state'],
  clientId: 'client-123',
};

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isBase64url = (s: string): boolean => /^[A-Za-z0-9_-]+$/.test(s);

function mockJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('oauth-pkce', () => {
  it('generatePkce: verifier/challenge are base64url and challenge = base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkce();
    expect(isBase64url(verifier)).toBe(true);
    expect(isBase64url(challenge)).toBe(true);
    expect(verifier).not.toMatch(/[+/=]/);
    expect(challenge).not.toMatch(/[+/=]/);
    const expected = base64url(createHash('sha256').update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it('randomState: base64url with no padding chars', () => {
    const state = randomState();
    expect(isBase64url(state)).toBe(true);
    expect(state).not.toMatch(/[+/=]/);
  });

  it('buildAuthorizeUrl: contains all params, URL-encoded, S256', () => {
    const url = new URL(
      buildAuthorizeUrl(provider, { redirectUri: 'http://127.0.0.1:8888/callback', state: 'st/+ate', challenge: 'chal' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('client-123');
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:8888/callback');
    expect(p.get('scope')).toBe('user-modify-playback-state user-read-playback-state');
    expect(p.get('state')).toBe('st/+ate');
    expect(p.get('code_challenge')).toBe('chal');
    expect(p.get('code_challenge_method')).toBe('S256');
    // scope space must be encoded in the raw query string
    expect(url.search).toContain('scope=user-modify-playback-state+user-read-playback-state');
  });

  it('exchangeCode: posts the right form body and maps fields', async () => {
    const fetchFn = vi.fn(async () =>
      mockJsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'a b' }),
    ) as unknown as typeof fetch;

    const tokens = await exchangeCode(
      provider,
      { code: 'the-code', redirectUri: 'http://127.0.0.1:8888/callback', verifier: 'ver' },
      fetchFn,
    );

    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, scope: 'a b' });
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:8888/callback');
    expect(body.get('client_id')).toBe('client-123');
    expect(body.get('code_verifier')).toBe('ver');
  });

  it('exchangeCode: throws with response body text on non-2xx', async () => {
    const fetchFn = vi.fn(async () =>
      mockJsonResponse({ error: 'invalid_grant' }, false, 400),
    ) as unknown as typeof fetch;
    await expect(
      exchangeCode(provider, { code: 'x', redirectUri: 'r', verifier: 'v' }, fetchFn),
    ).rejects.toThrow(/400.*invalid_grant/);
  });

  it.each(['invalid_grant', 'invalid_client'])(
    'classifies OAuth error %s as a definitive rejection',
    async (oauthError) => {
      const fetchFn = vi.fn(async () =>
        mockJsonResponse({ error: oauthError }, false, 400),
      ) as unknown as typeof fetch;

      await expect(refreshTokens(provider, 'refresh', fetchFn)).rejects.toMatchObject({
        name: 'OAuthTokenEndpointError',
        disposition: 'definitive',
        status: 400,
        oauthError,
      } satisfies Partial<OAuthTokenEndpointError>);
    },
  );

  it('classifies HTTP 5xx as retryable even when the body contains an OAuth error', async () => {
    const fetchFn = vi.fn(async () =>
      mockJsonResponse({ error: 'invalid_grant' }, false, 503),
    ) as unknown as typeof fetch;

    await expect(refreshTokens(provider, 'refresh', fetchFn)).rejects.toMatchObject({
      disposition: 'retryable',
      status: 503,
    } satisfies Partial<OAuthTokenEndpointError>);
  });

  it.each([
    ['missing access token', { refresh_token: 'rt', expires_in: 3600 }],
    ['empty access token', { access_token: ' ', refresh_token: 'rt', expires_in: 3600 }],
    ['missing expiry', { access_token: 'at', refresh_token: 'rt' }],
    ['non-numeric expiry', { access_token: 'at', refresh_token: 'rt', expires_in: '3600' }],
    ['non-positive expiry', { access_token: 'at', refresh_token: 'rt', expires_in: 0 }],
    ['invalid refresh token', { access_token: 'at', refresh_token: null, expires_in: 3600 }],
    ['invalid scope', { access_token: 'at', refresh_token: 'rt', expires_in: ['scope'] }],
  ])('rejects a 2xx token response with %s', async (_label, body) => {
    const fetchFn = vi.fn(async () => mockJsonResponse(body)) as unknown as typeof fetch;

    await expect(
      exchangeCode(provider, { code: 'x', redirectUri: 'r', verifier: 'v' }, fetchFn),
    ).rejects.toThrow('invalid response');
  });

  it('refreshTokens: posts grant_type=refresh_token and maps fields', async () => {
    const fetchFn = vi.fn(async () =>
      mockJsonResponse({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, scope: 's' }),
    ) as unknown as typeof fetch;

    const tokens = await refreshTokens(provider, 'old-refresh', fetchFn);
    expect(tokens.accessToken).toBe('at2');
    expect(tokens.refreshToken).toBe('rt2');

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
    expect(body.get('client_id')).toBe('client-123');
  });

  it('refreshTokens: response without refresh_token → refreshToken undefined', async () => {
    const fetchFn = vi.fn(async () =>
      mockJsonResponse({ access_token: 'at3', expires_in: 3600, scope: 's' }),
    ) as unknown as typeof fetch;
    const tokens = await refreshTokens(provider, 'old-refresh', fetchFn);
    expect(tokens.accessToken).toBe('at3');
    expect(tokens.refreshToken).toBeUndefined();
  });
});
