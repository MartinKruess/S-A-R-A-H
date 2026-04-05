import { SarahButton } from './sarah-button.js';
import { SarahInput } from './sarah-input.js';

export { SarahButton, sarahButton } from './sarah-button.js';
export { SarahInput, sarahInput } from './sarah-input.js';
export { SarahElement, createElement } from './base.js';

/** Register all custom elements. Call once at app startup. */
export function registerComponents(): void {
  customElements.define('sarah-button', SarahButton);
  customElements.define('sarah-input', SarahInput);
}
