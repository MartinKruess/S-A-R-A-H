import type { WizardData } from '../wizard.js';

const FINISH_CSS = `
  .finish {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sarah-space-lg);
    max-width: 500px;
    text-align: center;
  }

  .finish-title {
    font-size: var(--sarah-font-size-xl);
    font-weight: 300;
    color: var(--sarah-text-primary);
    letter-spacing: 0.05em;
  }

  .finish-text {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-secondary);
    line-height: 1.5;
  }

  .summary {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-sm);
    padding: var(--sarah-space-lg);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-lg);
  }

  .summary-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--sarah-space-xs) 0;
  }

  .summary-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .summary-value {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-primary);
  }

  .accent-preview {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: inline-block;
    vertical-align: middle;
    margin-left: var(--sarah-space-sm);
    box-shadow: 0 0 8px currentColor;
  }
`;

export function createFinishStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = FINISH_CSS;
  container.appendChild(style);

  const finish = document.createElement('div');
  finish.className = 'finish';

  const title = document.createElement('div');
  title.className = 'finish-title';
  title.textContent = 'Alles bereit!';

  const text = document.createElement('div');
  text.className = 'finish-text';
  text.textContent = 'Hier ist eine Zusammenfassung deiner Einstellungen. Du kannst jederzeit zurückgehen und etwas ändern.';

  const summary = document.createElement('div');
  summary.className = 'summary';

  const rows: { label: string; value: string }[] = [
    { label: 'Name', value: data.profile.displayName || '—' },
    { label: 'Stadt', value: data.profile.city || '—' },
    { label: 'Sprache', value: data.profile.language },
    { label: 'Zeitzone', value: data.profile.timezone },
    { label: 'System', value: data.system.os || '—' },
    { label: 'CPU', value: data.system.cpu || '—' },
    { label: 'RAM', value: data.system.totalMemory || '—' },
  ];

  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'summary-row';

    const label = document.createElement('span');
    label.className = 'summary-label';
    label.textContent = row.label;

    const value = document.createElement('span');
    value.className = 'summary-value';
    value.textContent = row.value;

    rowEl.appendChild(label);
    rowEl.appendChild(value);
    summary.appendChild(rowEl);
  }

  // Accent color row
  const colorRow = document.createElement('div');
  colorRow.className = 'summary-row';
  const colorLabel = document.createElement('span');
  colorLabel.className = 'summary-label';
  colorLabel.textContent = 'Akzentfarbe';
  const colorValue = document.createElement('span');
  colorValue.className = 'summary-value';
  const colorDot = document.createElement('span');
  colorDot.className = 'accent-preview';
  colorDot.style.backgroundColor = data.personalization.accentColor;
  colorDot.style.color = data.personalization.accentColor;
  colorValue.textContent = data.personalization.accentColor;
  colorValue.appendChild(colorDot);
  colorRow.appendChild(colorLabel);
  colorRow.appendChild(colorValue);
  summary.appendChild(colorRow);

  finish.appendChild(title);
  finish.appendChild(text);
  finish.appendChild(summary);
  container.appendChild(finish);

  return container;
}
