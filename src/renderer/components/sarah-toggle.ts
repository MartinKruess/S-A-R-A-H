import { SarahElement } from './base.js';

const CSS = `
  .toggle-wrapper {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sarah-space-md);
    width: 100%;
    cursor: pointer;
    user-select: none;
  }

  .toggle-label {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-primary);
  }

  .toggle-description {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    margin-top: 2px;
  }

  .toggle-track {
    width: 44px;
    height: 24px;
    border-radius: 12px;
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    position: relative;
    flex-shrink: 0;
    transition: all var(--sarah-transition-fast);
  }

  .toggle-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--sarah-text-muted);
    position: absolute;
    top: 2px;
    left: 2px;
    transition: all var(--sarah-transition-fast);
  }

  .toggle-wrapper.active .toggle-track {
    background: rgba(var(--sarah-accent-rgb), 0.2);
    border-color: var(--sarah-accent);
  }

  .toggle-wrapper.active .toggle-thumb {
    background: var(--sarah-accent);
    left: 22px;
    box-shadow: 0 0 8px var(--sarah-glow);
  }
`;

export class SarahToggle extends SarahElement {
  private _active = false;
  private wrapper!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'toggle-wrapper';
    if (this.hasAttribute('checked')) {
      this._active = true;
      this.wrapper.classList.add('active');
    }

    const labelArea = document.createElement('div');

    const labelText = this.getAttribute('label');
    if (labelText) {
      const label = document.createElement('div');
      label.className = 'toggle-label';
      label.textContent = labelText;
      labelArea.appendChild(label);
    }

    const desc = this.getAttribute('description');
    if (desc) {
      const descEl = document.createElement('div');
      descEl.className = 'toggle-description';
      descEl.textContent = desc;
      labelArea.appendChild(descEl);
    }

    const track = document.createElement('div');
    track.className = 'toggle-track';
    const thumb = document.createElement('div');
    thumb.className = 'toggle-thumb';
    track.appendChild(thumb);

    this.wrapper.appendChild(labelArea);
    this.wrapper.appendChild(track);

    this.wrapper.addEventListener('click', () => {
      this._active = !this._active;
      this.wrapper.classList.toggle('active', this._active);
      this.dispatchEvent(new CustomEvent('change', {
        detail: { value: this._active },
        bubbles: true,
        composed: true,
      }));
    });

    this.root.appendChild(this.wrapper);
  }

  get checked(): boolean {
    return this._active;
  }

  set checked(val: boolean) {
    this._active = val;
    if (this.wrapper) this.wrapper.classList.toggle('active', val);
  }
}

export function sarahToggle(props: {
  label?: string;
  description?: string;
  checked?: boolean;
  onChange?: (value: boolean) => void;
}): SarahToggle {
  const el = document.createElement('sarah-toggle') as SarahToggle;
  if (props.label) el.setAttribute('label', props.label);
  if (props.description) el.setAttribute('description', props.description);
  if (props.checked) el.setAttribute('checked', '');
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
