import { sarahButton } from '../../../components/sarah-button.js';
import { sarahToggle } from '../../../components/sarah-toggle.js';
import { showSaved, save, createHint, getSarah } from '../../../shared/settings-utils.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

export function createContextManagementPanel(config: SarahConfig): HTMLElement {
  const trust = config.trust;
  const panel = document.createElement('div');
  panel.className = 'settings-control-stack';

  panel.appendChild(createHint('Verwalte, welche gespeicherten Informationen du einsehen kannst und wie isolierte alte Kontextdaten behandelt werden. Die bearbeitbare Langzeitkontext-Ansicht wird später ebenfalls hier ergänzt.'));

  const contextGroup = document.createElement('div');
  contextGroup.className = 'settings-feedback-group';
  const feedback = document.createElement('span');
  feedback.className = 'save-feedback';
  contextGroup.appendChild(sarahToggle({
    label: 'Kontext einsehen',
    description: 'Erlaubt /showcontext und /exportmemory für deine kuratierten Erinnerungen.',
    checked: trust.showContextEnabled,
    onChange: (val) => {
      trust.showContextEnabled = val;
      save('trust', trust);
      showSaved(feedback);
    },
  }));
  contextGroup.appendChild(feedback);
  panel.appendChild(contextGroup);

  const recoveryBlock = document.createElement('div');
  recoveryBlock.className = 'settings-recovery-block';
  const recoveryTitle = document.createElement('div');
  recoveryTitle.className = 'settings-secondary-heading';
  recoveryTitle.textContent = 'Kontext-Wiederherstellung';
  recoveryBlock.appendChild(recoveryTitle);
  recoveryBlock.appendChild(createHint('Prüft ältere verschlüsselte Speicherwerte, die nach einem Update oder wegen eines Integritätsproblems vorsorglich isoliert wurden. Sie werden niemals automatisch wieder in Sarahs Kontext übernommen.'));

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
  recoveryBlock.appendChild(recoveryButton);
  recoveryBlock.appendChild(recoveryStatus);
  panel.appendChild(recoveryBlock);

  return panel;
}
