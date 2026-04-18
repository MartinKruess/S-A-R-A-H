import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import {
  buildAccentPicker,
  buildVoiceSelect,
  buildChatFontSizeSelect,
  buildChatAlignmentSelect,
  buildEmojisToggle,
  buildResponseLanguageSelect,
  buildResponseStyleSelect,
  buildToneSelect,
  buildResponseModeSelect,
  buildTraitsSelect,
  buildQuirkGroup,
} from '../../shared/personalization-controls.js';

function createSectionHeading(text: string, first = false): HTMLElement {
  const heading = document.createElement('div');
  heading.className = first ? 'pers-heading first' : 'pers-heading';
  heading.textContent = text;
  return heading;
}

export function createPersonalizationStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');
  const pers = data.personalization;

  const form = sarahForm({
    title: 'Personalisierung',
    description: 'Passe S.A.R.A.H. an deinen Geschmack an. Du kannst alles später in den Einstellungen ändern.',
    children: [
      createSectionHeading('Aussehen', true),
      buildAccentPicker(pers),
      buildVoiceSelect(pers),
      createSectionHeading('Chat'),
      buildChatFontSizeSelect(pers),
      buildChatAlignmentSelect(pers),
      buildEmojisToggle(pers),
      createSectionHeading('Verhalten'),
      buildResponseLanguageSelect(pers),
      buildResponseStyleSelect(pers),
      buildToneSelect(pers),
      buildResponseModeSelect(pers),
      buildTraitsSelect(pers),
      buildQuirkGroup(pers),
    ],
  });

  container.appendChild(form);
  return container;
}
