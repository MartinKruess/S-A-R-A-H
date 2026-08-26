// src/services/integrations/oauth-pkce.ts
// Pure, injectable OAuth 2.0 (Authorization Code + PKCE, public client) helpers.
// Built with Node built-ins only (crypto/fetch) — no dependencies, no side effects
// beyond crypto and the injected fetch. See design doc 2026-07-18-integrations-spotify.

import { randomBytes, createHash } from 'crypto';
import type { OAuthProvider } from './providers.js';

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope: string;
};

type FetchFn = typeof fetch;

/** base64 → base64url: `+/`→`-_`, strip `=` padding. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE pair: verifier = base64url(randomBytes(32)), challenge = base64url(sha256(verifier)). */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Anti-CSRF state parameter: base64url(randomBytes(16)). */
export function randomState(): string {
  return base64url(randomBytes(16));
}

/** Build the authorize URL with all params URL-encoded (S256 challenge method). */
export function buildAuthorizeUrl(
  p: OAuthProvider,
  args: { redirectUri: string; state: string; challenge: string },
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: args.redirectUri,
    scope: p.scopes.join(' '),
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: 'S256',
  });
  return `${p.authorizationEndpoint}?${params.toString()}`;
}

/** Map a Spotify/OAuth token JSON response onto OAuthTokens. */
function mapTokens(json: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}): OAuthTokens {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    scope: json.scope ?? '',
  };
}

/** POST a form-encoded body to the token endpoint and parse the token JSON. */
async function postToken(
  tokenEndpoint: string,
  params: URLSearchParams,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  const res = await fetchFn(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token endpoint ${res.status}: ${text}`);
  }
  return mapTokens(await res.json());
}

/** Exchange an authorization code for tokens (grant_type=authorization_code). */
export function exchangeCode(
  p: OAuthProvider,
  args: { code: string; redirectUri: string; verifier: string },
  fetchFn: FetchFn = fetch,
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: p.clientId,
    code_verifier: args.verifier,
  });
  return postToken(p.tokenEndpoint, params, fetchFn);
}

/**
 * Refresh tokens (grant_type=refresh_token). The response `refresh_token` is
 * OPTIONAL — when absent, the returned `refreshToken` is undefined so the caller
 * can keep the existing one (Spotify does not guarantee rotation).
 */
export function refreshTokens(
  p: OAuthProvider,
  refreshToken: string,
  fetchFn: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: p.clientId,
  });
  return postToken(p.tokenEndpoint, params, fetchFn, signal);
}
