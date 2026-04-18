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

export function createVoiceIoBody(): { el: HTMLElement; dispose: () => void } {
  const el = document.createElement('div');
  el.className = 'voice-io';

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

  el.appendChild(stateEl);
  el.appendChild(barsRow);

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
      console.warn('[VoiceIO] initial voice state fetch failed:', err);
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
