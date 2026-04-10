import { SarahElement, createElement } from './base.js';

const CSS = `
  .input-wrapper {
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

  input {
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
  }

  input:focus {
    outline: none;
    border-color: var(--sarah-accent);
    box-shadow: 0 0 12px var(--sarah-glow-subtle);
  }

  input::placeholder {
    color: var(--sarah-text-muted);
  }

  .error-msg {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-accent-orange);
    min-height: 1.2em;
  }
`;

export class SarahInput extends SarahElement {
  private input!: HTMLInputElement;
  private errorEl!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const wrapper = document.createElement('div');
    wrapper.className = 'input-wrapper';

    const labelText = this.getAttribute('label');
    if (labelText) {
      const label = document.createElement('label');
      label.textContent = labelText;
      wrapper.appendChild(label);
    }

    this.input = document.createElement('input');
    this.input.type = this.getAttribute('type') ?? 'text';
    this.input.placeholder = this.getAttribute('placeholder') ?? '';
    if (this.hasAttribute('required')) this.input.required = true;
    if (this.hasAttribute('value')) this.input.value = this.getAttribute('value')!;

    this.input.addEventListener('input', () => {
      this.dispatchEvent(new CustomEvent('change', {
        detail: { value: this.input.value },
        bubbles: true,
        composed: true,
      }));
    });

    this.errorEl = document.createElement('div');
    this.errorEl.className = 'error-msg';

    wrapper.appendChild(this.input);
    wrapper.appendChild(this.errorEl);
    this.root.appendChild(wrapper);
  }

  get value(): string {
    return this.input?.value ?? '';
  }

  set value(v: string) {
    if (this.input) this.input.value = v;
  }

  setError(msg: string): void {
    this.errorEl.textContent = msg;
  }

  clearError(): void {
    this.errorEl.textContent = '';
  }

  setReadOnly(readOnly: boolean): void {
    if (this.input) {
      this.input.readOnly = readOnly;
      this.input.style.cursor = readOnly ? 'pointer' : '';
    }
  }

  onKeydown(handler: (e: KeyboardEvent) => void): void {
    if (this.input) {
      this.input.addEventListener('keydown', handler);
    }
  }

  validate(): boolean {
    const val = this.input.value.trim();
    if (this.input.required && !val) {
      this.setError('Dieses Feld ist erforderlich');
      return false;
    }
    if (this.input.required && val.length < 3) {
      this.setError('Mindestens 3 Zeichen erforderlich');
      return false;
    }
    this.clearError();
    return true;
  }
}

/** Factory function */
export function sarahInput(props: {
  label?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  value?: string;
  onChange?: (value: string) => void;
}): SarahInput {
  const attrs: Record<string, string> = {};
  if (props.label) attrs.label = props.label;
  if (props.type) attrs.type = props.type;
  if (props.placeholder) attrs.placeholder = props.placeholder;
  if (props.required) attrs.required = '';
  if (props.value) attrs.value = props.value;

  const el = createElement<SarahInput>('sarah-input', attrs);
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
