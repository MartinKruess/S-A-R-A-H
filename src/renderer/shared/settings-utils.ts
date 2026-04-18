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
  spacer.style.height = `var(--sarah-space-${size})`;
  return spacer;
}

export function createHint(text: string): HTMLElement {
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-text-muted); line-height: 1.4; padding: var(--sarah-space-xs) 0;';
  hint.textContent = text;
  return hint;
}
