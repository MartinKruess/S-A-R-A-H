// src/services/integrations/providers.ts
// Provider registry for the generic OAuth "Integrationen" layer.
// V1 registers Spotify only; the shape is designed so more providers can be
// appended later (and a future `type: 'oauth' | 'apiKey'` field added) without rework.

export interface OAuthProvider {
  id: string;
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  clientId: string;
}

/** Loopback redirect port. Fixed by default (Spotify requires an exact pre-registered URI). */
export function redirectPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.SPOTIFY_REDIRECT_PORT) || 8888;
}

/** Loopback redirect URI. Uses 127.0.0.1 (not `localhost`) as Spotify requires. */
export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

/** Build the provider registry from env so tests can inject their own values. */
export function getOAuthProviders(env: NodeJS.ProcessEnv = process.env): OAuthProvider[] {
  return [
    {
      id: 'spotify',
      displayName: 'Spotify',
      authorizationEndpoint: 'https://accounts.spotify.com/authorize',
      tokenEndpoint: 'https://accounts.spotify.com/api/token',
      scopes: ['user-modify-playback-state', 'user-read-playback-state'],
      clientId: env.SPOTIFY_CLIENT_ID ?? '',
    },
  ];
}
