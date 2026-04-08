import { SarahElement, createElement } from './base.js';

const CSS = `
  .select-wrapper {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-xs);
    width: 100%;
  }

  label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    letter-spacing: 0.03em;
  }

  select {
    width: 100%;
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-primary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-md);
    transition: border-color var(--sarah-transition-fast),
                box-shadow var(--sarah-transition-fast);
    min-height: 40px;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23a0a0b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    padding-right: 36px;
    cursor: pointer;
  }

  select:focus {
    outline: none;
    border-color: var(--sarah-accent);
    box-shadow: 0 0 12px var(--sarah-glow-subtle);
  }

  option {
    background: var(--sarah-bg-secondary);
    color: var(--sarah-text-primary);
  }
`;

export interface SelectOption {
  value: string;
  label: string;
}

export class SarahSelect extends SarahElement {
  private select!: HTMLSelectElement;
  private _options: SelectOption[] = [];
  private _pendingValue: string | null = null;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const wrapper = document.createElement('div');
    wrapper.className = 'select-wrapper';

    const labelText = this.getAttribute('label');
    if (labelText) {
      const label = document.createElement('label');
      label.textContent = labelText;
      wrapper.appendChild(label);
    }

    this.select = document.createElement('select');
    this.select.addEventListener('change', () => {
      this.dispatchEvent(new CustomEvent('change', {
        detail: { value: this.select.value },
        bubbles: true,
        composed: true,
      }));
    });

    wrapper.appendChild(this.select);
    this.root.appendChild(wrapper);

    if (this._options.length) this.renderOptions();
  }

  get value(): string {
    return this.select?.value ?? '';
  }

  set value(v: string) {
    if (this.select) {
      this.select.value = v;
    } else {
      this._pendingValue = v;
    }
  }

  setOptions(options: SelectOption[]): void {
    this._options = options;
    if (this.select) this.renderOptions();
  }

  private renderOptions(): void {
    this.select.innerHTML = '';
    for (const opt of this._options) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      this.select.appendChild(option);
    }
    if (this._pendingValue !== null) {
      this.select.value = this._pendingValue;
      this._pendingValue = null;
    }
  }
}

export function sarahSelect(props: {
  label?: string;
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
}): SarahSelect {
  const attrs: Record<string, string> = {};
  if (props.label) attrs.label = props.label;

  const el = createElement<SarahSelect>('sarah-select', attrs);
  el.setOptions(props.options);
  if (props.value) el.value = props.value;
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
