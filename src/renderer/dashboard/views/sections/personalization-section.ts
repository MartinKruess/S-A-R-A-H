import { showSaved, createSectionHeader, save, createHint } from '../../../shared/settings-utils.js';
import { sarahSelect } from '../../../components/sarah-select.js';
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
  accentPicker.classList.add('settings-accent-picker');
  section.appendChild(accentPicker);

  // All select fields share one grid so every row uses the same spacing.
  const grid = document.createElement('div');
  grid.className = 'settings-grid';
  grid.appendChild(buildVoiceSelect(pers, notify));
  grid.appendChild(buildSpeechRateSelect(pers, notify));
  grid.appendChild(buildChatFontSizeSelect(pers, notify));
  grid.appendChild(buildChatAlignmentSelect(pers, notify));
  grid.appendChild(buildResponseLanguageSelect(pers, notify));
  grid.appendChild(buildResponseStyleSelect(pers, notify));
  grid.appendChild(buildToneSelect(pers, notify));
  section.appendChild(grid);

  const detailControls = document.createElement('div');
  detailControls.className = 'settings-control-stack settings-personal-details';
  detailControls.appendChild(buildEmojisToggle(pers, notify));
  detailControls.appendChild(buildResponseModeSelect(pers, notify));
  detailControls.appendChild(buildTraitsSelect(pers, notify));
  detailControls.appendChild(buildQuirkGroup(pers, notify));
  section.appendChild(detailControls);

  return section;
}

export function createPerformanceSection(config: SarahConfig): HTMLElement {
  const llm = { ...config.llm };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Leistung');
  section.appendChild(header);
  section.appendChild(sarahSelect({
    label: 'GPU-Leistungsprofil',
    options: [
      { value: 'leistung', label: 'Leistung — Maximale GPU-Nutzung' },
      { value: 'schnell', label: 'Schnell — Hohe GPU-Nutzung' },
      { value: 'normal', label: 'Normal — Ausgewogen' },
      { value: 'sparsam', label: 'Sparsam — Weniger GPU, mehr CPU' },
    ],
    value: llm.performanceProfile || 'normal',
    onChange: (val) => {
      llm.performanceProfile = val as typeof llm.performanceProfile;
      save('llm', llm);
      showSaved(feedback);
    },
  }));
  section.appendChild(createHint('Steuert, wie viele GPU-Layer für das große Sprachmodell verwendet werden. Höhere Stufen sind schneller, belegen aber mehr VRAM.'));

  return section;
}
