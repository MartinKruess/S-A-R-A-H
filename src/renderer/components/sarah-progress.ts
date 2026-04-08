import { SarahElement } from './base.js';

const CSS = `
  .progress-wrapper {
    width: 100%;
  }

  .progress-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    margin-bottom: var(--sarah-space-xs);
  }

  .progress-track {
    width: 100%;
    height: 4px;
    background: var(--sarah-bg-surface);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--sarah-accent);
    border-radius: 2px;
    transition: width var(--sarah-transition-normal);
    box-shadow: 0 0 8px var(--sarah-glow);
    width: 0%;
  }

  .progress-fill.indeterminate {
    width: 30%;
    animation: indeterminate 1.5s ease-in-out infinite;
  }

  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }
`;

export class SarahProgress extends SarahElement {
  private fillEl!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const wrapper = document.createElement('div');
    wrapper.className = 'progress-wrapper';

    const label = this.getAttribute('label');
    if (label) {
      const labelEl = document.createElement('div');
      labelEl.className = 'progress-label';
      labelEl.textContent = label;
      wrapper.appendChild(labelEl);
    }

    const track = document.createElement('div');
    track.className = 'progress-track';

    this.fillEl = document.createElement('div');
    this.fillEl.className = 'progress-fill';

    const value = this.getAttribute('value');
    if (value) {
      this.fillEl.style.width = `${value}%`;
    } else {
      this.fillEl.classList.add('indeterminate');
    }

    track.appendChild(this.fillEl);
    wrapper.appendChild(track);
    this.root.appendChild(wrapper);
  }

  setProgress(percent: number): void {
    if (!this.fillEl) return;
    this.fillEl.classList.remove('indeterminate');
    this.fillEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  setIndeterminate(): void {
    if (!this.fillEl) return;
    this.fillEl.style.width = '';
    this.fillEl.classList.add('indeterminate');
  }
}

export function sarahProgress(props?: {
  label?: string;
  value?: number;
}): SarahProgress {
  const el = document.createElement('sarah-progress') as SarahProgress;
  if (props?.label) el.setAttribute('label', props.label);
  if (props?.value !== undefined) el.setAttribute('value', String(props.value));
  return el;
}
