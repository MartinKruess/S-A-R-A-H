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

export type OAuthTokenErrorDisposition = 'definitive' | 'retryable';

/** Typed failure contract used to decide whether a stored refresh token is invalid. */
export class OAuthTokenEndpointError extends Error {
  readonly name = 'OAuthTokenEndpointError';

  constructor(
    message: string,
    readonly disposition: OAuthTokenErrorDisposition,
    readonly status?: number,
    readonly oauthError?: string,
  ) {
    super(message);
  }
}

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

/** Validate and map an untrusted OAuth token response. */
function mapTokens(json: object | null): OAuthTokens {
  if (json === null || Array.isArray(json)) {
    throw new OAuthTokenEndpointError('Token endpoint returned an invalid response', 'retryable');
  }
  const candidate = json as Partial<Record<
    'access_token' | 'refresh_token' | 'expires_in' | 'scope',
    object | string | number | null
  >>;
  if (
    typeof candidate.access_token !== 'string' ||
    candidate.access_token.trim().length === 0 ||
    typeof candidate.expires_in !== 'number' ||
    !Number.isSafeInteger(candidate.expires_in) ||
    candidate.expires_in <= 0 ||
    candidate.expires_in > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ||
    (candidate.refresh_token !== undefined &&
      (typeof candidate.refresh_token !== 'string' || candidate.refresh_token.trim().length === 0)) ||
    (candidate.scope !== undefined && typeof candidate.scope !== 'string')
  ) {
    throw new OAuthTokenEndpointError('Token endpoint returned an invalid response', 'retryable');
  }
  return {
    accessToken: candidate.access_token,
    refreshToken: candidate.refresh_token,
    expiresIn: candidate.expires_in,
    scope: candidate.scope ?? '',
  };
}

function oauthErrorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as object | null;
    if (parsed === null || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Partial<Record<'error', object | string | number | null>>;
    return typeof candidate.error === 'string' && candidate.error.trim()
      ? candidate.error
      : undefined;
  } catch {
    return undefined;
  }
}

function isDefinitiveOAuthRejection(status: number, code: string | undefined): boolean {
  return (status === 400 || status === 401) &&
    (code === 'invalid_grant' || code === 'invalid_client');
}

/** POST a form-encoded body to the token endpoint and parse the token JSON. */
async function postToken(
  tokenEndpoint: string,
  params: URLSearchParams,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  let res: Response;
  try {
    res = await fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown transport failure';
    throw new OAuthTokenEndpointError(`Token endpoint request failed: ${detail}`, 'retryable');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = oauthErrorCode(text);
    const disposition = isDefinitiveOAuthRejection(res.status, code) ? 'definitive' : 'retryable';
    throw new OAuthTokenEndpointError(
      `Token endpoint ${res.status}${code ? `: ${code}` : ''}`,
      disposition,
      res.status,
      code,
    );
  }
  try {
    return mapTokens(await res.json() as object | null);
  } catch (error) {
    if (error instanceof OAuthTokenEndpointError) throw error;
    throw new OAuthTokenEndpointError('Token endpoint returned invalid JSON', 'retryable');
  }
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
