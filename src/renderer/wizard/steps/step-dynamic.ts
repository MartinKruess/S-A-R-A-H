import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahPathPicker } from '../../components/sarah-path-picker.js';

const SKILL_LEVELS = [
  { value: 'Anfänger', label: 'Anfänger' },
  { value: 'Mittel', label: 'Mittel' },
  { value: 'Fortgeschritten', label: 'Fortgeschritten' },
  { value: 'Profi', label: 'Profi' },
];

const TECHSTACK_OPTIONS = [
  { value: 'JavaScript', label: 'JavaScript', icon: '🟨' },
  { value: 'TypeScript', label: 'TypeScript', icon: '🔷' },
  { value: 'Python', label: 'Python', icon: '🐍' },
  { value: 'C#', label: 'C#', icon: '🟪' },
  { value: 'Java', label: 'Java', icon: '☕' },
  { value: 'Rust', label: 'Rust', icon: '🦀' },
  { value: 'Go', label: 'Go', icon: '🔵' },
  { value: 'PHP', label: 'PHP', icon: '🐘' },
  { value: 'C++', label: 'C++', icon: '⚙️' },
  { value: 'Swift', label: 'Swift', icon: '🍎' },
  { value: 'Kotlin', label: 'Kotlin', icon: '🟣' },
  { value: 'Ruby', label: 'Ruby', icon: '💎' },
  { value: 'HTML/CSS', label: 'HTML/CSS', icon: '🌐' },
  { value: 'SQL', label: 'SQL', icon: '🗄️' },
  { value: 'React', label: 'React', icon: '⚛️' },
  { value: 'Angular', label: 'Angular', icon: '🅰️' },
  { value: 'Vue', label: 'Vue', icon: '🟢' },
  { value: 'Node.js', label: 'Node.js', icon: '🟩' },
  { value: '.NET', label: '.NET', icon: '🟦' },
  { value: 'Django', label: 'Django', icon: '🎸' },
  { value: 'Spring', label: 'Spring', icon: '🌱' },
];

const RESOURCE_OPTIONS = [
  { value: 'Stack Overflow', label: 'Stack Overflow', icon: '📋' },
  { value: 'GitHub', label: 'GitHub', icon: '🐙' },
  { value: 'MDN', label: 'MDN', icon: '📖' },
  { value: 'Reddit', label: 'Reddit', icon: '🤖' },
  { value: 'Dev.to', label: 'Dev.to', icon: '✍️' },
  { value: 'W3Schools', label: 'W3Schools', icon: '🏫' },
  { value: 'Medium', label: 'Medium', icon: '📰' },
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
  const showProgramming = data.profile.usagePurposes.includes('Programmieren');

  const children: HTMLElement[] = relevant.map(q => {
    return sarahSelect({
      label: q.question,
      options: SKILL_LEVELS,
      value: (data.skills[q.skillKey] as string) ?? 'Mittel',
      onChange: (value) => { (data.skills[q.skillKey] as string | null) = value; },
    });
  });

  // Programming-specific fields
  if (showProgramming) {
    children.push(
      sarahTagSelect({
        label: 'Dein Techstack',
        options: TECHSTACK_OPTIONS,
        selected: data.skills.programmingStack,
        allowCustom: true,
        onChange: (values) => { data.skills.programmingStack = values; },
      }),
      sarahTagSelect({
        label: 'Wo suchst du nach Lösungen?',
        options: RESOURCE_OPTIONS,
        selected: data.skills.programmingResources,
        allowCustom: true,
        onChange: (values) => { data.skills.programmingResources = values; },
      }),
      sarahPathPicker({
        label: 'Wo liegen deine Projekte?',
        placeholder: 'z.B. D:\\projects oder ~/dev',
        value: data.skills.programmingProjectsFolder,
        onChange: (value) => { data.skills.programmingProjectsFolder = value; },
      }),
    );
  }

  const form = sarahForm({
    title: 'Vertiefung',
    description: 'Damit ich meine Antworten besser an dein Level anpassen kann.',
    children,
  });

  container.appendChild(form);
  return container;
}
