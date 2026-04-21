import type { SystemMetrics } from '../../../core/ipc-contract.js';
import { getSarah } from '../../shared/window-global.js';

type MetricKey = 'cpu' | 'gpu' | 'ram';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_SIZE = 112;
const RING_CENTER = 56;
const RING_RADIUS = 48;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const HIGH_LOAD_THRESHOLD = 0.8;

interface RingRefs {
  container: HTMLDivElement;
  track: SVGCircleElement;
  valueText: SVGTextElement;
}

function createRing(metric: MetricKey, label: string): RingRefs {
  const container = document.createElement('div');
  container.className = 'system-load-ring';
  container.dataset.metric = metric;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${RING_SIZE} ${RING_SIZE}`);
  svg.setAttribute('width', String(RING_SIZE));
  svg.setAttribute('height', String(RING_SIZE));
  svg.classList.add('system-load-svg');

  const ringGroup = document.createElementNS(SVG_NS, 'g');
  ringGroup.setAttribute('transform', `rotate(-90 ${RING_CENTER} ${RING_CENTER})`);

  const bg = document.createElementNS(SVG_NS, 'circle');
  bg.setAttribute('cx', String(RING_CENTER));
  bg.setAttribute('cy', String(RING_CENTER));
  bg.setAttribute('r', String(RING_RADIUS));
  bg.setAttribute('fill', 'none');
  bg.setAttribute('stroke-width', '5');
  bg.classList.add('ring-bg');

  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('cx', String(RING_CENTER));
  track.setAttribute('cy', String(RING_CENTER));
  track.setAttribute('r', String(RING_RADIUS));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke-width', '5');
  track.setAttribute('stroke-linecap', 'round');
  track.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  track.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
  track.classList.add('ring-track');

  ringGroup.appendChild(bg);
  ringGroup.appendChild(track);

  const valueText = document.createElementNS(SVG_NS, 'text');
  valueText.setAttribute('x', String(RING_CENTER));
  valueText.setAttribute('y', String(RING_CENTER - 2));
  valueText.setAttribute('text-anchor', 'middle');
  valueText.setAttribute('dominant-baseline', 'middle');
  valueText.classList.add('ring-text-value');
  valueText.textContent = '--';

  const labelText = document.createElementNS(SVG_NS, 'text');
  labelText.setAttribute('x', String(RING_CENTER));
  labelText.setAttribute('y', String(RING_CENTER + 18));
  labelText.setAttribute('text-anchor', 'middle');
  labelText.setAttribute('dominant-baseline', 'middle');
  labelText.classList.add('ring-text-label');
  labelText.textContent = label;

  svg.appendChild(ringGroup);
  svg.appendChild(valueText);
  svg.appendChild(labelText);

  container.appendChild(svg);

  return { container, track, valueText };
}

function applyRing(refs: RingRefs, fraction: number | null): void {
  if (fraction === null || !Number.isFinite(fraction)) {
    refs.track.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
    refs.valueText.textContent = '--';
    refs.container.classList.remove('is-high');
    return;
  }
  const clamped = Math.max(0, Math.min(1, fraction));
  const offset = RING_CIRCUMFERENCE * (1 - clamped);
  refs.track.setAttribute('stroke-dashoffset', offset.toFixed(2));
  refs.valueText.textContent = `${Math.round(clamped * 100)}%`;
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
