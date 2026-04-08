import { SarahButton } from './sarah-button.js';
import { SarahInput } from './sarah-input.js';
import { SarahSelect } from './sarah-select.js';
import { SarahForm } from './sarah-form.js';
import { SarahCard } from './sarah-card.js';
import { SarahProgress } from './sarah-progress.js';
import { SarahStepper } from './sarah-stepper.js';
import { SarahSlide } from './sarah-slide.js';
import { SarahTagSelect } from './sarah-tag-select.js';
import { SarahToggle } from './sarah-toggle.js';
import { SarahPathPicker } from './sarah-path-picker.js';
import { SarahSvg } from './sarah-svg.js';

export { SarahButton, sarahButton } from './sarah-button.js';
export { SarahInput, sarahInput } from './sarah-input.js';
export { SarahSelect, sarahSelect } from './sarah-select.js';
export type { SelectOption } from './sarah-select.js';
export { SarahForm, sarahForm } from './sarah-form.js';
export { SarahCard, sarahCard } from './sarah-card.js';
export { SarahProgress, sarahProgress } from './sarah-progress.js';
export { SarahStepper, sarahStepper } from './sarah-stepper.js';
export type { StepperStep } from './sarah-stepper.js';
export { SarahSlide, sarahSlide } from './sarah-slide.js';
export { SarahTagSelect, sarahTagSelect } from './sarah-tag-select.js';
export type { TagOption } from './sarah-tag-select.js';
export { SarahToggle, sarahToggle } from './sarah-toggle.js';
export { SarahPathPicker, sarahPathPicker } from './sarah-path-picker.js';
export { SarahSvg, sarahSvg } from './sarah-svg.js';
export { SarahElement, createElement, type ChildrenProp } from './base.js';

/** Register all custom elements. Call once at app startup. */
export function registerComponents(): void {
  customElements.define('sarah-button', SarahButton);
  customElements.define('sarah-input', SarahInput);
  customElements.define('sarah-select', SarahSelect);
  customElements.define('sarah-form', SarahForm);
  customElements.define('sarah-card', SarahCard);
  customElements.define('sarah-progress', SarahProgress);
  customElements.define('sarah-stepper', SarahStepper);
  customElements.define('sarah-slide', SarahSlide);
  customElements.define('sarah-tag-select', SarahTagSelect);
  customElements.define('sarah-toggle', SarahToggle);
  customElements.define('sarah-path-picker', SarahPathPicker);
  customElements.define('sarah-svg', SarahSvg);
}
