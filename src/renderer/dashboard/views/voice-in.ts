import type { VoiceLevel } from '../../../core/ipc-contract.js';
import type { VoiceState } from '../../../services/voice/voice-types.js';
import { getSarah } from '../../shared/window-global.js';

const BAR_COUNT = 16;
const FLOOR = 0.05;

const STATE_LABELS: Record<VoiceState, string> = {
  idle: 'IDLE',
  listening: 'HÖRT ZU',
  processing: 'DENKT',
  speaking: 'SPRICHT',
};

function labelFor(state: string): string {
  if (state in STATE_LABELS) {
    return STATE_LABELS[state as VoiceState];
  }
  return state.toUpperCase();
}

export function createVoiceInBody(): { el: HTMLElement; dispose: () => void } {
  const el = document.createElement('div');
  el.className = 'voice-panel voice-panel--in';

  const controls = document.createElement('div');
  controls.className = 'voice-panel-controls';

  const muteBtn = document.createElement('span');
  muteBtn.className = 'voice-panel-btn-stub';
  muteBtn.dataset.variant = 'mute';
  muteBtn.textContent = 'MUTE';

  const devicePicker = document.createElement('span');
  devicePicker.className = 'voice-panel-btn-stub';
  devicePicker.dataset.variant = 'picker';
  devicePicker.textContent = 'Mikrofon: System-Standard';

  controls.appendChild(muteBtn);
  controls.appendChild(devicePicker);

  const meter = document.createElement('div');
  meter.className = 'voice-panel-meter';

  const stateEl = document.createElement('div');
  stateEl.className = 'voice-io-state';
  stateEl.dataset.state = 'idle';
  stateEl.textContent = STATE_LABELS.idle;

  const barsRow = document.createElement('div');
  barsRow.className = 'voice-io-bars';

  const bars: HTMLSpanElement[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement('span');
    bar.className = 'voice-io-bar';
    bar.style.setProperty('--v', String(FLOOR));
    barsRow.appendChild(bar);
    bars.push(bar);
  }

  meter.appendChild(stateEl);
  meter.appendChild(barsRow);

  const sliders = document.createElement('div');
  sliders.className = 'voice-panel-sliders';

  const volStub = document.createElement('div');
  volStub.className = 'voice-panel-slider-stub';
  volStub.dataset.label = 'VOL';

  const gainStub = document.createElement('div');
  gainStub.className = 'voice-panel-slider-stub';
  gainStub.dataset.label = 'GAIN';

  sliders.appendChild(volStub);
  sliders.appendChild(gainStub);

  el.appendChild(controls);
  el.appendChild(meter);
  el.appendChild(sliders);

  const applyLevel = (data: VoiceLevel): void => {
    const n = Math.min(bars.length, data.bars.length);
    for (let i = 0; i < n; i++) {
      const v = Math.max(FLOOR, Math.min(1, data.bars[i]));
      bars[i].style.setProperty('--v', v.toFixed(3));
    }
  };

  const applyState = (payload: { state: VoiceState }): void => {
    stateEl.dataset.state = payload.state;
    stateEl.textContent = labelFor(payload.state);
  };

  const sarah = getSarah();
  let unsubLevel: (() => void) | null = sarah.onVoiceLevel(applyLevel);
  let unsubState: (() => void) | null = sarah.voice.onStateChange(applyState);

  sarah.voice
    .getState()
    .then((state) => applyState({ state }))
    .catch((err: Error) => {
      console.warn('[VoiceIn] initial voice state fetch failed:', err);
    });

  const dispose = (): void => {
    if (unsubLevel) {
      unsubLevel();
      unsubLevel = null;
    }
    if (unsubState) {
      unsubState();
      unsubState = null;
    }
  };

  return { el, dispose };
}
