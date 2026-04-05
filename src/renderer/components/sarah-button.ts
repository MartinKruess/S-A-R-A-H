import { SarahElement, createElement } from './base.js';

const CSS = `
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--sarah-space-sm);
    padding: var(--sarah-space-sm) var(--sarah-space-lg);
    border-radius: var(--sarah-radius-md);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-md);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
    border: 1px solid transparent;
    min-height: 40px;
  }

  button:focus-visible {
    outline: 1px solid var(--sarah-accent);
    outline-offset: 2px;
  }

  /* Primary */
  button.primary {
    background: var(--sarah-accent);
    color: var(--sarah-bg-primary);
    border-color: var(--sarah-accent);
  }
  button.primary:hover {
    background: var(--sarah-accent-hover);
    box-shadow: 0 0 20px var(--sarah-glow);
  }

  /* Secondary */
  button.secondary {
    background: transparent;
    color: var(--sarah-text-primary);
    border-color: var(--sarah-border);
  }
  button.secondary:hover {
    border-color: var(--sarah-accent);
    color: var(--sarah-accent);
    box-shadow: 0 0 15px var(--sarah-glow-subtle);
  }

  /* Ghost */
  button.ghost {
    background: transparent;
    color: var(--sarah-text-secondary);
    border-color: transparent;
  }
  button.ghost:hover {
    color: var(--sarah-text-primary);
    background: var(--sarah-bg-surface-hover);
  }

  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
  }
`;

export class SarahButton extends SarahElement {
  private button!: HTMLButtonElement;

  connectedCallback(): void {
    this.injectStyles(CSS);
    const variant = this.getAttribute('variant') ?? 'primary';
    this.button = document.createElement('button');
    this.button.className = variant;
    this.button.textContent = this.getAttribute('label') ?? '';
    if (this.hasAttribute('disabled')) {
      this.button.disabled = true;
    }
    this.root.appendChild(this.button);

    // Forward click events
    this.button.addEventListener('click', () => {
      this.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
    });
  }

  static get observedAttributes(): string[] {
    return ['label', 'variant', 'disabled'];
  }

  attributeChangedCallback(name: string, _old: string, value: string): void {
    if (!this.button) return;
    if (name === 'label') this.button.textContent = value;
    if (name === 'variant') this.button.className = value;
    if (name === 'disabled') this.button.disabled = value !== null;
  }
}

/** Factory function */
export function sarahButton(props: {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  onClick?: () => void;
}): SarahButton {
  const el = createElement<SarahButton>('sarah-button', {
    label: props.label,
    variant: props.variant ?? 'primary',
    ...(props.disabled ? { disabled: '' } : {}),
  });
  if (props.onClick) {
    el.addEventListener('click', props.onClick);
  }
  return el;
}
