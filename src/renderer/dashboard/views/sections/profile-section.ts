import { sarahInput } from '../../../components/sarah-input.js';
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
    label: 'Stadt',
    value: profile.city || '',
    onChange: (val) => { profile.city = val; save('profile', profile); showSaved(feedback); },
  }));

  grid.appendChild(sarahInput({
    label: 'Beruf',
    value: profile.profession || '',
    onChange: (val) => { profile.profession = val; save('profile', profile); showSaved(feedback); },
  }));

  section.appendChild(grid);
  return section;
}
