import { sarahButton } from '../../../components/sarah-button.js';
import { createSectionHeader, createHint } from '../../../shared/settings-utils.js';
import { getSarah } from '../../../shared/window-global.js';
import { toRowView, performAction } from './connections-section-logic.js';
import type { ConnectionInfo } from '../../../../core/sarah-api.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

/**
 * "Integrationen" settings section: lists every OAuth provider with a status
 * badge and a connect/disconnect button. All UI text is German. Node-free —
 * talks only to the `sarah` global.
 */
export function createConnectionsSection(_config: SarahConfig): HTMLElement {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header } = createSectionHeader('Integrationen');
  section.appendChild(header);

  section.appendChild(
    createHint('Verbinde externe Dienste, damit Sarah sie steuern kann — z. B. die Spotify-Lautstärke.'),
  );

  const list = document.createElement('div');
  list.className = 'conn-list';
  section.appendChild(list);

  const errorBox = document.createElement('div');
  errorBox.className = 'conn-error';
  errorBox.hidden = true;
  section.appendChild(errorBox);

  const connections = getSarah().connections;

  function showError(message: string): void {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError(): void {
    errorBox.textContent = '';
    errorBox.hidden = true;
  }

  function render(infos: ConnectionInfo[]): void {
    list.replaceChildren();
    for (const info of infos) {
      list.appendChild(createRow(info));
    }
  }

  function createRow(info: ConnectionInfo): HTMLElement {
    const view = toRowView(info);

    const row = document.createElement('div');
    row.className = 'conn-row';

    const name = document.createElement('span');
    name.className = 'conn-name';
    name.textContent = view.displayName;
    row.appendChild(name);

    const status = document.createElement('span');
    status.className = `conn-status conn-status--${view.badgeState}`;
    status.textContent = view.badgeText;
    row.appendChild(status);

    const button = sarahButton({
      label: view.buttonLabel,
      variant: view.connected ? 'secondary' : 'primary',
      onClick: () => {
        void handleAction(view.connected ? 'disconnect' : 'connect', info.id, button);
      },
    });
    row.appendChild(button);

    return row;
  }

  async function handleAction(
    action: 'connect' | 'disconnect',
    id: string,
    button: HTMLElement,
  ): Promise<void> {
    clearError();
    button.setAttribute('disabled', '');
    try {
      const { list: fresh, error } = await performAction(connections, action, id);
      if (error) showError(error);
      render(fresh);
    } catch (err) {
      showError((err as Error).message);
    }
  }

  // Initial load (fire-and-forget — the section element is returned synchronously).
  void (async (): Promise<void> => {
    try {
      render(await connections.list());
    } catch (err) {
      showError((err as Error).message);
    }
  })();

  return section;
}
