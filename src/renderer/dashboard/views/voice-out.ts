import type { AudioConfig } from '../../../core/config-schema.js';
import type { VoiceState } from '../../../services/voice/voice-types.js';
import { hudSelect, hudVSlider } from '../../components/index.js';
import { getSarah } from '../../shared/window-global.js';

const BAR_COUNT = 16;
const FLOOR = 0.05;

const STATE_LABELS: Record<VoiceState, string> = {
  idle: 'IDLE',
  listening: 'IDLE',
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

  const persistAudio = async (patch: Partial<AudioConfig>): Promise<void> => {
    try {
      const cfg = await sarah.getConfig();
      await sarah.saveConfig({ audio: { ...cfg.audio, ...patch } });
    } catch (err) {
      console.warn('[VoiceOut] failed to persist audio config:', err);
    }
  };

  const picker = hudSelect({
    kind: 'audiooutput',
    value: '',
    onChange: (id) => {
      void persistAudio({ outputDeviceId: id || undefined });
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

  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement('span');
    bar.className = 'voice-io-bar';
    bar.style.setProperty('--v', String(FLOOR));
    barsRow.appendChild(bar);
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
      void persistAudio({ outputVolume: v });
    },
  });

  sliders.appendChild(volSlider);

  el.appendChild(controls);
  el.appendChild(meter);
  el.appendChild(sliders);

  const applyState = (payload: { state: VoiceState }): void => {
    stateEl.dataset.state = payload.state;
    stateEl.textContent = labelFor(payload.state);
  };

  const applyAudio = (audio: AudioConfig): void => {
    const nextDevice = audio.outputDeviceId ?? '';
    if (picker.value !== nextDevice) picker.value = nextDevice;
    if (volSlider.value !== audio.outputVolume) {
      volSlider.setValueSilent(audio.outputVolume);
    }
  };

  let unsubState: (() => void) | null = sarah.voice.onStateChange(applyState);
  let unsubAudio: (() => void) | null = sarah.onAudioConfigChanged(applyAudio);

  sarah.voice
    .getState()
    .then((state) => applyState({ state }))
    .catch((err: Error) => {
      console.warn('[VoiceOut] initial voice state fetch failed:', err);
    });

  sarah
    .getConfig()
    .then((cfg) => applyAudio(cfg.audio))
    .catch((err: Error) => {
      console.warn('[VoiceOut] initial audio config fetch failed:', err);
    });

  const dispose = (): void => {
    if (unsubState) {
      unsubState();
      unsubState = null;
    }
    if (unsubAudio) {
      unsubAudio();
      unsubAudio = null;
    }
  };

  return { el, dispose };
}
