import { sarahSelect } from '../components/sarah-select.js';
import { sarahToggle } from '../components/sarah-toggle.js';
import { sarahTagSelect } from '../components/sarah-tag-select.js';
import { sarahInput } from '../components/sarah-input.js';
import { applyAccentColor } from './accent.js';
import { ACCENT_COLORS, TRAIT_OPTIONS, QUIRK_OPTIONS } from './personalization-constants.js';
import type { Personalization } from '../../core/config-schema.js';

export type PersonalizationValues = Personalization;

export function buildAccentPicker(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display: flex; flex-direction: column; gap: var(--sarah-space-xs);';

  const label = document.createElement('div');
  label.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-secondary); margin-bottom: var(--sarah-space-xs); letter-spacing: 0.03em;';
  label.textContent = 'Akzentfarbe';
  wrapper.appendChild(label);

  const grid = document.createElement('div');
  grid.style.cssText = 'display: flex; gap: var(--sarah-space-sm); flex-wrap: wrap;';

  const setSwatchSelected = (el: HTMLElement, value: string): void => {
    el.style.borderColor = 'var(--sarah-text-primary)';
    el.style.boxShadow = `0 0 12px ${value}`;
  };
  const clearSwatchSelected = (el: HTMLElement): void => {
    el.style.borderColor = 'transparent';
    el.style.boxShadow = 'none';
  };

  for (const color of ACCENT_COLORS) {
    const swatch = document.createElement('div');
    swatch.style.cssText = `width: 40px; height: 40px; border-radius: var(--sarah-radius-md); border: 2px solid transparent; cursor: pointer; transition: all var(--sarah-transition-fast); background-color: ${color.value};`;
    if (pers.accentColor === color.value) {
      setSwatchSelected(swatch, color.value);
    }
    swatch.title = color.label;
    swatch.addEventListener('mouseenter', () => { swatch.style.transform = 'scale(1.1)'; });
    swatch.addEventListener('mouseleave', () => { swatch.style.transform = 'scale(1)'; });
    swatch.addEventListener('click', () => {
      pers.accentColor = color.value;
      applyAccentColor(color.value);
      grid.querySelectorAll('div').forEach(s => clearSwatchSelected(s as HTMLElement));
      setSwatchSelected(swatch, color.value);
      onChange?.();
    });
    grid.appendChild(swatch);
  }

  wrapper.appendChild(grid);
  return wrapper;
}

export function buildVoiceSelect(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  return sarahSelect({
    label: 'Stimme',
    options: [
      { value: 'default-female-de', label: 'Standard (Deutsch, weiblich)' },
      { value: 'default-female-en', label: 'Standard (English, female)' },
      { value: 'warm-female-de', label: 'Warm (Deutsch, weiblich)' },
    ],
    value: pers.voice || 'default-female-de',
    onChange: (val) => { pers.voice = val; onChange?.(); },
  });
}

export function buildSpeechRateSelect(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  return sarahSelect({
    label: 'Sprechgeschwindigkeit',
    options: [
      { value: '0.8', label: 'Langsam' },
      { value: '1', label: 'Normal' },
      { value: '1.2', label: 'Schnell' },
    ],
    value: String(pers.speechRate ?? 1),
    onChange: (val) => { pers.speechRate = parseFloat(val); onChange?.(); },
  });
}

export function buildChatFontSizeSelect(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  return sarahSelect({
    label: 'Schriftgröße',
    options: [
      { value: 'small', label: 'Klein' },
      { value: 'default', label: 'Standard' },
      { value: 'large', label: 'Groß' },
    ],
    value: pers.chatFontSize || 'default',
    onChange: (val) => { pers.chatFontSize = val as PersonalizationValues['chatFontSize']; onChange?.(); },
  });
}

