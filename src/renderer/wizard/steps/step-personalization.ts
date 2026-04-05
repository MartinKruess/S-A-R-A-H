import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahSelect } from '../../components/sarah-select.js';

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

export function createPersonalizationStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = PERS_CSS;
  container.appendChild(style);

  // Color picker section
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

      // Live preview: update CSS variable
      document.documentElement.style.setProperty('--sarah-accent', color.value);
      const rgb = hexToRgb(color.value);
      if (rgb) {
        document.documentElement.style.setProperty('--sarah-accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
      }
    });
    colorGrid.appendChild(swatch);
  }

  colorSection.appendChild(colorLabel);
  colorSection.appendChild(colorGrid);

  // Voice + speech rate
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

  const form = sarahForm({
    title: 'Personalisierung',
    description: 'Passe S.A.R.A.H. an deinen Geschmack an. Du kannst alles später in den Einstellungen ändern.',
    children: [colorSection, voiceSelect],
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
