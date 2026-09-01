import { createSectionHeader, saveAudio, showSaved } from '../../../shared/settings-utils.js';
import type { AudioConfig, SarahConfig } from '../../../../core/config-schema.js';

type HudSelectElement = HTMLElement & { value: string };

export function createAudioDevicePatch(
  field: 'inputDeviceId' | 'outputDeviceId',
  value: string,
): Partial<AudioConfig> {
  return { [field]: value || undefined };
}

export function createAudioSection(config: SarahConfig): HTMLElement {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Audio');
  section.appendChild(header);

  const controls = document.createElement('div');
  controls.className = 'settings-control-stack';

  const inputEl = document.createElement('hud-select') as HudSelectElement;
  inputEl.setAttribute('kind', 'audioinput');
  inputEl.value = config.audio.inputDeviceId ?? '';
  inputEl.addEventListener('change', (e) => {
    const value = (e as CustomEvent<{ value: string }>).detail.value;
    saveAudio(createAudioDevicePatch('inputDeviceId', value));
    showSaved(feedback);
  });
  controls.appendChild(inputEl);

  const outputEl = document.createElement('hud-select') as HudSelectElement;
  outputEl.setAttribute('kind', 'audiooutput');
  outputEl.value = config.audio.outputDeviceId ?? '';
  outputEl.addEventListener('change', (e) => {
    const value = (e as CustomEvent<{ value: string }>).detail.value;
    saveAudio(createAudioDevicePatch('outputDeviceId', value));
    showSaved(feedback);
  });
  controls.appendChild(outputEl);
  section.appendChild(controls);

  return section;
}
