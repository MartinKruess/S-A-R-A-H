import { sarahSelect } from '../../../components/sarah-select.js';
import { sarahToggle } from '../../../components/sarah-toggle.js';
import { sarahTagSelect } from '../../../components/sarah-tag-select.js';
import { showSaved, createSectionHeader, save } from '../../../shared/settings-utils.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

const EXCLUSION_OPTIONS = [
  { value: 'Browser-Daten', label: 'Browser-Daten', icon: '🌐' },
  { value: 'Namen Dritter', label: 'Namen Dritter', icon: '👤' },
  { value: 'Gesundheit', label: 'Gesundheit', icon: '🏥' },
  { value: 'Finanzen', label: 'Finanzen', icon: '💰' },
];

export function createTrustSection(config: SarahConfig): HTMLElement {
  const trust = { ...config.trust };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Vertrauen & Sicherheit');
  section.appendChild(header);

  const exclusionsWrapper = document.createElement('div');
  exclusionsWrapper.style.display = (trust.memoryAllowed !== false) ? 'block' : 'none';

  section.appendChild(sarahToggle({
    label: 'Erinnerungen erlauben',
    description: 'S.A.R.A.H. darf sich Dinge aus Gesprächen merken',
    checked: trust.memoryAllowed !== false,
    onChange: (val) => {
      trust.memoryAllowed = val;
      exclusionsWrapper.style.display = val ? 'block' : 'none';
      save('trust', trust);
      showSaved(feedback);
    },
  }));

  const memoryHint = document.createElement('div');
  memoryHint.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-muted); line-height: 1.4; padding: var(--sarah-space-xs) 0;';
  memoryHint.textContent = 'Sarah merkt sich dein Verhalten und Muster, aber niemals Passwörter, Bank- oder Versicherungsdaten.';
  section.appendChild(memoryHint);

  const exclusions = trust.memoryExclusions || [];
  exclusionsWrapper.appendChild(sarahTagSelect({
    label: 'Was soll Sarah sich nicht merken?',
    options: EXCLUSION_OPTIONS,
    selected: exclusions,
    allowCustom: true,
    onChange: (values) => { trust.memoryExclusions = values; save('trust', trust); showSaved(feedback); },
  }));
  section.appendChild(exclusionsWrapper);

  const spacer = document.createElement('div');
  spacer.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer);

  section.appendChild(sarahSelect({
    label: 'Dateizugriff',
    options: [
      { value: 'none', label: 'Kein Zugriff' },
      { value: 'specific-folders', label: 'Nur bestimmte Ordner' },
      { value: 'all', label: 'Alle Dateien' },
    ],
    value: trust.fileAccess || 'specific-folders',
    onChange: (val) => { trust.fileAccess = val as typeof trust.fileAccess; save('trust', trust); showSaved(feedback); },
  }));

  const spacer2 = document.createElement('div');
  spacer2.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer2);

  section.appendChild(sarahSelect({
    label: 'Bestätigungen',
    options: [
      { value: 'minimal', label: 'Minimal — nur bei kritischen Aktionen' },
      { value: 'standard', label: 'Standard — Sarah fragt wenn sinnvoll' },
      { value: 'maximal', label: 'Maximal — bei jeder verändernden Aktion' },
    ],
    value: trust.confirmationLevel || 'standard',
    onChange: (val) => { trust.confirmationLevel = val as typeof trust.confirmationLevel; save('trust', trust); showSaved(feedback); },
  }));

  return section;
}
