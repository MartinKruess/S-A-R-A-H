import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahInput } from '../../components/sarah-input.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';

const USAGE_OPTIONS = [
  { value: 'Dateien', label: 'Dateien', icon: '📁' },
  { value: 'Organisation', label: 'Organisation', icon: '📋' },
  { value: 'Programmieren', label: 'Programmieren', icon: '💻' },
  { value: 'Design', label: 'Design / Bildbearbeitung', icon: '🎨' },
  { value: 'E-Mail', label: 'E-Mail', icon: '📧' },
  { value: 'Web', label: 'Web / Recherche', icon: '🌐' },
  { value: 'Office', label: 'Office', icon: '📊' },
  { value: 'Gaming', label: 'Gaming', icon: '🎮' },
];

export function createRequiredStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const form = sarahForm({
    title: 'Die Basics',
    description: 'Diese Infos brauche ich, damit ich direkt loslegen kann.',
    children: [
      sarahInput({
        label: 'Wie soll ich dich nennen?',
        placeholder: 'Dein Name',
        required: true,
        value: data.profile.displayName,
        onChange: (value) => { data.profile.displayName = value; },
      }),
      sarahInput({
        label: 'In welcher Stadt bist du?',
        placeholder: 'z.B. Hamburg',
        required: true,
        value: data.profile.city,
        onChange: (value) => { data.profile.city = value; },
      }),
      sarahTagSelect({
        label: 'Wobei soll ich dir helfen?',
        options: USAGE_OPTIONS,
        selected: data.profile.usagePurposes,
        allowCustom: true,
        onChange: (values) => { data.profile.usagePurposes = values; },
      }),
    ],
  });

  container.appendChild(form);
  return container;
}
