import { describe, it, expect, vi } from 'vitest';
import { SpotifyActions } from './spotify-actions.js';
import type { OAuthConnectionService } from '../integrations/oauth-connection-service.js';

type FetchFn = typeof fetch;

function fakeOAuth(
  token: string | null,
  failure: 'not-connected' | 'temporarily-unavailable' = 'not-connected',
): OAuthConnectionService {
  return {
    getAccessToken: vi.fn().mockResolvedValue(token),
    getAccessTokenFailure: vi.fn().mockReturnValue(failure),
  } as unknown as OAuthConnectionService;
}

/** Minimal Response-like stub — only the fields SpotifyActions reads. */
function res(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

describe('SpotifyActions.setVolume', () => {
  it('not connected → honest speak, never calls fetch', async () => {
    const fetchFn = vi.fn<FetchFn>();
    const spotify = new SpotifyActions(fakeOAuth(null), fetchFn);
    const result = await spotify.setVolume(50);
    expect(result).toEqual({ ok: false, speak: 'Verbinde Spotify zuerst in den Einstellungen.' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('204 → silent ok, PUTs correct URL with bearer header', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(res(204));
    const spotify = new SpotifyActions(fakeOAuth('tok-123'), fetchFn);
    const result = await spotify.setVolume(49.6);
    expect(result).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.spotify.com/v1/me/player/volume?volume_percent=50',
      { method: 'PUT', headers: { Authorization: 'Bearer tok-123' } },
    );
  });

  it('403 → Premium hint', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(res(403));
    const spotify = new SpotifyActions(fakeOAuth('tok'), fetchFn);
    expect(await spotify.setVolume(30)).toEqual({ ok: false, speak: 'Dafür brauchst du Spotify Premium.' });
  });

  it('404 → no active device', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(res(404));
    const spotify = new SpotifyActions(fakeOAuth('tok'), fetchFn);
    expect(await spotify.setVolume(30)).toEqual({ ok: false, speak: 'Ich sehe gerade kein aktives Spotify-Gerät.' });
  });

  it('401 → reconnect hint', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(res(401));
    const spotify = new SpotifyActions(fakeOAuth('tok'), fetchFn);
    expect(await spotify.setVolume(30)).toEqual({ ok: false, speak: 'Bitte verbinde Spotify neu.' });
  });

  it('network throw → generic speak, does not reject', async () => {
    const fetchFn = vi.fn<FetchFn>().mockRejectedValue(new Error('ECONNRESET'));
    const spotify = new SpotifyActions(fakeOAuth('tok'), fetchFn);
    expect(await spotify.setVolume(30)).toEqual({ ok: false, speak: 'Das hat bei Spotify gerade nicht geklappt.' });
  });

  it('temporary refresh failure does not claim that Spotify is disconnected', async () => {
    const spotify = new SpotifyActions(fakeOAuth(null, 'temporarily-unavailable'), vi.fn<FetchFn>());
    await expect(spotify.setVolume(50)).resolves.toEqual({
      ok: false,
      speak: 'Spotify ist gerade nicht erreichbar. Die Verbindung bleibt gespeichert; versuche es bitte später erneut.',
    });
  });

  it('propagates shutdown abort instead of converting it into a Spotify error', async () => {
    const fetchFn = vi.fn<FetchFn>().mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
    }));
    const spotify = new SpotifyActions(fakeOAuth('tok'), fetchFn);
    const controller = new AbortController();

    const running = spotify.setVolume(30, controller.signal);
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('SpotifyActions.adjustVolume', () => {
  it('not connected → honest speak, never calls fetch', async () => {
    const fetchFn = vi.fn<FetchFn>();
    const spotify = new SpotifyActions(fakeOAuth(null), fetchFn);
    expect(await spotify.adjustVolume(-25)).toEqual({
      ok: false,
      speak: 'Verbinde Spotify zuerst in den Einstellungen.',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads device.volume_percent, adds delta, PUTs the new value', async () => {
    const fetchFn = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(res(200, { device: { volume_percent: 60 } }))
      .mockResolvedValueOnce(res(204));
    const spotify = new SpotifyActions(fakeOAuth('tok'), fetchFn);
    const result = await spotify.adjustVolume(-25);
    expect(result).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenNthCalledWith(1, 'https://api.spotify.com/v1/me/player', {
      method: 'GET',
      headers: { Authorization: 'Bearer tok' },
    });
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://api.spotify.com/v1/me/player/volume?volume_percent=35',
      { method: 'PUT', headers: { Authorization: 'Bearer tok' } },
    );
  });

  it('clamps the target to 0..100 (delta below floor)', async () => {
    const fetchFn = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(res(200, { device: { volume_percent: 10 } }))
      .mockResolvedValueOnce(res(204));
    const spotify = new SpotifyActions(fakeOAuth('tok'), fetchFn);
    await spotify.adjustVolume(-25);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://api.spotify.com/v1/me/player/volume?volume_percent=0',
      expect.anything(),
    );
  });

  it('clamps the target to 0..100 (delta above ceiling)', async () => {
    const fetchFn = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(res(200, { device: { volume_percent: 90 } }))
      .mockResolvedValueOnce(res(204));
    const spotify = new SpotifyActions(fakeOAuth('tok'), fetchFn);
    await spotify.adjustVolume(25);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://api.spotify.com/v1/me/player/volume?volume_percent=100',
      expect.anything(),
    );
  });

  it('204 (no active device) → honest speak, no PUT', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(res(204));
    const spotify = new SpotifyActions(fakeOAuth('tok'), fetchFn);
    expect(await spotify.adjustVolume(-25)).toEqual({
      ok: false,
      speak: 'Ich sehe gerade kein aktives Spotify-Gerät.',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('200 but no device in body → honest speak, no PUT', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(res(200, { device: null }));
    const spotify = new SpotifyActions(fakeOAuth('tok'), fetchFn);
    expect(await spotify.adjustVolume(-25)).toEqual({
      ok: false,
      speak: 'Ich sehe gerade kein aktives Spotify-Gerät.',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
