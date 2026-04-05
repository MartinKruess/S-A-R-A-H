import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahSelect } from '../../components/sarah-select.js';

const SKILL_LEVELS = [
  { value: 'Anfänger', label: 'Anfänger' },
  { value: 'Mittel', label: 'Mittel' },
  { value: 'Fortgeschritten', label: 'Fortgeschritten' },
  { value: 'Profi', label: 'Profi' },
];

interface DynamicQuestion {
  purposeKey: string;
  skillKey: keyof WizardData['skills'];
  question: string;
}

const DYNAMIC_QUESTIONS: DynamicQuestion[] = [
  { purposeKey: 'Programmieren', skillKey: 'programming', question: 'Wie ist dein Level im Programmieren?' },
  { purposeKey: 'Design', skillKey: 'design', question: 'Wie gut kennst du dich mit Design / Bildbearbeitung aus?' },
  { purposeKey: 'Office', skillKey: 'office', question: 'Wie sicher bist du mit Office?' },
];

export function hasDynamicQuestions(data: WizardData): boolean {
  return DYNAMIC_QUESTIONS.some(q => data.profile.usagePurposes.includes(q.purposeKey));
}

export function createDynamicStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');
  const relevant = DYNAMIC_QUESTIONS.filter(q => data.profile.usagePurposes.includes(q.purposeKey));

  const children: HTMLElement[] = relevant.map(q => {
    return sarahSelect({
      label: q.question,
      options: SKILL_LEVELS,
      value: data.skills[q.skillKey] ?? 'Mittel',
      onChange: (value) => { data.skills[q.skillKey] = value; },
    });
  });

  const form = sarahForm({
    title: 'Vertiefung',
    description: 'Damit ich meine Antworten besser an dein Level anpassen kann.',
    children,
  });

  container.appendChild(form);
  return container;
}
