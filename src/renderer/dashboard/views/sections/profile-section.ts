import { sarahInput } from '../../../components/sarah-input.js';
import { sarahTagSelect } from '../../../components/sarah-tag-select.js';
import { sarahButton } from '../../../components/sarah-button.js';
import { getSarah, showSaved, createSectionHeader, save } from '../../../shared/settings-utils.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

const ABO_UPGRADE_URL = 'https://sarah.ai/pricing';

export function createProfileSection(config: SarahConfig): HTMLElement {
  const profile = { ...config.profile };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Profil');
  section.appendChild(header);

  // Abo-Block
  const aboBlock = document.createElement('div');
  aboBlock.className = 'settings-abo-block';

  const aboHeader = document.createElement('div');
  aboHeader.className = 'settings-abo-header';
  aboHeader.textContent = 'Abonnement';
  aboBlock.appendChild(aboHeader);

  const aboRow = document.createElement('div');
  aboRow.className = 'settings-abo-row';

  const aboStatus = document.createElement('div');
  aboStatus.className = 'settings-abo-status';
  aboStatus.textContent = 'Free Tier';
  aboRow.appendChild(aboStatus);

  const upgradeBtn = sarahButton({
    label: 'Auf Pro upgraden',
    onClick: () => {
      getSarah().openExternalUrl(ABO_UPGRADE_URL).catch((err) => {
        console.error('[profile] openExternalUrl failed:', err);
      });
    },
  });
  aboRow.appendChild(upgradeBtn);

  aboBlock.appendChild(aboRow);
  section.appendChild(aboBlock);

  const grid = document.createElement('div');
  grid.className = 'settings-grid';

  grid.appendChild(sarahInput({
    label: 'Anzeigename',
    value: profile.displayName || '',
    onChange: (val) => { profile.displayName = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahInput({
    label: 'Nachname',
    value: profile.lastName || '',
    onChange: (val) => { profile.lastName = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahInput({
    label: 'Stadt',
    value: profile.city || '',
    onChange: (val) => { profile.city = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahInput({
    label: 'Adresse',
    value: profile.address || '',
    onChange: (val) => { profile.address = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahInput({
    label: 'Beruf',
    value: profile.profession || '',
    onChange: (val) => { profile.profession = val; save('profile', profile); showSaved(feedback); },
  }));

  // Hobbys spannt volle Breite des Grids via .settings-field-full
  const hobbyOptions = (profile.hobbies || []).map((h) => ({ value: h, label: h }));
  const hobbies = sarahTagSelect({
    label: 'Hobbys',
    options: hobbyOptions,
    selected: profile.hobbies || [],
    allowCustom: true,
    onChange: (values) => {
      profile.hobbies = values;
      save('profile', profile);
      showSaved(feedback);
    },
  });
  hobbies.classList.add('settings-field-full');
  grid.appendChild(hobbies);

  section.appendChild(grid);
  return section;
}

