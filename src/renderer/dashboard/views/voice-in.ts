import type { AudioConfig } from '../../../core/config-schema.js';
import type { VoiceLevel } from '../../../core/ipc-contract.js';
import type { VoiceState } from '../../../services/voice/voice-types.js';
import { hudSelect, hudToggle, hudVSlider } from '../../components/index.js';
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

  const sarah = getSarah();

  const persistAudio = async (patch: Partial<AudioConfig>): Promise<void> => {
    try {
      const cfg = await sarah.getConfig();
      await sarah.saveConfig({ audio: { ...cfg.audio, ...patch } });
    } catch (err) {
      console.warn('[VoiceIn] failed to persist audio config:', err);
    }
  };

  const muteToggle = hudToggle({
    label: 'MUTE',
    pressed: false,
    ariaLabel: 'Mikrofon stummschalten',
    onChange: (muted) => {
      void persistAudio({ inputMuted: muted });
    },
  });

  const picker = hudSelect({
    kind: 'audioinput',
    value: '',
    onChange: (id) => {
      void persistAudio({ inputDeviceId: id || undefined });
    },
  });

  controls.appendChild(muteToggle);
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
      void persistAudio({ inputVolume: v });
    },
  });

  const gainSlider = hudVSlider({
    label: 'GAIN',
    min: 0,
    max: 1.5,
    step: 0.01,
    value: 1,
    defaultMarker: 1.0,
    unit: 'multiplier',
    onChange: (v) => {
      void persistAudio({ inputGain: v });
    },
  });

  sliders.appendChild(volSlider);
  sliders.appendChild(gainSlider);

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

  const applyAudio = (audio: AudioConfig): void => {
    const nextDevice = audio.inputDeviceId ?? '';
    if (picker.value !== nextDevice) picker.value = nextDevice;
    if (muteToggle.pressed !== audio.inputMuted) {
      muteToggle.setPressedSilent(audio.inputMuted);
    }
    if (volSlider.value !== audio.inputVolume) {
      volSlider.setValueSilent(audio.inputVolume);
    }
    if (gainSlider.value !== audio.inputGain) {
      gainSlider.setValueSilent(audio.inputGain);
    }
  };

  let unsubLevel: (() => void) | null = sarah.onVoiceLevel(applyLevel);
  let unsubState: (() => void) | null = sarah.voice.onStateChange(applyState);
  let unsubAudio: (() => void) | null = sarah.onAudioConfigChanged(applyAudio);

  sarah.voice
    .getState()
    .then((state) => applyState({ state }))
    .catch((err: Error) => {
      console.warn('[VoiceIn] initial voice state fetch failed:', err);
    });

  sarah
    .getConfig()
    .then((cfg) => applyAudio(cfg.audio))
    .catch((err: Error) => {
      console.warn('[VoiceIn] initial audio config fetch failed:', err);
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
    if (unsubAudio) {
      unsubAudio();
      unsubAudio = null;
    }
  };

  return { el, dispose };
}
