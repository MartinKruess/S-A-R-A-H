import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahInput } from '../../components/sarah-input.js';

const PERS_CSS = `
  .color-grid {
    display: flex;
    gap: var(--sarah-space-sm);
    flex-wrap: wrap;
  }

  .color-swatch {
    width: 40px;
    height: 40px;
    border-radius: var(--sarah-radius-md);
    border: 2px solid transparent;
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
  }

  .color-swatch:hover {
    transform: scale(1.1);
  }

  .color-swatch.selected {
    border-color: var(--sarah-text-primary);
    box-shadow: 0 0 12px currentColor;
  }

  .color-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    margin-bottom: var(--sarah-space-xs);
    letter-spacing: 0.03em;
  }

  .color-section {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-xs);
  }

  .section-heading {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: var(--sarah-space-lg);
    margin-bottom: var(--sarah-space-xs);
  }

  .section-heading:first-of-type {
    margin-top: 0;
  }

  .quirk-custom-input {
    margin-top: var(--sarah-space-sm);
  }

  .quirk-hint {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    margin-top: var(--sarah-space-xs);
    line-height: 1.4;
  }
`;

const ACCENT_COLORS = [
  { value: '#00d4ff', label: 'Cyan' },
  { value: '#4466ff', label: 'Blau' },
  { value: '#8855ff', label: 'Violett' },
  { value: '#ff8844', label: 'Orange' },
  { value: '#44ff88', label: 'Grün' },
  { value: '#ff4488', label: 'Pink' },
  { value: '#ffcc00', label: 'Gold' },
  { value: '#ff5555', label: 'Rot' },
];

const TRAIT_OPTIONS = [
  { value: 'Humorvoll', label: 'Humorvoll', icon: '😄' },
  { value: 'Sarkastisch', label: 'Sarkastisch', icon: '😏' },
  { value: 'Schnippisch', label: 'Schnippisch', icon: '💅' },
  { value: 'Eifersüchtig', label: 'Eifersüchtig (auf andere KIs)', icon: '😤' },
  { value: 'Selbstsicher', label: 'Selbstsicher', icon: '💪' },
  { value: 'Unsicher', label: 'Unsicher/Schüchtern', icon: '🥺' },
];

const QUIRK_OPTIONS = [
  { value: '', label: 'Keine Eigenart' },
  { value: 'miauz', label: 'Miauz Genau!' },
  { value: 'gamertalk', label: 'Gamertalk' },
  { value: 'nerd', label: 'Prof. Dr. Dr.' },
  { value: 'oldschool', label: 'Oldschool' },
  { value: 'altertum', label: 'Altertum' },
  { value: 'pirat', label: 'Pirat' },
  { value: 'custom', label: 'Eigene...' },
];

function createSectionHeading(text: string): HTMLElement {
  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = text;
  return heading;
}

