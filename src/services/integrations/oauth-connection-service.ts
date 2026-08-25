// src/services/integrations/oauth-connection-service.ts
// Generic OAuth connection service (Main). Plain class (not a SarahService) —
// called via IPC and by SpotifyActions. Drives the PKCE authorize/callback
// loopback flow and hands out fresh access tokens (refreshing on demand).
// All external dependencies are injectable for testability.

import * as http from 'http';
import type { OAuthProvider } from './providers.js';
import { redirectUri as buildRedirectUri } from './providers.js';
import type { TokenStore, StoredToken } from './token-store.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  randomState,
  refreshTokens,
} from './oauth-pkce.js';
import { abortError, throwIfAborted } from '../../core/abort-utils.js';

type FetchFn = typeof fetch;

export type ConnectionInfo = {
  id: string;
  displayName: string;
  connected: boolean;
  expiresAt?: number;
};

/** Access tokens are refreshed this many ms before their actual expiry. */
const REFRESH_SKEW_MS = 60_000;
/** Abort the connect flow if no callback arrives within this window. */
const CONNECT_TIMEOUT_MS = 5 * 60_000;

const SUCCESS_HTML =
  '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
  '<title>Verbunden</title></head><body style="font-family:system-ui;text-align:center;padding:3rem">' +
  '<h1>Verbunden</h1><p>Du kannst dieses Fenster schließen.</p></body></html>';

export interface OAuthConnectionServiceDeps {
  providers: OAuthProvider[];
  tokenStore: TokenStore;
  fetchFn?: FetchFn;
  openExternal?: (url: string) => void | Promise<void>;
  now?: () => number;
  redirectPort: number;
}

export class OAuthConnectionService {
  private providers: OAuthProvider[];
  private tokenStore: TokenStore;
  private fetchFn: FetchFn;
  private openExternal: (url: string) => void | Promise<void>;
  private now: () => number;
  private redirectPort: number;
  /** Provider ids with a connect flow in progress — prevents a second loopback bind. */
  private readonly connecting = new Set<string>();
  /** Active loopback flows, cancelled during application shutdown. */
  private readonly activeConnections = new Map<string, (error: Error) => Promise<void>>();
  private destroyed = false;

  constructor(deps: OAuthConnectionServiceDeps) {
    this.providers = deps.providers;
    this.tokenStore = deps.tokenStore;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.openExternal =
      deps.openExternal ??
      ((url: string) => {
        // Lazy, guarded electron import — keeps this class usable in plain Node/tests.
        const { shell } = require('electron');
        return shell.openExternal(url);
      });
    this.now = deps.now ?? (() => Date.now());
    this.redirectPort = deps.redirectPort;
  }

  private provider(id: string): OAuthProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  private toInfo(p: OAuthProvider): ConnectionInfo {
    const stored = this.tokenStore.get(p.id);
    return {
      id: p.id,
      displayName: p.displayName,
      connected: stored !== undefined,
      expiresAt: stored?.expiresAt,
    };
  }

  listConnections(): ConnectionInfo[] {
    return this.providers.map((p) => this.toInfo(p));
  }

  getStatus(id: string): ConnectionInfo | undefined {
    const p = this.provider(id);
    return p ? this.toInfo(p) : undefined;
  }

  /**
   * Return a valid access token for the provider, refreshing when it is within
   * the expiry skew. Missing token, unconfigured provider (empty clientId), or a
   * failed refresh → null (a failed refresh also disconnects the provider).
   */
  async getAccessToken(id: string, signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal);
    const p = this.provider(id);
    if (!p || !p.clientId) return null;

    const stored = this.tokenStore.get(id);
    if (!stored) return null;

    if (stored.expiresAt - this.now() > REFRESH_SKEW_MS) {
      return stored.accessToken;
    }

