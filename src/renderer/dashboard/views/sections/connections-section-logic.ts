// src/renderer/dashboard/views/sections/connections-section-logic.ts
// Pure, DOM-free logic for the "Integrationen" connections section, split out so
// it is testable in the node vitest environment (no jsdom). Mirrors the
// logic/render split used by sarah-tabs-logic / audio-bridge-logic.

import type { ConnectionInfo, SarahConnectionsApi } from '../../../../core/sarah-api.js';

/** View-model for a single connection row (German UI labels). */
export interface ConnectionRowView {
  id: string;
  displayName: string;
  connected: boolean;
  badgeText: string;
  /** Modifier suffix for the badge CSS class. */
  badgeState: 'connected' | 'disconnected' | 'error';
  buttonLabel: string;
  buttonDisabled: boolean;
  errorMessage?: string;
}

/** Map raw connection status to a German-labelled row view-model. */
export function toRowView(info: ConnectionInfo): ConnectionRowView {
  if (info.storageState === 'degraded') {
    return {
      id: info.id,
      displayName: info.displayName,
      connected: false,
      badgeText: 'Speicherfehler',
      badgeState: 'error',
      buttonLabel: 'Nicht verfügbar',
      buttonDisabled: true,
      errorMessage: info.storageError ?? 'Der Verbindungsspeicher ist nicht lesbar.',
    };
  }
  if (!info.configured) {
    return {
      id: info.id,
      displayName: info.displayName,
      connected: false,
      badgeText: 'Nicht eingerichtet',
      badgeState: 'error',
      buttonLabel: 'Nicht verfügbar',
      buttonDisabled: true,
      errorMessage: info.configurationError
        ?? `${info.displayName} ist in dieser Installation noch nicht eingerichtet.`,
    };
  }
  if (info.temporaryError) {
    return {
      id: info.id,
      displayName: info.displayName,
      connected: true,
      badgeText: 'Vorübergehend nicht erreichbar',
      badgeState: 'error',
      buttonLabel: 'Trennen',
      buttonDisabled: false,
      errorMessage: info.temporaryError,
    };
  }
  return {
    id: info.id,
    displayName: info.displayName,
    connected: info.connected,
    badgeText: info.connected ? 'Verbunden' : 'Nicht verbunden',
    badgeState: info.connected ? 'connected' : 'disconnected',
    buttonLabel: info.connected ? 'Trennen' : 'Verbinden',
    buttonDisabled: false,
    errorMessage: info.storageState === 'recovered' ? info.storageError : undefined,
  };
}

/**
 * Perform a connect/disconnect against the connections API and always re-fetch
 * the fresh list afterwards. A failed connect ({ ok:false }) surfaces its error
 * text (German, from main) without throwing — the list is still re-fetched so the
 * UI reflects the true state.
 */
export async function performAction(
  api: SarahConnectionsApi,
  action: 'connect' | 'disconnect',
  id: string,
): Promise<{ list: ConnectionInfo[]; error?: string }> {
  let error: string | undefined;
  if (action === 'connect') {
    const result = await api.connect(id);
    if (!result.ok) {
      error = result.error ?? 'Verbindung fehlgeschlagen.';
    }
  } else {
    await api.disconnect(id);
  }
  const list = await api.list();
  return { list, error };
}
