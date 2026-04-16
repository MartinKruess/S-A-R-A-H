import { sarahInput } from '../../../components/sarah-input.js';
import { sarahSelect } from '../../../components/sarah-select.js';
import { sarahToggle } from '../../../components/sarah-toggle.js';
import { sarahTagSelect } from '../../../components/sarah-tag-select.js';
import { applyAccentColor } from '../../accent.js';
import { showSaved, createSectionHeader, save } from '../../../shared/settings-utils.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

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

export function createPersonalizationSection(config: SarahConfig): HTMLElement {
  const pers = { ...config.personalization };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Personalisierung');
  section.appendChild(header);

  // Accent color picker
  const colorLabel = document.createElement('div');
  colorLabel.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-secondary); margin-bottom: var(--sarah-space-xs);';
  colorLabel.textContent = 'Akzentfarbe';
  section.appendChild(colorLabel);

  const colorGrid = document.createElement('div');
  colorGrid.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: var(--sarah-space-lg);';

  for (const color of ACCENT_COLORS) {
    const swatch = document.createElement('div');
    swatch.style.cssText = `width: 40px; height: 40px; border-radius: var(--sarah-radius-md); border: 2px solid transparent; cursor: pointer; transition: all var(--sarah-transition-fast); background-color: ${color.value};`;
    if (pers.accentColor === color.value) {
      swatch.style.borderColor = 'var(--sarah-text-primary)';
      swatch.style.boxShadow = `0 0 12px ${color.value}`;
    }
    swatch.title = color.label;
    swatch.addEventListener('click', () => {
      pers.accentColor = color.value;
      applyAccentColor(color.value);
      colorGrid.querySelectorAll('div').forEach(s => {
        (s as HTMLElement).style.borderColor = 'transparent';
        (s as HTMLElement).style.boxShadow = 'none';
      });
      swatch.style.borderColor = 'var(--sarah-text-primary)';
      swatch.style.boxShadow = `0 0 12px ${color.value}`;
      save('personalization', pers);
      showSaved(feedback);
    });
    colorGrid.appendChild(swatch);
  }
  section.appendChild(colorGrid);

  const grid = document.createElement('div');
  grid.className = 'settings-grid';

  grid.appendChild(sarahSelect({
    label: 'Stimme',
    options: [
      { value: 'default-female-de', label: 'Standard (Deutsch, weiblich)' },
      { value: 'default-female-en', label: 'Standard (English, female)' },
      { value: 'warm-female-de', label: 'Warm (Deutsch, weiblich)' },
    ],
    value: pers.voice || 'default-female-de',
    onChange: (val) => { pers.voice = val; save('personalization', pers); showSaved(feedback); },
  }));

  grid.appendChild(sarahSelect({
    label: 'Sprechgeschwindigkeit',
    options: [
      { value: '0.8', label: 'Langsam' },
      { value: '1', label: 'Normal' },
      { value: '1.2', label: 'Schnell' },
    ],
    value: String(pers.speechRate ?? 1),
    onChange: (val) => { pers.speechRate = parseFloat(val); save('personalization', pers); showSaved(feedback); },
  }));

  grid.appendChild(sarahSelect({
    label: 'Chat-Schriftgröße',
    options: [
      { value: 'small', label: 'Klein' },
      { value: 'default', label: 'Standard' },
      { value: 'large', label: 'Groß' },
    ],
    value: pers.chatFontSize || 'default',
    onChange: (val) => { pers.chatFontSize = val as typeof pers.chatFontSize; save('personalization', pers); showSaved(feedback); },
  }));

  grid.appendChild(sarahSelect({
    label: 'Chat-Ausrichtung',
    options: [
      { value: 'stacked', label: 'Untereinander (wie ChatGPT)' },
      { value: 'bubbles', label: 'Bubbles (wie WhatsApp)' },
    ],
    value: pers.chatAlignment || 'stacked',
    onChange: (val) => { pers.chatAlignment = val as typeof pers.chatAlignment; save('personalization', pers); showSaved(feedback); },
  }));

  section.appendChild(grid);

  // ── Response settings group ──
  const responseGrid = document.createElement('div');
  responseGrid.className = 'settings-grid';

  responseGrid.appendChild(sarahSelect({
    label: 'Antwortsprache',
    options: [
      { value: 'de', label: 'Deutsch' },
      { value: 'en', label: 'English' },
    ],
    value: pers.responseLanguage || 'de',
    onChange: (val) => { pers.responseLanguage = val as typeof pers.responseLanguage; save('personalization', pers); showSaved(feedback); },
  }));

  responseGrid.appendChild(sarahSelect({
    label: 'Antwortstil',
    options: [
      { value: 'kurz', label: 'Kurz & knapp' },
      { value: 'mittel', label: 'Ausgewogen' },
      { value: 'ausführlich', label: 'Ausführlich' },
    ],
    value: pers.responseStyle || 'mittel',
    onChange: (val) => { pers.responseStyle = val as typeof pers.responseStyle; save('personalization', pers); showSaved(feedback); },
  }));

  responseGrid.appendChild(sarahSelect({
    label: 'Tonfall',
    options: [
      { value: 'freundlich', label: 'Freundlich' },
      { value: 'professionell', label: 'Professionell' },
      { value: 'locker', label: 'Locker' },
    ],
    value: pers.tone || 'freundlich',
    onChange: (val) => { pers.tone = val as typeof pers.tone; save('personalization', pers); showSaved(feedback); },
  }));

  section.appendChild(responseGrid);

  const responseSpacer = document.createElement('div');
  responseSpacer.style.height = 'var(--sarah-space-md)';
  section.appendChild(responseSpacer);

  section.appendChild(sarahToggle({
    label: 'Smileys & Icons',
    description: 'Sarah darf Emojis in Antworten verwenden',
    checked: pers.emojisEnabled !== false,
    onChange: (val) => { pers.emojisEnabled = val; save('personalization', pers); showSaved(feedback); },
  }));

  const spacer = document.createElement('div');
  spacer.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer);

  section.appendChild(sarahSelect({
    label: 'Antwortmodus',
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'spontaneous', label: 'Spontan — kurz und direkt' },
      { value: 'thoughtful', label: 'Nachdenklich — gründlich und ausführlich' },
    ],
    value: pers.responseMode || 'normal',
    onChange: (val) => { pers.responseMode = val as typeof pers.responseMode; save('personalization', pers); showSaved(feedback); },
  }));

  const spacer2 = document.createElement('div');
  spacer2.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer2);

  // Character traits
  const traits = pers.characterTraits || [];
  const traitsSelect = sarahTagSelect({
    label: 'Charakter-Eigenschaften (max. 2)',
    options: TRAIT_OPTIONS,
    selected: traits,
    allowCustom: true,
    onChange: (values) => {
      if (values.length <= 2) {
        pers.characterTraits = values;
      } else {
        const trimmed = values.slice(-2);
        pers.characterTraits = trimmed;
        traitsSelect.setSelected(trimmed);
      }
      save('personalization', pers);
      showSaved(feedback);
    },
  });
  section.appendChild(traitsSelect);

  const spacer3 = document.createElement('div');
  spacer3.style.height = 'var(--sarah-space-md)';
  section.appendChild(spacer3);

  // Quirk
  const quirkWrapper = document.createElement('div');
  const customQuirkInput = sarahInput({
    label: 'Deine Eigenart',
    placeholder: 'z.B. Sage ab und zu "Wunderbar!" wenn etwas klappt',
    value: pers.quirk && !QUIRK_OPTIONS.some(q => q.value === pers.quirk) ? pers.quirk : '',
    onChange: (value) => { pers.quirk = value || 'custom'; save('personalization', pers); showSaved(feedback); },
  });
  customQuirkInput.style.display = pers.quirk === 'custom' || (pers.quirk && !QUIRK_OPTIONS.some(q => q.value === pers.quirk)) ? 'block' : 'none';
  customQuirkInput.style.marginTop = 'var(--sarah-space-sm)';

  const quirkHint = document.createElement('div');
  quirkHint.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-muted); margin-top: var(--sarah-space-xs); line-height: 1.4;';
  quirkHint.textContent = 'Beschreibe Sarahs Eigenart. Sexualisierte oder beleidigende Inhalte werden nicht akzeptiert.';
  quirkHint.style.display = customQuirkInput.style.display;

  quirkWrapper.appendChild(sarahSelect({
    label: 'Eigenart',
    options: QUIRK_OPTIONS,
    value: pers.quirk ?? '',
    onChange: (value) => {
      if (value === 'custom') {
        customQuirkInput.style.display = 'block';
        quirkHint.style.display = 'block';
        pers.quirk = 'custom';
      } else {
        customQuirkInput.style.display = 'none';
        quirkHint.style.display = 'none';
        pers.quirk = value || null;
      }
      save('personalization', pers);
      showSaved(feedback);
    },
  }));
  quirkWrapper.appendChild(customQuirkInput);
  quirkWrapper.appendChild(quirkHint);
  section.appendChild(quirkWrapper);

  return section;
}
