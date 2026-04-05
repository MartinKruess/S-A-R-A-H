import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahSelect } from '../../components/sarah-select.js';

const TRUST_CSS = `
  .trust-notice {
    padding: var(--sarah-space-md) var(--sarah-space-lg);
    background: rgba(var(--sarah-accent-rgb), 0.05);
    border: 1px solid rgba(var(--sarah-accent-rgb), 0.15);
    border-radius: var(--sarah-radius-md);
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    line-height: 1.5;
  }

  .trust-notice strong {
    color: var(--sarah-accent);
  }
`;

export function createTrustStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = TRUST_CSS;
  container.appendChild(style);

  const notice = document.createElement('div');
  notice.className = 'trust-notice';
  notice.innerHTML = '<strong>🔒 Datenschutz:</strong> Alle Daten werden ausschließlich lokal auf deinem Computer gespeichert. Nichts wird ins Internet gesendet.';

  const form = sarahForm({
    title: 'Vertrauen & Kontrolle',
    description: 'Lege fest, was S.A.R.A.H. darf und was nicht.',
    children: [
      notice,
      sarahToggle({
        label: 'Darf ich mir Dinge merken?',
        description: 'Sarah lernt aus Gesprächen und merkt sich Präferenzen',
        checked: data.trust.memoryAllowed,
        onChange: (value) => { data.trust.memoryAllowed = value; },
      }),
      sarahSelect({
        label: 'Darf ich Dateien analysieren?',
        options: [
          { value: 'all', label: 'Ja, alle Dateien' },
          { value: 'specific-folders', label: 'Nur bestimmte Ordner' },
          { value: 'none', label: 'Nein, keinen Zugriff' },
        ],
        value: data.trust.fileAccess,
        onChange: (value) => { data.trust.fileAccess = value; },
      }),
    ],
  });

  container.appendChild(form);
  return container;
}
