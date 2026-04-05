import type { WizardData } from '../wizard.js';

const FINISH_CSS = `
  .finish {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sarah-space-lg);
    max-width: 550px;
    text-align: center;
    overflow-y: auto;
    max-height: 100%;
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

  .summary-section {
    width: 100%;
    text-align: left;
  }

  .summary-heading {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: var(--sarah-space-sm);
    margin-top: var(--sarah-space-md);
  }

  .summary {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-xs);
    padding: var(--sarah-space-md) var(--sarah-space-lg);
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
  }

  .summary-value {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-primary);
    text-align: right;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .summary-skipped {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    font-style: italic;
    padding: var(--sarah-space-sm) var(--sarah-space-lg);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-lg);
    width: 100%;
    text-align: left;
  }

  .accent-preview {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: inline-block;
    vertical-align: middle;
    margin-left: var(--sarah-space-sm);
    box-shadow: 0 0 6px currentColor;
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
  text.textContent = 'Hier ist eine Zusammenfassung deiner Einstellungen.';

  finish.appendChild(title);
  finish.appendChild(text);

  // Required fields
  addSection(finish, 'Pflichtfelder', [
    ['Name', data.profile.displayName || '—'],
    ['Stadt', data.profile.city || '—'],
    ['Verwendungszwecke', data.profile.usagePurposes.join(', ') || '—'],
  ]);

  // Personal (optional)
  if (data.skippedSteps.has('personal')) {
    addSkipped(finish, 'Persönliches', 'Übersprungen — kannst du jederzeit in den Einstellungen nachholen');
  } else {
    addSection(finish, 'Persönliches', [
      ['Beruf', data.profile.profession || '—'],
      ['Hobbys', data.profile.hobbies.join(', ') || '—'],
      ['Antwortstil', data.profile.responseStyle],
      ['Tonfall', data.profile.tone],
    ]);
  }

  // Skills
  const skillRows: [string, string][] = [];
  if (data.skills.programming) skillRows.push(['Programmieren', data.skills.programming]);
  if (data.skills.design) skillRows.push(['Design', data.skills.design]);
  if (data.skills.office) skillRows.push(['Office', data.skills.office]);
  if (skillRows.length > 0) addSection(finish, 'Skill-Level', skillRows);

  // Files (optional)
  if (data.skippedSteps.has('files')) {
    addSkipped(finish, 'Dateien & Programme', 'Übersprungen — kannst du jederzeit in den Einstellungen nachholen');
  } else {
    addSection(finish, 'Dateien & Programme', [
      ['Programme', data.files.importantPrograms.join(', ') || '—'],
      ['PDF-Ordner', data.files.pdfFolder || '—'],
      ['Bilder', data.files.picturesFolder || '—'],
    ]);
  }

  // Trust
  addSection(finish, 'Vertrauen', [
    ['Memory', data.trust.memoryAllowed ? 'Erlaubt' : 'Nicht erlaubt'],
    ['Dateizugriff', data.trust.fileAccess],
  ]);

  // Personalization
  const colorRow = document.createElement('div');
  colorRow.className = 'summary-row';
  const colorLabel = document.createElement('span');
  colorLabel.className = 'summary-label';
  colorLabel.textContent = 'Akzentfarbe';
  const colorValue = document.createElement('span');
  colorValue.className = 'summary-value';
  colorValue.textContent = data.personalization.accentColor;
  const colorDot = document.createElement('span');
  colorDot.className = 'accent-preview';
  colorDot.style.backgroundColor = data.personalization.accentColor;
  colorDot.style.color = data.personalization.accentColor;
  colorValue.appendChild(colorDot);

  const persSection = document.createElement('div');
  persSection.className = 'summary-section';
  const persHeading = document.createElement('div');
  persHeading.className = 'summary-heading';
  persHeading.textContent = 'Personalisierung';
  const persSummary = document.createElement('div');
  persSummary.className = 'summary';
  colorRow.appendChild(colorLabel);
  colorRow.appendChild(colorValue);
  persSummary.appendChild(colorRow);
  persSection.appendChild(persHeading);
  persSection.appendChild(persSummary);
  finish.appendChild(persSection);

  // System
  addSection(finish, 'System', [
    ['OS', data.system.os || '—'],
    ['CPU', data.system.cpu || '—'],
    ['RAM', data.system.totalMemory || '—'],
  ]);

  container.appendChild(finish);
  return container;
}

function addSection(parent: HTMLElement, heading: string, rows: [string, string][]): void {
  const section = document.createElement('div');
  section.className = 'summary-section';

  const h = document.createElement('div');
  h.className = 'summary-heading';
  h.textContent = heading;
  section.appendChild(h);

  const summary = document.createElement('div');
  summary.className = 'summary';

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const l = document.createElement('span');
    l.className = 'summary-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'summary-value';
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    summary.appendChild(row);
  }

  section.appendChild(summary);
  parent.appendChild(section);
}

function addSkipped(parent: HTMLElement, heading: string, message: string): void {
  const section = document.createElement('div');
  section.className = 'summary-section';
  const h = document.createElement('div');
  h.className = 'summary-heading';
  h.textContent = heading;
  const skipped = document.createElement('div');
  skipped.className = 'summary-skipped';
  skipped.textContent = message;
  section.appendChild(h);
  section.appendChild(skipped);
  parent.appendChild(section);
}
