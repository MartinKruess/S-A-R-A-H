import type { SarahApi } from '../../../../core/sarah-api.js';
import { CODEX_MANAGED_CHATGPT_NOTICE } from '../../../../services/integrations/ai-auth-policy.js';
import { sarahButton } from '../../../components/sarah-button.js';
import { CODEX_DEVICE_LOGIN_URL, managedCodexLoginInput } from './codex-connection-logic.js';

/** Renders explicit, user-triggered managed authentication without starting network work on render. */
export function createCodexConnectionSection(api: SarahApi, refreshHub: (message: string) => void): HTMLElement {
  const root = document.createElement('section');
  root.className = 'ai-provider-card codex-managed-connection';
  const heading = document.createElement('h4');
  heading.textContent = 'Codex mit ChatGPT verbinden';
  const warning = document.createElement('div');
  warning.className = 'ai-provider-warning';
  const warningTitle = document.createElement('h5');
  warningTitle.textContent = CODEX_MANAGED_CHATGPT_NOTICE.title;
  const warningText = document.createElement('p');
  warningText.textContent = CODEX_MANAGED_CHATGPT_NOTICE.text;
  warning.append(warningTitle, warningText);
  const acknowledgement = document.createElement('label');
  acknowledgement.className = 'ai-provider-checkbox';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  const ackText = document.createElement('span');
  ackText.textContent = 'Ich habe den Hinweis zu meinem ChatGPT-Plan und seinen Codex-Limits gelesen und bestätige ihn.';
  acknowledgement.append(checkbox, ackText);
  const feedback = document.createElement('p');
  feedback.setAttribute('role', 'status');
  feedback.textContent = 'Die Anmeldung wird erst gestartet, wenn du sie ausdrücklich auswählst.';
  const device = document.createElement('div');
  const actions = document.createElement('div');
  actions.className = 'ai-provider-actions';
  let busy = false;

  function updateDisabled(): void {
    checkbox.disabled = busy;
    for (const button of [start, status, logout]) {
      if (busy || (button === start && !checkbox.checked)) button.setAttribute('disabled', '');
      else button.removeAttribute('disabled');
    }
  }

  async function run(action: 'start' | 'status' | 'logout'): Promise<void> {
    const input = managedCodexLoginInput(checkbox.checked);
    if (busy || (action === 'start' && !input)) return;
    busy = true;
    updateDisabled();
    try {
      const result = action === 'start' && input ? await api.codexConnection.start(input)
        : action === 'logout' ? await api.codexConnection.logout() : await api.codexConnection.status();
      feedback.textContent = result.message;
      device.replaceChildren();
      if (result.state === 'waiting' && result.verificationUrl === CODEX_DEVICE_LOGIN_URL && result.userCode) {
        const description = document.createElement('p');
        description.textContent = 'Gib diesen Code ausschließlich auf der offiziellen OpenAI-Anmeldeseite ein:';
        const code = document.createElement('code'); code.textContent = result.userCode;
        const open = sarahButton({ label: 'OpenAI-Anmeldeseite öffnen', variant: 'secondary', onClick: () => {
          void api.openExternalUrl(CODEX_DEVICE_LOGIN_URL).catch(() => {
            feedback.textContent = 'Die offizielle Anmeldeseite konnte nicht geöffnet werden.';
          });
        } });
        device.append(description, code, open);
      }
      if (result.state === 'connected' || (action === 'logout' && result.state === 'not_connected')) refreshHub(result.message);
    } catch { feedback.textContent = 'Der Anmeldestatus konnte nicht sicher geändert werden. Bitte prüfe ihn erneut.'; }
    finally { busy = false; updateDisabled(); }
  }

  const start = sarahButton({ label: 'Mit ChatGPT anmelden', disabled: true, onClick: () => { void run('start'); } });
  const status = sarahButton({ label: 'Anmeldestatus prüfen', variant: 'secondary', onClick: () => { void run('status'); } });
  const logout = sarahButton({ label: 'Codex abmelden', variant: 'ghost', onClick: () => { void run('logout'); } });
  checkbox.addEventListener('change', updateDisabled);
  actions.append(start, status, logout);
  root.append(heading, warning, acknowledgement, actions, feedback, device);
  return root;
}
