import { sarahSelect } from '../../../components/sarah-select.js';
import { sarahToggle } from '../../../components/sarah-toggle.js';
import { sarahTagSelect } from '../../../components/sarah-tag-select.js';
import { showSaved, createSectionHeader, save, createSpacer, createHint } from '../../../shared/settings-utils.js';
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

  section.appendChild(createHint('Sarah merkt sich dein Verhalten und Muster, aber niemals Passwörter, Bank- oder Versicherungsdaten.'));

  const exclusions = trust.memoryExclusions || [];
  exclusionsWrapper.appendChild(sarahTagSelect({
    label: 'Was soll Sarah sich nicht merken?',
    options: EXCLUSION_OPTIONS,
    selected: exclusions,
    allowCustom: true,
    onChange: (values) => { trust.memoryExclusions = values; save('trust', trust); showSaved(feedback); },
  }));
  section.appendChild(exclusionsWrapper);
  section.appendChild(createSpacer());

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

  section.appendChild(createSpacer());

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
