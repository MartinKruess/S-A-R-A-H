import type { SarahConfig } from '../../core/config-schema.js';
import { getSarah } from './window-global.js';

export { getSarah };

export function showSaved(feedback: HTMLElement): void {
  feedback.classList.add('visible');
  setTimeout(() => feedback.classList.remove('visible'), 2000);
}

export function createSectionHeader(titleText: string): { header: HTMLElement; feedback: HTMLElement } {
  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = titleText;
  const feedback = document.createElement('span');
  feedback.className = 'save-feedback';
  feedback.textContent = 'Gespeichert!';
  header.appendChild(title);
  header.appendChild(feedback);
  return { header, feedback };
}

export function save(key: string, value: Partial<SarahConfig>[keyof SarahConfig]): void {
  getSarah().saveConfig({ [key]: value } as Partial<SarahConfig>);
}

export function createSpacer(size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const spacer = document.createElement('div');
  spacer.className = `settings-spacer-${size}`;
  return spacer;
}

export function createHint(text: string): HTMLElement {
  const hint = document.createElement('div');
  hint.className = 'settings-hint';
  hint.textContent = text;
  return hint;
}
