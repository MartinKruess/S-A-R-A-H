import type { AudioConfig } from '../../../core/config-schema.js';
import type { VoiceState } from '../../../services/voice/voice-types.js';
import { hudSelect, hudVSlider } from '../../components/index.js';
import type { AudioOutputLevelEventDetail } from '../../services/audio-output-level.js';
import { getSarah } from '../../shared/window-global.js';
import { createAudioSync, near } from './voice-audio-sync.js';

const BAR_COUNT = 16;
const FLOOR = 0.05;

const STATE_LABELS: Record<VoiceState, string> = {
  idle: 'IDLE',
  listening: 'IDLE', // Output panel ignores mic-listening state — no "HÖRT ZU" here.
  processing: 'DENKT',
  speaking: 'SPRICHT',
};

function labelFor(state: string): string {
  if (state in STATE_LABELS) {
    return STATE_LABELS[state as VoiceState];
  }
  return state.toUpperCase();
}

export function createVoiceOutBody(): { el: HTMLElement; dispose: () => void } {
  const el = document.createElement('div');
  el.className = 'voice-panel voice-panel--out';

  const controls = document.createElement('div');
  controls.className = 'voice-panel-controls';

  const sarah = getSarah();

  const picker = hudSelect({
    kind: 'audiooutput',
    value: '',
    onChange: (id) => {
      void audioSync.persist({ outputDeviceId: id || undefined });
    },
  });

  controls.appendChild(picker);

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

  const volSlider = hudVSlider({
    label: 'VOL',
    min: 0,
    max: 1,
    step: 0.01,
    value: 1,
    unit: 'percent',
    onChange: (v) => {
      void audioSync.persist({ outputVolume: v });
    },
  });

  sliders.appendChild(volSlider);

  el.appendChild(controls);
  el.appendChild(meter);
  el.appendChild(sliders);

  const applyLevel = (evt: CustomEvent<AudioOutputLevelEventDetail>): void => {
    const incoming = evt.detail.bars;
    const n = Math.min(bars.length, incoming.length);
    for (let i = 0; i < n; i++) {
      // FLOOR keeps a visible resting bar even when the analyser reads 0,
      // matching voice-in.ts' convention so both panels sit at the same idle
      // height visually.
      const v = Math.max(FLOOR, Math.min(1, incoming[i]));
      bars[i].style.setProperty('--v', v.toFixed(3));
    }
  };

  const applyState = (payload: { state: VoiceState }): void => {
    stateEl.dataset.state = payload.state;
    stateEl.textContent = labelFor(payload.state);
  };

  const applyAudio = (audio: AudioConfig): void => {
    const nextDevice = audio.outputDeviceId ?? '';
    if (picker.value !== nextDevice) picker.value = nextDevice;
    if (!near(volSlider.value, audio.outputVolume)) {
      volSlider.setValueSilent(audio.outputVolume);
    }
  };

  const audioSync = createAudioSync('VoiceOut', applyAudio);

  let unsubState: (() => void) | null = sarah.voice.onStateChange(applyState);
  window.addEventListener('audio:output-level', applyLevel);

  sarah.voice
    .getState()
    .then((state) => applyState({ state }))
    .catch((err: Error) => {
      console.warn('[VoiceOut] initial voice state fetch failed:', err);
    });

  const dispose = (): void => {
    if (unsubState) {
      unsubState();
      unsubState = null;
    }
    window.removeEventListener('audio:output-level', applyLevel);
    audioSync.dispose();
  };

  return { el, dispose };
}