    try {
      const tokens = await refreshTokens(p, stored.refreshToken, this.fetchFn, signal);
      const updated: StoredToken = {
        // Keep the existing refresh token unless the response rotated it.
        refreshToken: tokens.refreshToken ?? stored.refreshToken,
        accessToken: tokens.accessToken,
        expiresAt: this.now() + tokens.expiresIn * 1000,
        scope: tokens.scope || stored.scope,
      };
      this.tokenStore.set(id, updated);
      return updated.accessToken;
    } catch (err) {
      if (signal?.aborted) throw abortError();
      console.warn(`[OAuth] refresh failed for '${id}', disconnecting:`, (err as Error).message);
      this.tokenStore.delete(id);
      return null;
    }
  }

  async disconnect(id: string): Promise<void> {
    this.tokenStore.delete(id);
  }

  /**
   * Run the interactive Authorization Code + PKCE flow: start a loopback server,
   * open the system browser, capture the callback, exchange the code, persist
   * tokens. Rejects on state mismatch, timeout, or any error (server always closed).
   */
  async connect(id: string): Promise<void> {
    if (this.destroyed) throw new Error('Die Anwendung wird beendet. Verbindung abgebrochen.');
    const p = this.provider(id);
    if (!p) throw new Error(`Unbekannter Dienst: ${id}`);
    if (!p.clientId) {
      throw new Error('SPOTIFY_CLIENT_ID fehlt — App im Spotify-Dashboard anlegen und Client-ID setzen.');
    }
    if (this.connecting.has(id)) {
      throw new Error('Die Verbindung läuft bereits — bitte schließe zuerst den Browser-Login ab.');
    }
    this.connecting.add(id);

    const { verifier, challenge } = generatePkce();
    const state = randomState();
    const redirectUri = buildRedirectUri(this.redirectPort);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const server = http.createServer();

      const closeServer = (): Promise<void> => new Promise((closeResolve) => {
        if (!server.listening) {
          closeResolve();
          return;
        }
        server.close(() => closeResolve());
      });

      const finish = async (err?: Error): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connecting.delete(id);
        this.activeConnections.delete(id);
        await closeServer();
        if (err) reject(err);
        else resolve();
      };

      this.activeConnections.set(id, async (error) => finish(error));

      const timer = setTimeout(() => {
        void finish(new Error('Zeitüberschreitung bei der Verbindung — bitte erneut versuchen.'));
      }, CONNECT_TIMEOUT_MS);

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Dev-only detail (the shipped app ships a fixed port) — log for the
          // developer, but show the user a plain, non-technical message.
          console.warn(
            `[OAuth] loopback port ${this.redirectPort} busy — set SPOTIFY_REDIRECT_PORT to a free port and register it in the provider dashboard.`,
          );
          void finish(new Error('Die Verbindung ließ sich gerade nicht starten. Bitte versuche es erneut.'));
        } else {
          void finish(err);
        }
      });

      server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.redirectPort}`);
        if (url.pathname !== '/callback') {
          res.statusCode = 404;
          res.end();
          return;
        }

        const respond = (status: number, body: string): void => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(body);
        };

        void (async (): Promise<void> => {
          try {
            const returnedState = url.searchParams.get('state');
            const code = url.searchParams.get('code');
            const oauthError = url.searchParams.get('error');
            if (oauthError) throw new Error(`Spotify hat die Verbindung abgelehnt: ${oauthError}`);
            if (returnedState !== state) throw new Error('State stimmt nicht überein (möglicher CSRF).');
            if (!code) throw new Error('Kein Autorisierungscode empfangen.');

            const tokens = await exchangeCode(p, { code, redirectUri, verifier }, this.fetchFn);
            if (!tokens.refreshToken) throw new Error('Kein Refresh-Token erhalten.');

            this.tokenStore.set(id, {
              refreshToken: tokens.refreshToken,
              accessToken: tokens.accessToken,
              expiresAt: this.now() + tokens.expiresIn * 1000,
              scope: tokens.scope,
            });

            respond(200, SUCCESS_HTML);
            await finish();
          } catch (err) {
            respond(400, '<!doctype html><meta charset="utf-8"><p>Verbindung fehlgeschlagen.</p>');
            await finish(err as Error);
          }
        })();
      });

      server.listen(this.redirectPort, '127.0.0.1', () => {
        Promise.resolve(this.openExternal(buildAuthorizeUrl(p, { redirectUri, state, challenge }))).catch(
          (err: Error) => { void finish(err); },
        );
      });
    });
  }

  /**
   * Abort active loopback authorization flows and release their ports.
   * Stored provider tokens remain untouched.
   *
   * @category External Integration
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const error = new Error('Die Anwendung wird beendet. Verbindung abgebrochen.');
    await Promise.allSettled(
      [...this.activeConnections.values()].map((cancel) => cancel(error)),
    );
    this.activeConnections.clear();
    this.connecting.clear();
  }
}
