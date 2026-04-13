import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';

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

  .trust-hint {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    line-height: 1.4;
    padding: var(--sarah-space-xs) 0;
  }

  .section-heading {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: var(--sarah-space-lg);
    margin-bottom: var(--sarah-space-xs);
  }

  .section-heading:first-of-type {
    margin-top: 0;
  }
`;

const EXCLUSION_OPTIONS = [
  { value: 'Browser-Daten', label: 'Browser-Daten', icon: '🌐' },
  { value: 'Namen Dritter', label: 'Namen Dritter', icon: '👤' },
  { value: 'Gesundheit', label: 'Gesundheit', icon: '🏥' },
  { value: 'Finanzen', label: 'Finanzen', icon: '💰' },
];

function createSectionHeading(text: string): HTMLElement {
  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = text;
  return heading;
}

export function createTrustStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = TRUST_CSS;
  container.appendChild(style);

  // === SECTION: Datenschutz ===
  const sectionDatenschutz = createSectionHeading('Datenschutz');

  const notice = document.createElement('div');
  notice.className = 'trust-notice';
  notice.innerHTML = '<strong>🔒 Datenschutz:</strong> Deine Daten werden lokal auf deinem Computer gespeichert. Wenn du externe KI-Dienste nutzt (z.B. Cloud-Modelle), werden Gesprächsinhalte zur Verarbeitung an diese Anbieter gesendet — aber nicht dort gespeichert. Bei rein lokalem Betrieb (Ollama) verlassen keine Daten deinen Computer.';

  // === SECTION: Gedächtnis ===
  const sectionGedaechtnis = createSectionHeading('Gedächtnis');

  const memoryToggle = sarahToggle({
    label: 'Darf ich mir Dinge merken?',
    description: 'Sarah lernt aus Gesprächen und merkt sich Präferenzen',
    checked: data.trust.memoryAllowed,
    onChange: (value) => {
      data.trust.memoryAllowed = value;
      memoryHint.style.display = 'block';
      exclusionsWrapper.style.display = value ? 'block' : 'none';
    },
  });

  const memoryHint = document.createElement('div');
  memoryHint.className = 'trust-hint';
  memoryHint.textContent = 'Sarah merkt sich dein Verhalten und Muster, aber niemals Passwörter, Bank- oder Versicherungsdaten.';

  const exclusionsWrapper = document.createElement('div');
  exclusionsWrapper.style.display = data.trust.memoryAllowed ? 'block' : 'none';

  const exclusionsSelect = sarahTagSelect({
    label: 'Was soll Sarah sich nicht merken?',
    options: EXCLUSION_OPTIONS,
    selected: data.trust.memoryExclusions,
    allowCustom: true,
    onChange: (values) => { data.trust.memoryExclusions = values; },
  });
  exclusionsWrapper.appendChild(exclusionsSelect);

  // === SECTION: Zugriff ===
  const sectionZugriff = createSectionHeading('Zugriff');

  const fileAccessSelect = sarahSelect({
    label: 'Darf ich Dateien analysieren?',
    options: [
      { value: 'all', label: 'Ja, alle Dateien' },
      { value: 'specific-folders', label: 'Nur bestimmte Ordner' },
      { value: 'none', label: 'Nein, keinen Zugriff' },
    ],
    value: data.trust.fileAccess,
    onChange: (value) => {
      data.trust.fileAccess = value as typeof data.trust.fileAccess;
      folderHint.style.display = value === 'specific-folders' ? 'block' : 'none';
    },
  });

  const folderHint = document.createElement('div');
  folderHint.className = 'trust-hint';
  folderHint.textContent = 'Sarah nutzt die Ordner die du unter Dateien & Apps angegeben hast (Bilder, PDFs, Projekte etc.).';
  folderHint.style.display = data.trust.fileAccess === 'specific-folders' ? 'block' : 'none';

  // === SECTION: Kontrolle ===
  const sectionKontrolle = createSectionHeading('Kontrolle');

  const confirmationSelect = sarahSelect({
    label: 'Bestätigungen',
    options: [
      { value: 'minimal', label: 'Minimal — nur bei kritischen Aktionen (bezahlen, löschen, buchen)' },
      { value: 'standard', label: 'Standard — Sarah fragt nach wenn es sinnvoll erscheint' },
      { value: 'maximal', label: 'Maximal — bei jeder Aktion die etwas verändert' },
    ],
    value: data.trust.confirmationLevel,
    onChange: (value) => { data.trust.confirmationLevel = value as 'minimal' | 'standard' | 'maximal'; },
  });

  // === SECTION: Befehle ===
  const sectionBefehle = createSectionHeading('Befehle');

  const showContextToggle = sarahToggle({
    label: 'Kontext einsehen',
    description: 'Mit /showcontext zeigt Sarah dir alles was sie über dich weiß',
    checked: data.trust.showContextEnabled,
    onChange: (value) => { data.trust.showContextEnabled = value; },
  });

  const anonymousToggle = sarahToggle({
    label: 'Vertrauliche Nachrichten',
    description: 'Mit /anonymous wird eine Nachricht nach der Session vergessen — Sarah reagiert darauf, merkt es sich aber nicht langfristig',
    checked: data.trust.anonymousEnabled,
    onChange: (value) => { data.trust.anonymousEnabled = value; },
  });

  // === FORM ===
  const form = sarahForm({
    title: 'Vertrauen & Kontrolle',
    description: 'Lege fest, was S.A.R.A.H. darf und was nicht.',
    children: [
      sectionDatenschutz,
      notice,
      sectionGedaechtnis,
      memoryToggle,
      memoryHint,
      exclusionsWrapper,
      sectionZugriff,
      fileAccessSelect,
      folderHint,
      sectionKontrolle,
      confirmationSelect,
      sectionBefehle,
      showContextToggle,
      anonymousToggle,
    ],
  });

  container.appendChild(form);
  return container;
}
