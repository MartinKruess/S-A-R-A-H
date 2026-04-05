import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahInput } from '../../components/sarah-input.js';
import { sarahSelect } from '../../components/sarah-select.js';

export function createProfileStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const form = sarahForm({
    title: 'Dein Profil',
    description: 'Erzähl mir ein bisschen über dich, damit ich dich besser unterstützen kann.',
    children: [
      sarahInput({
        label: 'Wie soll ich dich nennen?',
        placeholder: 'Dein Name',
        required: true,
        value: data.profile.displayName,
        onChange: (value) => { data.profile.displayName = value; },
      }),
      sarahInput({
        label: 'Stadt / Region',
        placeholder: 'z.B. Berlin',
        value: data.profile.city,
        onChange: (value) => { data.profile.city = value; },
      }),
      sarahSelect({
        label: 'Sprache',
        options: [
          { value: 'de', label: 'Deutsch' },
          { value: 'en', label: 'English' },
          { value: 'fr', label: 'Français' },
          { value: 'es', label: 'Español' },
        ],
        value: data.profile.language,
        onChange: (value) => { data.profile.language = value; },
      }),
      sarahSelect({
        label: 'Zeitzone',
        options: getTimezoneOptions(),
        value: data.profile.timezone,
        onChange: (value) => { data.profile.timezone = value; },
      }),
    ],
  });

  container.appendChild(form);
  return container;
}

function getTimezoneOptions(): { value: string; label: string }[] {
  const zones = [
    'Europe/Berlin',
    'Europe/Vienna',
    'Europe/Zurich',
    'Europe/London',
    'Europe/Paris',
    'Europe/Amsterdam',
    'America/New_York',
    'America/Chicago',
    'America/Los_Angeles',
    'Asia/Tokyo',
    'Asia/Shanghai',
    'Australia/Sydney',
  ];
  return zones.map(z => ({ value: z, label: z.replace('_', ' ') }));
}
