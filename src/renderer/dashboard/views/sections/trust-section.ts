import { sarahSelect } from '../../../components/sarah-select.js';
import { sarahToggle } from '../../../components/sarah-toggle.js';
import { sarahTagSelect } from '../../../components/sarah-tag-select.js';
import { showSaved, createSectionHeader, save, createHint } from '../../../shared/settings-utils.js';
import { createSettingsSubtabs } from '../../../shared/settings-subtabs.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

const EXCLUSION_OPTIONS = [
  { value: 'Browser-Daten', label: 'Browser-Daten', icon: '🌐' },
  { value: 'Namen Dritter', label: 'Namen Dritter', icon: '👤' },
  { value: 'Gesundheit', label: 'Gesundheit', icon: '🏥' },
  { value: 'Finanzen', label: 'Finanzen', icon: '💰' },
];

export function createTrustSection(config: SarahConfig): HTMLElement {
  const trust = config.trust;
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Datenschutz & Sicherheit');
  section.appendChild(header);

  const intro = document.createElement('div');
  intro.className = 'settings-security-intro';
  intro.textContent = 'Du entscheidest, was Sarah speichern, verwenden und an verbundene Dienste weitergeben darf. Passwörter sowie Bank- und Versicherungsdaten werden niemals als Langzeiterinnerung gespeichert.';
  section.appendChild(intro);

  const privacyPanel = document.createElement('div');
  privacyPanel.className = 'settings-control-stack';
  const exclusionsWrapper = document.createElement('div');
  exclusionsWrapper.style.display = trust.memoryAllowed !== false ? 'block' : 'none';

  privacyPanel.appendChild(sarahToggle({
    label: 'Erinnerungen erlauben',
    description: 'Neue Erinnerungen erlauben. Ausschalten pausiert das Gedächtnis, ohne bestehende Erinnerungen zu löschen.',
    checked: trust.memoryAllowed !== false,
    onChange: (val) => {
      trust.memoryAllowed = val;
      exclusionsWrapper.style.display = val ? 'block' : 'none';
      save('trust', trust);
      showSaved(feedback);
    },
  }));

  const exclusions = trust.memoryExclusions || [];
  exclusionsWrapper.appendChild(sarahTagSelect({
    label: 'Was soll Sarah sich nicht merken?',
    options: EXCLUSION_OPTIONS,
    selected: exclusions,
    allowCustom: true,
    customPlaceholder: 'Eigenen Ausschluss hinzufügen...',
    onChange: (values) => {
      trust.memoryExclusions = values;
      save('trust', trust);
      showSaved(feedback);
    },
  }));
  privacyPanel.appendChild(exclusionsWrapper);

  privacyPanel.appendChild(sarahToggle({
    label: 'Vertrauliche Nachrichten',
    description: 'Erlaubt einmalige vertrauliche Nachrichten und private Abschnitte mit /anonymous.',
    checked: trust.anonymousEnabled,
    onChange: (val) => {
      trust.anonymousEnabled = val;
      save('trust', trust);
      showSaved(feedback);
    },
  }));

  privacyPanel.appendChild(sarahToggle({
    label: 'Browser verwenden',
    description: 'Erlaubt Websuchen und das Öffnen der dazugehörigen Suchergebnisse. OAuth-Anmeldungen werden separat gesteuert.',
    checked: trust.webAccessAllowed,
    onChange: (val) => {
      trust.webAccessAllowed = val;
      save('trust', trust);
      showSaved(feedback);
    },
  }));

  const protectionPanel = document.createElement('div');
  protectionPanel.className = 'settings-control-stack';
  const recognitionGroup = document.createElement('div');
  recognitionGroup.className = 'settings-field-group';
  recognitionGroup.appendChild(sarahSelect({
    label: 'Programmerkennung',
    options: [
      { value: 'none', label: 'Keine Programmerkennung' },
      { value: 'specific-folders', label: 'Nur ausgewählte Programmordner' },
      { value: 'all', label: 'Systemweit installierte Programme' },
    ],
    value: trust.fileAccess || 'specific-folders',
    onChange: (val) => {
      trust.fileAccess = val as typeof trust.fileAccess;
      save('trust', trust);
      showSaved(feedback);
    },
  }));
  recognitionGroup.appendChild(createHint('Steuert ausschließlich, wo Sarah nach startbaren Programmen suchen darf. Inhalte von Bildern, PDFs oder Projekten werden derzeit nicht analysiert.'));
  protectionPanel.appendChild(recognitionGroup);

  protectionPanel.appendChild(sarahSelect({
    label: 'Bestätigungen',
    options: [
      { value: 'minimal', label: 'Minimal — nur bei kritischen Aktionen' },
      { value: 'standard', label: 'Standard — Sarah fragt wenn sinnvoll' },
      { value: 'maximal', label: 'Maximal — bei jeder verändernden Aktion' },
    ],
    value: trust.confirmationLevel || 'standard',
    onChange: (val) => {
      trust.confirmationLevel = val as typeof trust.confirmationLevel;
      save('trust', trust);
      showSaved(feedback);
    },
  }));

  section.appendChild(createSettingsSubtabs([
    { id: 'privacy', label: 'Datenschutz', content: privacyPanel },
    { id: 'protection', label: 'Schutz & Zugriff', content: protectionPanel },
  ]));

  return section;
}
