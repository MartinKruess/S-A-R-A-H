import { SarahElement } from './base.js';

const CSS = `
  .stepper {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .step {
    display: flex;
    align-items: flex-start;
    gap: var(--sarah-space-md);
    cursor: pointer;
    padding: var(--sarah-space-sm) 0;
    user-select: none;
  }

  .step-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
  }

  .step-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--sarah-text-muted);
    background: transparent;
    transition: all var(--sarah-transition-normal);
    position: relative;
  }

  .step-line {
    width: 2px;
    height: 32px;
    background: var(--sarah-border);
    transition: background var(--sarah-transition-normal);
  }

  .step:last-child .step-line {
    display: none;
  }

  .step-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    padding-top: 1px;
    transition: color var(--sarah-transition-fast);
    letter-spacing: 0.02em;
  }

  /* Active step */
  .step.active .step-dot {
    border-color: var(--sarah-accent);
    background: var(--sarah-accent);
    box-shadow: 0 0 12px var(--sarah-glow),
                0 0 4px var(--sarah-glow-strong);
    animation: pulse 2s ease-in-out infinite;
  }

  .step.active .step-label {
    color: var(--sarah-text-primary);
  }

  /* Completed step */
  .step.completed .step-dot {
    border-color: var(--sarah-accent);
    background: var(--sarah-accent);
  }

  .step.completed .step-dot::after {
    content: '✓';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 9px;
    color: var(--sarah-bg-primary);
    font-weight: bold;
  }

  .step.completed .step-label {
    color: var(--sarah-text-secondary);
  }

  .step.completed .step-line {
    background: var(--sarah-accent);
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 12px var(--sarah-glow), 0 0 4px var(--sarah-glow-strong); }
    50% { box-shadow: 0 0 20px var(--sarah-glow-strong), 0 0 8px var(--sarah-glow); }
  }
`;

export interface StepperStep {
  id: string;
  label: string;
}

export class SarahStepper extends SarahElement {
  private _steps: StepperStep[] = [];
  private _activeIndex = 0;
  private container!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);
    this.container = document.createElement('div');
    this.container.className = 'stepper';
    this.root.appendChild(this.container);
    this.render();
  }

  setSteps(steps: StepperStep[]): void {
    this._steps = steps;
    if (this.container) this.render();
  }

  setActive(index: number): void {
    this._activeIndex = index;
    if (this.container) this.render();
  }

  private render(): void {
    this.container.innerHTML = '';
    this._steps.forEach((step, i) => {
      const stepEl = document.createElement('div');
      stepEl.className = 'step';
      if (i === this._activeIndex) stepEl.classList.add('active');
      if (i < this._activeIndex) stepEl.classList.add('completed');

      const indicator = document.createElement('div');
      indicator.className = 'step-indicator';

      const dot = document.createElement('div');
      dot.className = 'step-dot';
      indicator.appendChild(dot);

      const line = document.createElement('div');
      line.className = 'step-line';
      indicator.appendChild(line);

      const label = document.createElement('div');
      label.className = 'step-label';
      label.textContent = step.label;

      stepEl.appendChild(indicator);
      stepEl.appendChild(label);

      stepEl.addEventListener('click', () => {
        if (i <= this._activeIndex) {
          this.dispatchEvent(new CustomEvent('step-click', {
            detail: { index: i, id: step.id },
            bubbles: true,
            composed: true,
          }));
        }
      });

      this.container.appendChild(stepEl);
    });
  }
}

export function sarahStepper(props: {
  steps: StepperStep[];
  activeIndex?: number;
  onStepClick?: (index: number, id: string) => void;
}): SarahStepper {
  const el = document.createElement('sarah-stepper') as SarahStepper;
  el.setSteps(props.steps);
  if (props.activeIndex !== undefined) el.setActive(props.activeIndex);
  if (props.onStepClick) {
    el.addEventListener('step-click', ((e: CustomEvent) => {
      props.onStepClick!(e.detail.index, e.detail.id);
    }) as EventListener);
  }
  return el;
}
