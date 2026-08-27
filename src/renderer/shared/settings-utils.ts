import type { AudioConfig, SarahConfig } from '../../core/config-schema.js';
import type { SaveConfigResult } from '../../core/config-apply.js';
import { getSarah } from './window-global.js';

export { getSarah };

let latestSave: Promise<SaveConfigResult> | null = null;
const feedbackTokens = new WeakMap<HTMLElement, symbol>();

export function showSaved(feedback: HTMLElement): void {
  const operation = latestSave;
  const token = Symbol('save-feedback');
  feedbackTokens.set(feedback, token);
  feedback.textContent = operation ? 'Speichern ...' : 'Gespeichert!';
  feedback.classList.add('visible');

  if (!operation) {
    setTimeout(() => feedback.classList.remove('visible'), 2000);
    return;
  }

  void operation.then((result) => {
    if (feedbackTokens.get(feedback) !== token) return;
    feedback.textContent = result.restartRequired
      ? `Gespeichert – Neustart nötig (${result.restartReasons.join(', ')})`
      : 'Gespeichert!';
    setTimeout(() => {
      if (feedbackTokens.get(feedback) === token) feedback.classList.remove('visible');
    }, result.restartRequired ? 5000 : 2000);
  }).catch((error) => {
    if (feedbackTokens.get(feedback) !== token) return;
    feedback.textContent = 'Speichern fehlgeschlagen';
    console.warn('[Settings] save failed:', error);
    setTimeout(() => {
      if (feedbackTokens.get(feedback) === token) feedback.classList.remove('visible');
    }, 5000);
  });
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

export function save(
  key: string,
  value: Partial<SarahConfig>[keyof SarahConfig],
): Promise<SaveConfigResult> {
  latestSave = getSarah().saveConfig({ [key]: value } as Partial<SarahConfig>);
  // Attach an observer even where a section intentionally has no visual feedback.
  void latestSave.catch((error) => console.warn('[Settings] save failed:', error));
  return latestSave;
}

/** Persist an audio partial without widening it to the full AudioConfig. */
export function saveAudio(value: Partial<AudioConfig>): Promise<SaveConfigResult> {
  latestSave = getSarah().saveConfig({ audio: value });
  void latestSave.catch((error) => console.warn('[Settings] save failed:', error));
  return latestSave;
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
