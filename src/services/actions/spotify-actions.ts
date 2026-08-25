// src/services/actions/spotify-actions.ts
// Spotify per-app volume actions (Main). Plain class like SystemActions; gets the
// generic OAuthConnectionService injected and talks to the Spotify Web API.
// `fetch` is injectable for tests. Only volume is in V1 (Spec Integrationen V1).

import type { LaunchResult } from '../../main/program-launcher.js';
import type { OAuthConnectionService } from '../integrations/oauth-connection-service.js';
import { abortError, throwIfAborted } from '../../core/abort-utils.js';

type FetchFn = typeof fetch;

const API_BASE = 'https://api.spotify.com/v1';

/** No token yet — the router already routed here, so speak the honest hint. */
const NOT_CONNECTED: LaunchResult = {
  ok: false,
  speak: 'Verbinde Spotify zuerst in den Einstellungen.',
};

const NO_DEVICE: LaunchResult = {
  ok: false,
  speak: 'Ich sehe gerade kein aktives Spotify-Gerät.',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Map a Spotify HTTP status to an honest German LaunchResult. */
function statusToResult(status: number): LaunchResult {
  if (status === 200 || status === 204) return { ok: true };
  if (status === 401) return { ok: false, speak: 'Bitte verbinde Spotify neu.' };
  if (status === 403) return { ok: false, speak: 'Dafür brauchst du Spotify Premium.' };
  if (status === 404) return NO_DEVICE;
  return { ok: false, speak: 'Das hat bei Spotify gerade nicht geklappt.' };
}

export class SpotifyActions {
  constructor(
    private oauth: OAuthConnectionService,
    private fetchFn: FetchFn = fetch,
  ) {}

  /** Absolute volume ("Musik auf 50"). */
  async setVolume(percent: number, signal?: AbortSignal): Promise<LaunchResult> {
    throwIfAborted(signal);
    const token = await this.oauth.getAccessToken('spotify', signal);
    throwIfAborted(signal);
    if (token === null) return NOT_CONNECTED;
    return this.putVolume(token, Math.round(percent), signal);
  }

  /** Relative volume ("Spotify leiser" → -25): read current, clamp, then set. */
  async adjustVolume(delta: number, signal?: AbortSignal): Promise<LaunchResult> {
    throwIfAborted(signal);
    const token = await this.oauth.getAccessToken('spotify', signal);
    throwIfAborted(signal);
    if (token === null) return NOT_CONNECTED;

    try {
      const res = await this.fetchFn(`${API_BASE}/me/player`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        ...(signal ? { signal } : {}),
      });
      if (res.status === 204) return NO_DEVICE;
      if (!res.ok) return statusToResult(res.status);

      const body = await this.readJson(res);
      const device = body?.device;
      if (!device || typeof device.volume_percent !== 'number') return NO_DEVICE;

      const target = clamp(device.volume_percent + delta, 0, 100);
      return this.putVolume(token, target, signal);
    } catch (err) {
      if (signal?.aborted) throw abortError();
      console.warn('[SpotifyActions] adjustVolume failed:', (err as Error).message);
      return { ok: false, speak: 'Das hat bei Spotify gerade nicht geklappt.' };
    }
  }

  private async putVolume(token: string, percent: number, signal?: AbortSignal): Promise<LaunchResult> {
    try {
      const res = await this.fetchFn(
        `${API_BASE}/me/player/volume?volume_percent=${percent}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
          ...(signal ? { signal } : {}),
        },
      );
      return statusToResult(res.status);
    } catch (err) {
      if (signal?.aborted) throw abortError();
      console.warn('[SpotifyActions] setVolume failed:', (err as Error).message);
      return { ok: false, speak: 'Das hat bei Spotify gerade nicht geklappt.' };
    }
  }

  /** Tolerant JSON read — an empty body (e.g. 200 with no content) yields null. */
  private async readJson(res: Response): Promise<{ device?: { volume_percent?: number } } | null> {
    try {
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}