export function buildChatAlignmentSelect(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  return sarahSelect({
    label: 'Ausrichtung',
    options: [
      { value: 'stacked', label: 'Untereinander (wie ChatGPT)' },
      { value: 'bubbles', label: 'Bubbles (wie WhatsApp)' },
    ],
    value: pers.chatAlignment || 'stacked',
    onChange: (val) => { pers.chatAlignment = val as PersonalizationValues['chatAlignment']; onChange?.(); },
  });
}

export function buildResponseLanguageSelect(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  return sarahSelect({
    label: 'Antwortsprache',
    options: [
      { value: 'de', label: 'Deutsch' },
      { value: 'en', label: 'English' },
    ],
    value: pers.responseLanguage || 'de',
    onChange: (val) => { pers.responseLanguage = val as PersonalizationValues['responseLanguage']; onChange?.(); },
  });
}

export function buildResponseStyleSelect(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  return sarahSelect({
    label: 'Antwortstil',
    options: [
      { value: 'kurz', label: 'Kurz & knapp' },
      { value: 'mittel', label: 'Normal' },
      { value: 'ausführlich', label: 'Ausführlich' },
    ],
    value: pers.responseStyle || 'mittel',
    onChange: (val) => { pers.responseStyle = val as PersonalizationValues['responseStyle']; onChange?.(); },
  });
}

export function buildToneSelect(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  return sarahSelect({
    label: 'Tonfall',
    options: [
      { value: 'freundlich', label: 'Freundlich' },
      { value: 'professionell', label: 'Professionell' },
      { value: 'locker', label: 'Locker' },
    ],
    value: pers.tone || 'freundlich',
    onChange: (val) => { pers.tone = val as PersonalizationValues['tone']; onChange?.(); },
  });
}

export function buildResponseModeSelect(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  return sarahSelect({
    label: 'Antwortmodus',
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'spontaneous', label: 'Spontan — kurz und direkt' },
      { value: 'thoughtful', label: 'Nachdenklich — gründlich und ausführlich' },
    ],
    value: pers.responseMode || 'normal',
    onChange: (val) => { pers.responseMode = val as PersonalizationValues['responseMode']; onChange?.(); },
  });
}

export function buildEmojisToggle(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  return sarahToggle({
    label: 'Smileys & Icons',
    description: 'Sarah darf Emojis in Antworten verwenden',
    checked: pers.emojisEnabled !== false,
    onChange: (val) => { pers.emojisEnabled = val; onChange?.(); },
  });
}

export function buildTraitsSelect(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
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
      onChange?.();
    },
  });
  return traitsSelect;
}

export function buildQuirkGroup(pers: PersonalizationValues, onChange?: () => void): HTMLElement {
  const wrapper = document.createElement('div');

  const isCustomValue = !!pers.quirk && !QUIRK_OPTIONS.some(q => q.value === pers.quirk);
  const showCustom = pers.quirk === 'custom' || isCustomValue;

  const customQuirkInput = sarahInput({
    label: 'Deine Eigenart',
    placeholder: 'z.B. Sage ab und zu "Wunderbar!" wenn etwas klappt',
    value: isCustomValue ? (pers.quirk ?? '') : '',
    onChange: (value) => { pers.quirk = value || 'custom'; onChange?.(); },
  });
  customQuirkInput.style.display = showCustom ? 'block' : 'none';
  customQuirkInput.style.marginTop = 'var(--sarah-space-sm)';

  const quirkHint = document.createElement('div');
  quirkHint.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-muted); margin-top: var(--sarah-space-xs); line-height: 1.4;';
  quirkHint.textContent = 'Beschreibe Sarahs Eigenart. Sexualisierte oder beleidigende Inhalte werden nicht akzeptiert.';
  quirkHint.style.display = showCustom ? 'block' : 'none';

  const quirkSelect = sarahSelect({
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
      onChange?.();
    },
  });

  wrapper.appendChild(quirkSelect);
  wrapper.appendChild(customQuirkInput);
  wrapper.appendChild(quirkHint);
  return wrapper;
}
