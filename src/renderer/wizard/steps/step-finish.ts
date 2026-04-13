import type { WizardData } from '../wizard.js';

const FINISH_CSS = `
  .finish {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sarah-space-lg);
    max-width: 720px;
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
      ['Antwortstil', data.personalization.responseStyle],
      ['Tonfall', data.personalization.tone],
    ]);
  }

  // Skills
  const skillRows: [string, string][] = [];
  if (data.skills.programming) skillRows.push(['Programmieren', data.skills.programming]);
  if (data.skills.programmingStack.length > 0) skillRows.push(['Techstack', data.skills.programmingStack.join(', ')]);
  if (data.skills.programmingResources.length > 0) skillRows.push(['Anlaufstellen', data.skills.programmingResources.join(', ')]);
  if (data.skills.programmingProjectsFolder) skillRows.push(['Projekte-Ordner', data.skills.programmingProjectsFolder]);
  if (data.skills.design) skillRows.push(['Design', data.skills.design]);
  if (data.skills.office) skillRows.push(['Office', data.skills.office]);
  if (skillRows.length > 0) addSection(finish, 'Skill-Level', skillRows);

  // Files (optional)
  if (data.skippedSteps.has('files')) {
    addSkipped(finish, 'Dateien & Programme', 'Übersprungen — kannst du jederzeit in den Einstellungen nachholen');
  } else {
    const fileRows: [string, string][] = [
      ['Programme', data.resources.programs.map(p => p.name).join(', ') || '—'],
      ['Bilder', data.resources.picturesFolder || '—'],
    ];
    if (data.resources.extraProgramsFolder) fileRows.push(['Programm-Ordner', data.resources.extraProgramsFolder]);
    if (data.resources.gamesFolder) fileRows.push(['Games-Ordner', data.resources.gamesFolder]);
    if (data.resources.pdfCategories.length > 0) {
      fileRows.push(['PDF-Kategorien', data.resources.pdfCategories.map(c => c.tag).join(', ')]);
    }
    addSection(finish, 'Dateien & Programme', fileRows);
  }

  // Trust
  const fileAccessLabels: Record<string, string> = {
    all: 'Alle Dateien', 'specific-folders': 'Nur bestimmte Ordner', none: 'Kein Zugriff',
  };
  const confirmLabels: Record<string, string> = {
    minimal: 'Minimal', standard: 'Standard', maximal: 'Maximal',
  };
  const trustRows: [string, string][] = [
    ['Memory', data.trust.memoryAllowed ? 'Erlaubt' : 'Nicht erlaubt'],
    ['Dateizugriff', fileAccessLabels[data.trust.fileAccess] ?? data.trust.fileAccess],
    ['Bestätigungen', confirmLabels[data.trust.confirmationLevel] ?? 'Standard'],
  ];
  if (data.trust.memoryExclusions.length > 0) {
    trustRows.push(['Ausnahmen', data.trust.memoryExclusions.join(', ')]);
  }
  trustRows.push(['/showcontext', data.trust.showContextEnabled ? 'Aktiv' : 'Aus']);
  trustRows.push(['/anonymous', data.trust.anonymousEnabled ? 'Aktiv' : 'Aus']);
  addSection(finish, 'Vertrauen', trustRows);

  // Personalization
  const fontSizeLabels: Record<string, string> = { small: 'Klein', default: 'Standard', large: 'Groß' };
  const alignLabels: Record<string, string> = { stacked: 'Untereinander', bubbles: 'Bubbles' };
  const modeLabels: Record<string, string> = { normal: 'Normal', spontaneous: 'Spontan', thoughtful: 'Nachdenklich' };
  const quirkLabels: Record<string, string> = {
    miauz: 'Miauz Genau!', gamertalk: 'Gamertalk', nerd: 'Prof. Dr. Dr.',
    oldschool: 'Oldschool', altertum: 'Altertum', pirat: 'Pirat',
  };

  const persRows: [string, string][] = [
    ['Akzentfarbe', data.personalization.accentColor],
    ['Chat-Schrift', fontSizeLabels[data.personalization.chatFontSize] ?? 'Standard'],
    ['Chat-Ausrichtung', alignLabels[data.personalization.chatAlignment] ?? 'Untereinander'],
    ['Smileys', data.personalization.emojisEnabled ? 'An' : 'Aus'],
    ['Antwortmodus', modeLabels[data.personalization.responseMode] ?? 'Normal'],
  ];
  if (data.personalization.characterTraits.length > 0) {
    persRows.push(['Charakter', data.personalization.characterTraits.join(', ')]);
  }
  if (data.personalization.quirk) {
    const quirkDisplay = quirkLabels[data.personalization.quirk] ?? data.personalization.quirk;
    persRows.push(['Eigenart', quirkDisplay]);
  }

  const persSection2 = document.createElement('div');
  persSection2.className = 'summary-section';
  const persHeading2 = document.createElement('div');
  persHeading2.className = 'summary-heading';
  persHeading2.textContent = 'Personalisierung';
  persSection2.appendChild(persHeading2);

  const persSummary2 = document.createElement('div');
  persSummary2.className = 'summary';
  for (const [label, value] of persRows) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const l = document.createElement('span');
    l.className = 'summary-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'summary-value';
    v.textContent = value;
    if (label === 'Akzentfarbe') {
      const dot = document.createElement('span');
      dot.className = 'accent-preview';
      dot.style.backgroundColor = data.personalization.accentColor;
      dot.style.color = data.personalization.accentColor;
      v.appendChild(dot);
    }
    row.appendChild(l);
    row.appendChild(v);
    persSummary2.appendChild(row);
  }
  persSection2.appendChild(persSummary2);
  finish.appendChild(persSection2);

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
