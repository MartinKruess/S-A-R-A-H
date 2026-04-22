import { sarahInput } from '../../../components/sarah-input.js';
import { sarahTagSelect } from '../../../components/sarah-tag-select.js';
import { getSarah, showSaved, createSectionHeader, save } from '../../../shared/settings-utils.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

export function createProfileSection(config: SarahConfig): HTMLElement {
  const profile = { ...config.profile };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Profil');
  section.appendChild(header);

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

// getSarah wird bereits transitively genutzt, aber für zukünftige Helpers hier re-exportiert
void getSarah;
