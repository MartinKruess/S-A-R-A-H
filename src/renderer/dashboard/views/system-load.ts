import type { SystemMetrics } from '../../../core/ipc-contract.js';
import { getSarah } from '../../shared/window-global.js';

type MetricKey = 'cpu' | 'gpu' | 'ram';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_CIRCUMFERENCE = 201;
const HIGH_LOAD_THRESHOLD = 0.8;

interface RingRefs {
  container: HTMLDivElement;
  track: SVGCircleElement;
  value: HTMLDivElement;
}

function createRing(metric: MetricKey, label: string): RingRefs {
  const container = document.createElement('div');
  container.className = 'system-load-ring';
  container.dataset.metric = metric;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 72 72');
  svg.setAttribute('width', '72');
  svg.setAttribute('height', '72');
  svg.classList.add('system-load-svg');

  const bg = document.createElementNS(SVG_NS, 'circle');
  bg.setAttribute('cx', '36');
  bg.setAttribute('cy', '36');
  bg.setAttribute('r', '32');
  bg.setAttribute('fill', 'none');
  bg.setAttribute('stroke-width', '4');
  bg.classList.add('ring-bg');

  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('cx', '36');
  track.setAttribute('cy', '36');
  track.setAttribute('r', '32');
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke-width', '4');
  track.setAttribute('stroke-linecap', 'round');
  track.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  track.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
  track.classList.add('ring-track');

  svg.appendChild(bg);
  svg.appendChild(track);

  const labelEl = document.createElement('div');
  labelEl.className = 'ring-label';
  labelEl.textContent = label;

  const value = document.createElement('div');
  value.className = 'ring-value';
  value.textContent = '--';

  container.appendChild(svg);
  container.appendChild(labelEl);
  container.appendChild(value);

  return { container, track, value };
}

function applyRing(refs: RingRefs, fraction: number | null): void {
  if (fraction === null || !Number.isFinite(fraction)) {
    refs.track.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
    refs.value.textContent = '--';
    refs.container.classList.remove('is-high');
    return;
  }
  const clamped = Math.max(0, Math.min(1, fraction));
  const offset = RING_CIRCUMFERENCE * (1 - clamped);
  refs.track.setAttribute('stroke-dashoffset', offset.toFixed(2));
  refs.value.textContent = `${Math.round(clamped * 100)}%`;
  refs.container.classList.toggle('is-high', clamped > HIGH_LOAD_THRESHOLD);
}

export function createSystemLoadBody(): { el: HTMLElement; dispose: () => void } {
  const el = document.createElement('div');
  el.className = 'system-load';

  const cpu = createRing('cpu', 'CPU');
  const gpu = createRing('gpu', 'GPU');
  const ram = createRing('ram', 'RAM');

  el.appendChild(cpu.container);
  el.appendChild(gpu.container);
  el.appendChild(ram.container);

  const update = (m: SystemMetrics): void => {
    applyRing(cpu, m.cpu);
    applyRing(gpu, m.gpu);
    applyRing(ram, m.ram);
  };

  const sarah = getSarah();
  let unsubscribe: (() => void) | null = sarah.onSystemMetrics(update);

  sarah
    .getSystemMetrics()
    .then(update)
    .catch((err: Error) => {
      console.warn('[SystemLoad] initial metrics fetch failed:', err);
    });

  const dispose = (): void => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  return { el, dispose };
}