export function createPersonalizationStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = PERS_CSS;
  container.appendChild(style);

  // === SECTION: Aussehen ===
  const sectionAussehen = createSectionHeading('Aussehen');

  // Color picker
  const colorSection = document.createElement('div');
  colorSection.className = 'color-section';
  const colorLabel = document.createElement('div');
  colorLabel.className = 'color-label';
  colorLabel.textContent = 'Akzentfarbe';
  const colorGrid = document.createElement('div');
  colorGrid.className = 'color-grid';

  for (const color of ACCENT_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    if (data.personalization.accentColor === color.value) {
      swatch.classList.add('selected');
    }
    swatch.style.backgroundColor = color.value;
    swatch.style.color = color.value;
    swatch.title = color.label;
    swatch.addEventListener('click', () => {
      data.personalization.accentColor = color.value;
      colorGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
      document.documentElement.style.setProperty('--sarah-accent', color.value);
      const rgb = hexToRgb(color.value);
      if (rgb) {
        document.documentElement.style.setProperty('--sarah-accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
        document.documentElement.style.setProperty('--sarah-accent-hover', lightenHex(rgb.r, rgb.g, rgb.b));
      }
    });
    colorGrid.appendChild(swatch);
  }

  colorSection.appendChild(colorLabel);
  colorSection.appendChild(colorGrid);

  const voiceSelect = sarahSelect({
    label: 'Sarahs Stimme',
    options: [
      { value: 'default-female-de', label: 'Standard (Deutsch, weiblich)' },
      { value: 'default-female-en', label: 'Standard (English, female)' },
      { value: 'warm-female-de', label: 'Warm (Deutsch, weiblich)' },
    ],
    value: data.personalization.voice,
    onChange: (value) => { data.personalization.voice = value; },
  });

  // === SECTION: Chat ===
  const sectionChat = createSectionHeading('Chat');

  const fontSizeSelect = sarahSelect({
    label: 'Schriftgröße',
    options: [
      { value: 'small', label: 'Klein' },
      { value: 'default', label: 'Standard' },
      { value: 'large', label: 'Groß' },
    ],
    value: data.personalization.chatFontSize,
    onChange: (value) => { data.personalization.chatFontSize = value as 'small' | 'default' | 'large'; },
  });

  const alignmentSelect = sarahSelect({
    label: 'Ausrichtung',
    options: [
      { value: 'stacked', label: 'Untereinander (wie ChatGPT)' },
      { value: 'bubbles', label: 'Bubbles (wie WhatsApp)' },
    ],
    value: data.personalization.chatAlignment,
    onChange: (value) => { data.personalization.chatAlignment = value as 'stacked' | 'bubbles'; },
  });

  const emojisToggle = sarahToggle({
    label: 'Smileys & Icons',
    description: 'Sarah darf Emojis in Antworten verwenden',
    checked: data.personalization.emojisEnabled,
    onChange: (value) => { data.personalization.emojisEnabled = value; },
  });

  // === SECTION: Verhalten ===
  const sectionVerhalten = createSectionHeading('Verhalten');

  const responseLanguageSelect = sarahSelect({
    label: 'Antwortsprache',
    options: [
      { value: 'de', label: 'Deutsch' },
      { value: 'en', label: 'English' },
    ],
    value: data.personalization.responseLanguage || 'de',
    onChange: (value) => { data.personalization.responseLanguage = value as 'de' | 'en'; },
  });

  const responseStyleSelect = sarahSelect({
    label: 'Wie soll ich antworten?',
    options: [
      { value: 'kurz', label: 'Kurz & knapp' },
      { value: 'mittel', label: 'Normal' },
      { value: 'ausführlich', label: 'Ausführlich' },
    ],
    value: data.personalization.responseStyle,
    onChange: (value) => { data.personalization.responseStyle = value as 'kurz' | 'mittel' | 'ausführlich'; },
  });

  const toneSelect = sarahSelect({
    label: 'Wie soll ich klingen?',
    options: [
      { value: 'freundlich', label: 'Freundlich' },
      { value: 'professionell', label: 'Professionell' },
      { value: 'locker', label: 'Locker' },
    ],
    value: data.personalization.tone,
    onChange: (value) => { data.personalization.tone = value as 'freundlich' | 'professionell' | 'locker' | 'direkt'; },
  });

  const responseModeSelect = sarahSelect({
    label: 'Antwortmodus',
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'spontaneous', label: 'Spontan — kurz und direkt' },
      { value: 'thoughtful', label: 'Nachdenklich — gründlich und ausführlich' },
    ],
    value: data.personalization.responseMode,
    onChange: (value) => { data.personalization.responseMode = value as 'normal' | 'spontaneous' | 'thoughtful'; },
  });

  const traitsSelect = sarahTagSelect({
    label: 'Charakter-Eigenschaften (max. 2)',
    options: TRAIT_OPTIONS,
    selected: data.personalization.characterTraits,
    allowCustom: true,
    onChange: (values) => {
      if (values.length <= 2) {
        data.personalization.characterTraits = values;
      } else {
        const trimmed = values.slice(-2);
        data.personalization.characterTraits = trimmed;
        traitsSelect.setSelected(trimmed);
      }
    },
  });

  // Quirk select + conditional custom input
  const quirkWrapper = document.createElement('div');

  const quirkSelect = sarahSelect({
    label: 'Eigenart',
    options: QUIRK_OPTIONS,
    value: data.personalization.quirk ?? '',
    onChange: (value) => {
      if (value === 'custom') {
        customQuirkInput.style.display = 'block';
        quirkHint.style.display = 'block';
        data.personalization.quirk = 'custom';
      } else {
        customQuirkInput.style.display = 'none';
        quirkHint.style.display = 'none';
        data.personalization.quirk = value || null;
      }
    },
  });

  const customQuirkInput = sarahInput({
    label: 'Deine Eigenart',
    placeholder: 'z.B. Sage ab und zu "Wunderbar!" wenn etwas klappt',
    value: data.personalization.quirk && !QUIRK_OPTIONS.some(q => q.value === data.personalization.quirk) ? data.personalization.quirk : '',
    onChange: (value) => { data.personalization.quirk = value || 'custom'; },
  });
  customQuirkInput.className = 'quirk-custom-input';
  customQuirkInput.style.display = data.personalization.quirk === 'custom' || (data.personalization.quirk && !QUIRK_OPTIONS.some(q => q.value === data.personalization.quirk)) ? 'block' : 'none';

  const quirkHint = document.createElement('div');
  quirkHint.className = 'quirk-hint';
  quirkHint.textContent = 'Beschreibe Sarahs Eigenart. Sexualisierte oder beleidigende Inhalte werden nicht akzeptiert.';
  quirkHint.style.display = customQuirkInput.style.display;

  quirkWrapper.appendChild(quirkSelect);
  quirkWrapper.appendChild(customQuirkInput);
  quirkWrapper.appendChild(quirkHint);

  // === FORM ===
  const form = sarahForm({
    title: 'Personalisierung',
    description: 'Passe S.A.R.A.H. an deinen Geschmack an. Du kannst alles später in den Einstellungen ändern.',
    children: [
      sectionAussehen,
      colorSection,
      voiceSelect,
      sectionChat,
      fontSizeSelect,
      alignmentSelect,
      emojisToggle,
      sectionVerhalten,
      responseLanguageSelect,
      responseStyleSelect,
      toneSelect,
      responseModeSelect,
      traitsSelect,
      quirkWrapper,
    ],
  });

  container.appendChild(form);
  return container;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}

function lightenHex(r: number, g: number, b: number, amount = 0.2): string {
  const lr = Math.min(255, Math.round(r + (255 - r) * amount));
  const lg = Math.min(255, Math.round(g + (255 - g) * amount));
  const lb = Math.min(255, Math.round(b + (255 - b) * amount));
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
}
