import { SarahElement } from './base.js';

const CSS = `
  .card {
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-lg);
    padding: var(--sarah-space-md) var(--sarah-space-lg);
    transition: border-color var(--sarah-transition-fast),
                box-shadow var(--sarah-transition-fast);
  }

  .card:hover {
    border-color: rgba(var(--sarah-accent-rgb), 0.2);
    box-shadow: 0 0 20px var(--sarah-glow-subtle);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: var(--sarah-space-sm);
    margin-bottom: var(--sarah-space-sm);
  }

  .card-icon {
    font-size: 1.2rem;
    opacity: 0.8;
  }

  .card-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .card-value {
    font-size: var(--sarah-font-size-lg);
    color: var(--sarah-text-primary);
    font-weight: 300;
  }
`;

export class SarahCard extends SarahElement {
  private valueEl!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const card = document.createElement('div');
    card.className = 'card';

    const header = document.createElement('div');
    header.className = 'card-header';

    const icon = this.getAttribute('icon');
    if (icon) {
      const iconEl = document.createElement('span');
      iconEl.className = 'card-icon';
      iconEl.textContent = icon;
      header.appendChild(iconEl);
    }

    const label = document.createElement('span');
    label.className = 'card-label';
    label.textContent = this.getAttribute('label') ?? '';
    header.appendChild(label);

    this.valueEl = document.createElement('div');
    this.valueEl.className = 'card-value';
    this.valueEl.textContent = this.getAttribute('value') ?? '';

    card.appendChild(header);
    card.appendChild(this.valueEl);
    this.root.appendChild(card);
  }

  static get observedAttributes(): string[] {
    return ['value'];
  }

  attributeChangedCallback(name: string, _old: string, value: string): void {
    if (name === 'value' && this.valueEl) {
      this.valueEl.textContent = value;
    }
  }
}

export function sarahCard(props: {
  label: string;
  value: string;
  icon?: string;
}): SarahCard {
  const el = document.createElement('sarah-card') as SarahCard;
  el.setAttribute('label', props.label);
  el.setAttribute('value', props.value);
  if (props.icon) el.setAttribute('icon', props.icon);
  return el;
}
