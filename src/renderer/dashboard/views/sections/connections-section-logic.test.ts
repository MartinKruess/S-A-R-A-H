import { describe, it, expect, vi } from 'vitest';
import { toRowView, performAction } from './connections-section-logic.js';
import type { ConnectionInfo, SarahConnectionsApi } from '../../../../core/sarah-api.js';

const CONNECTED: ConnectionInfo = {
  id: 'spotify', displayName: 'Spotify', configured: true, connected: true, expiresAt: 42,
};
const DISCONNECTED: ConnectionInfo = {
  id: 'spotify', displayName: 'Spotify', configured: true, connected: false,
};

/** Stub of `window.sarah.connections`; `list` returns the given snapshots in order. */
function stubConnections(snapshots: ConnectionInfo[][]): SarahConnectionsApi {
  const list = vi.fn(async () => snapshots.shift() ?? []);
  return {
    list,
    connect: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  };
}

describe('connections-section-logic — toRowView', () => {
  it('maps a connected provider to the green "Verbunden" badge and "Trennen" button', () => {
    const view = toRowView(CONNECTED);
    expect(view.badgeText).toBe('Verbunden');
    expect(view.badgeState).toBe('connected');
    expect(view.buttonLabel).toBe('Trennen');
    expect(view.buttonDisabled).toBe(false);
    expect(view.displayName).toBe('Spotify');
  });

  it('maps a disconnected provider to the muted "Nicht verbunden" badge and "Verbinden" button', () => {
    const view = toRowView(DISCONNECTED);
    expect(view.badgeText).toBe('Nicht verbunden');
    expect(view.badgeState).toBe('disconnected');
    expect(view.buttonLabel).toBe('Verbinden');
  });

  it('surfaces a degraded token store and disables destructive overwrite paths', () => {
    const view = toRowView({
      ...DISCONNECTED,
      storageState: 'degraded',
      storageError: 'Token-Datei beschädigt',
    });

    expect(view.badgeText).toBe('Speicherfehler');
    expect(view.badgeState).toBe('error');
    expect(view.buttonLabel).toBe('Nicht verfügbar');
    expect(view.buttonDisabled).toBe(true);
    expect(view.errorMessage).toBe('Token-Datei beschädigt');
  });

  it('distinguishes a temporary provider outage from a disconnected account', () => {
    const view = toRowView({ ...CONNECTED, temporaryError: 'Spotify antwortet gerade nicht.' });
    expect(view.badgeText).toBe('Vorübergehend nicht erreichbar');
    expect(view.badgeState).toBe('error');
    expect(view.connected).toBe(true);
    expect(view.errorMessage).toBe('Spotify antwortet gerade nicht.');
  });

  it('shows an unconfigured provider as unavailable with a user-facing explanation', () => {
    const view = toRowView({
      ...DISCONNECTED,
      configured: false,
      configurationError: 'Spotify ist in dieser Installation noch nicht eingerichtet.',
    });

    expect(view.badgeText).toBe('Nicht eingerichtet');
    expect(view.badgeState).toBe('error');
    expect(view.buttonLabel).toBe('Nicht verfügbar');
    expect(view.buttonDisabled).toBe(true);
    expect(view.errorMessage).toBe('Spotify ist in dieser Installation noch nicht eingerichtet.');
  });
});

describe('connections-section-logic — performAction', () => {
  it('connect: calls connect then re-fetches the list', async () => {
    const api = stubConnections([[CONNECTED]]);
    const { list, error } = await performAction(api, 'connect', 'spotify');

    expect(api.connect).toHaveBeenCalledWith('spotify');
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(error).toBeUndefined();
    expect(list).toEqual([CONNECTED]);
  });

  it('connect failure: surfaces the error text and still re-fetches', async () => {
    const api = stubConnections([[DISCONNECTED]]);
    (api.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'Port belegt' });

    const { list, error } = await performAction(api, 'connect', 'spotify');

    expect(error).toBe('Port belegt');
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(list).toEqual([DISCONNECTED]);
  });

  it('connect failure without error text falls back to a German default', async () => {
    const api = stubConnections([[DISCONNECTED]]);
    (api.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false });

    const { error } = await performAction(api, 'connect', 'spotify');
    expect(error).toBe('Verbindung fehlgeschlagen.');
  });

  it('disconnect: calls disconnect then re-fetches; never touches connect', async () => {
    const api = stubConnections([[DISCONNECTED]]);
    const { list, error } = await performAction(api, 'disconnect', 'spotify');

    expect(api.disconnect).toHaveBeenCalledWith('spotify');
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(error).toBeUndefined();
    expect(list).toEqual([DISCONNECTED]);
  });
});
