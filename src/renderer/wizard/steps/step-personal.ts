import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahInput } from '../../components/sarah-input.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';

const HOBBY_OPTIONS = [
  { value: 'Fitness', label: 'Fitness', icon: '💪' },
  { value: 'Coding', label: 'Coding', icon: '💻' },
  { value: 'Musik', label: 'Musik', icon: '🎵' },
  { value: 'Gaming', label: 'Gaming', icon: '🎮' },
  { value: 'Kochen', label: 'Kochen', icon: '🍳' },
  { value: 'Lesen', label: 'Lesen', icon: '📚' },
  { value: 'Reisen', label: 'Reisen', icon: '✈️' },
  { value: 'Fotografie', label: 'Fotografie', icon: '📷' },
];

export function createPersonalStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const form = sarahForm({
    title: 'Persönliches',
    description: 'Ich kann dich besser unterstützen, wenn ich mehr über dich weiß. Du kannst diesen Schritt auch überspringen.',
    children: [
      sarahInput({
        label: 'Möchtest du deinen Nachnamen angeben?',
        placeholder: 'Nachname',
        value: data.profile.lastName,
        onChange: (value) => { data.profile.lastName = value; },
      }),
      sarahInput({
        label: 'Möchtest du deine Adresse speichern?',
        placeholder: 'Straße, Nr.',
        value: data.profile.address,
        onChange: (value) => { data.profile.address = value; },
      }),
      sarahTagSelect({
        label: 'Was sind deine Interessen?',
        options: HOBBY_OPTIONS,
        selected: data.profile.hobbies,
        allowCustom: true,
        onChange: (values) => { data.profile.hobbies = values; },
      }),
      sarahInput({
        label: 'Was machst du beruflich?',
        placeholder: 'z.B. Entwickler',
        value: data.profile.profession,
        onChange: (value) => { data.profile.profession = value; },
      }),
      sarahInput({
        label: 'Was machst du häufig?',
        placeholder: 'z.B. Rechnungen, Planung',
        value: data.profile.activities,
        onChange: (value) => { data.profile.activities = value; },
      }),
    ],
  });

  container.appendChild(form);
  return container;
}
