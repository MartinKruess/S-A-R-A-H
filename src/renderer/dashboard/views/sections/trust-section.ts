import { sarahSelect } from '../../../components/sarah-select.js';
import { sarahToggle } from '../../../components/sarah-toggle.js';
import { sarahTagSelect } from '../../../components/sarah-tag-select.js';
import { sarahButton } from '../../../components/sarah-button.js';
import { showSaved, createSectionHeader, save, createSpacer, createHint, getSarah } from '../../../shared/settings-utils.js';
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
    description: 'Neue Erinnerungen erlauben. Ausschalten pausiert das Gedächtnis, ohne bestehende Erinnerungen zu löschen.',
    checked: trust.memoryAllowed !== false,
    onChange: (val) => {
      trust.memoryAllowed = val;
      exclusionsWrapper.style.display = val ? 'block' : 'none';
      save('trust', trust);
      showSaved(feedback);
    },
  }));

  section.appendChild(createHint('Sarah merkt sich dein Verhalten und Muster, aber niemals Passwörter, Bank- oder Versicherungsdaten.'));

  section.appendChild(sarahToggle({
    label: 'Kontext einsehen',
    description: 'Erlaubt /showcontext und /exportmemory für deine kuratierten Erinnerungen.',
    checked: trust.showContextEnabled,
    onChange: (val) => {
      trust.showContextEnabled = val;
      save('trust', trust);
      showSaved(feedback);
    },
  }));

  section.appendChild(sarahToggle({
    label: 'Vertrauliche Nachrichten',
    description: 'Erlaubt einmalige vertrauliche Nachrichten und private Abschnitte mit /anonymous.',
    checked: trust.anonymousEnabled,
    onChange: (val) => {
      trust.anonymousEnabled = val;
      save('trust', trust);
      showSaved(feedback);
    },
  }));

  section.appendChild(sarahToggle({
    label: 'Browser verwenden',
    description: 'Erlaubt Websuchen und das Öffnen der dazugehörigen Suchergebnisse. OAuth-Anmeldungen werden separat gesteuert.',
    checked: trust.webAccessAllowed,
    onChange: (val) => {
      trust.webAccessAllowed = val;
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
    onChange: (values) => { trust.memoryExclusions = values; save('trust', trust); showSaved(feedback); },
  }));
  section.appendChild(exclusionsWrapper);
  section.appendChild(createSpacer());

  section.appendChild(sarahSelect({
    label: 'Programmerkennung',
    options: [
      { value: 'none', label: 'Keine Programmerkennung' },
      { value: 'specific-folders', label: 'Nur ausgewählte Programmordner' },
      { value: 'all', label: 'Systemweit installierte Programme' },
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
  section.appendChild(createHint(
    'Steuert ausschließlich, wo Sarah nach startbaren Programmen suchen darf. Inhalte von Bildern, PDFs oder Projekten werden derzeit nicht analysiert.',
  ));

  section.appendChild(createSpacer());
  section.appendChild(createHint(
    'Falls alte verschlüsselte Daten isoliert wurden, kannst du sie hier prüfen. Sie werden niemals automatisch wieder in Sarahs Kontext übernommen.',
  ));
  const recoveryStatus = document.createElement('div');
  recoveryStatus.className = 'settings-hint';
  const recoveryButton = sarahButton({
    label: 'Isolierte Altwerte prüfen',
    variant: 'secondary',
    onClick: () => {
      recoveryButton.setAttribute('disabled', '');
      recoveryStatus.textContent = 'Prüfung läuft …';
      void getSarah().reviewLegacyDbRecovery().then(async (review) => {
        if (review.candidates.length === 0) {
          recoveryStatus.textContent = 'Keine wiederherstellbaren Altwerte gefunden.';
          return;
        }
        const result = await getSarah().restoreLegacyDbRecovery(
          review.candidates.slice(0, 10).map((candidate) => candidate.quarantineId),
        );
        recoveryStatus.textContent = result
          ? `${result.restored} Altwerte wiederhergestellt. Sicherung: ${result.backupPath}${review.candidates.length > 10 ? ' Weitere isolierte Altwerte können in einem nächsten Durchlauf geprüft werden.' : ''}`
          : 'Wiederherstellung abgebrochen. Die Altwerte bleiben isoliert.';
      }).catch((error) => {
        console.warn('[Settings] legacy DB recovery failed:', error);
        recoveryStatus.textContent = 'Altwerte konnten nicht geprüft oder wiederhergestellt werden.';
      }).finally(() => recoveryButton.removeAttribute('disabled'));
    },
  });
  section.appendChild(recoveryButton);
  section.appendChild(recoveryStatus);

  return section;
}
