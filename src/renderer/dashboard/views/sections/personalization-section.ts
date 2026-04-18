import { showSaved, createSectionHeader, save, createSpacer } from '../../../shared/settings-utils.js';
import {
  buildAccentPicker,
  buildVoiceSelect,
  buildSpeechRateSelect,
  buildChatFontSizeSelect,
  buildChatAlignmentSelect,
  buildResponseLanguageSelect,
  buildResponseStyleSelect,
  buildToneSelect,
  buildResponseModeSelect,
  buildEmojisToggle,
  buildTraitsSelect,
  buildQuirkGroup,
} from '../../../shared/personalization-controls.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

export function createPersonalizationSection(config: SarahConfig): HTMLElement {
  const pers = { ...config.personalization };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Personalisierung');
  section.appendChild(header);

  const notify = (): void => {
    save('personalization', pers);
    showSaved(feedback);
  };

  // Accent color picker
  const accentPicker = buildAccentPicker(pers, notify);
  accentPicker.style.marginBottom = 'var(--sarah-space-lg)';
  section.appendChild(accentPicker);

  // First grid: voice, speech rate, chat font size, chat alignment
  const grid = document.createElement('div');
  grid.className = 'settings-grid';
  grid.appendChild(buildVoiceSelect(pers, notify));
  grid.appendChild(buildSpeechRateSelect(pers, notify));
  grid.appendChild(buildChatFontSizeSelect(pers, notify));
  grid.appendChild(buildChatAlignmentSelect(pers, notify));
  section.appendChild(grid);

  // Response settings group
  const responseGrid = document.createElement('div');
  responseGrid.className = 'settings-grid';
  responseGrid.appendChild(buildResponseLanguageSelect(pers, notify));
  responseGrid.appendChild(buildResponseStyleSelect(pers, notify));
  responseGrid.appendChild(buildToneSelect(pers, notify));
  section.appendChild(responseGrid);
  section.appendChild(createSpacer());
  section.appendChild(buildEmojisToggle(pers, notify));
  section.appendChild(createSpacer());
  section.appendChild(buildResponseModeSelect(pers, notify));
  section.appendChild(createSpacer());
  section.appendChild(buildTraitsSelect(pers, notify));
  section.appendChild(createSpacer());
  section.appendChild(buildQuirkGroup(pers, notify));

  return section;
}
