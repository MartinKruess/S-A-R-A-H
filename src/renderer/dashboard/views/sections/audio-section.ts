import { createSectionHeader, createSpacer, save, showSaved } from '../../../shared/settings-utils.js';
import type { SarahConfig } from '../../../../core/config-schema.js';

type HudSelectElement = HTMLElement & { value: string };

export function createAudioSection(config: SarahConfig): HTMLElement {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Audio');
  section.appendChild(header);

  const audio = { ...(config.audio ?? {}) };

  const inputEl = document.createElement('hud-select') as HudSelectElement;
  inputEl.setAttribute('kind', 'audioinput');
  inputEl.value = audio.inputDeviceId ?? '';
  inputEl.addEventListener('change', (e) => {
    const value = (e as CustomEvent<{ value: string }>).detail.value;
    audio.inputDeviceId = value || undefined;
    save('audio', audio);
    showSaved(feedback);
  });
  section.appendChild(inputEl);

  section.appendChild(createSpacer());

  const outputEl = document.createElement('hud-select') as HudSelectElement;
  outputEl.setAttribute('kind', 'audiooutput');
  outputEl.value = audio.outputDeviceId ?? '';
  outputEl.addEventListener('change', (e) => {
    const value = (e as CustomEvent<{ value: string }>).detail.value;
    audio.outputDeviceId = value || undefined;
    save('audio', audio);
    showSaved(feedback);
  });
  section.appendChild(outputEl);

  return section;
}
