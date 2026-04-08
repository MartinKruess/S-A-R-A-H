import { SarahElement } from './base.js';

const CSS = `
  .tag-select-wrapper {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-sm);
    width: 100%;
  }

  label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    letter-spacing: 0.03em;
  }

  .tag-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sarah-space-sm);
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: var(--sarah-space-xs);
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    border-radius: var(--sarah-radius-lg);
    border: 1px solid var(--sarah-border);
    background: var(--sarah-bg-surface);
    color: var(--sarah-text-secondary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-sm);
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
    user-select: none;
  }

  .tag:hover {
    border-color: rgba(var(--sarah-accent-rgb), 0.3);
    color: var(--sarah-text-primary);
  }

  .tag.selected {
    border-color: var(--sarah-accent);
    background: rgba(var(--sarah-accent-rgb), 0.1);
    color: var(--sarah-accent);
    box-shadow: 0 0 10px var(--sarah-glow-subtle);
  }

  .tag-icon {
    font-size: 1rem;
  }

  .add-input-wrapper {
    display: flex;
    gap: var(--sarah-space-sm);
    margin-top: var(--sarah-space-xs);
  }

  .add-input {
    flex: 1;
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-primary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-sm);
    min-height: 36px;
  }

  .add-input:focus {
    outline: none;
    border-color: var(--sarah-accent);
    box-shadow: 0 0 8px var(--sarah-glow-subtle);
  }

  .add-input::placeholder {
    color: var(--sarah-text-muted);
  }

  .add-btn {
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-secondary);
    font-family: var(--sarah-font-family);
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
  }

  .add-btn:hover {
    border-color: var(--sarah-accent);
    color: var(--sarah-accent);
  }
`;

export interface TagOption {
  value: string;
  label: string;
  icon?: string;
}

export class SarahTagSelect extends SarahElement {
  private _options: TagOption[] = [];
  private _selected: Set<string> = new Set();
  private _allowCustom = false;
  private container!: HTMLElement;
  private tagGrid!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    this.container = document.createElement('div');
    this.container.className = 'tag-select-wrapper';

    const labelText = this.getAttribute('label');
    if (labelText) {
      const label = document.createElement('label');
      label.textContent = labelText;
      this.container.appendChild(label);
    }

    this.tagGrid = document.createElement('div');
    this.tagGrid.className = 'tag-grid';
    this.container.appendChild(this.tagGrid);

    this._allowCustom = this.hasAttribute('allow-custom');

    if (this._allowCustom) {
      const addWrapper = document.createElement('div');
      addWrapper.className = 'add-input-wrapper';

      const input = document.createElement('input');
      input.className = 'add-input';
      input.placeholder = 'Eigenen Bereich hinzufügen...';

      const addBtn = document.createElement('button');
      addBtn.className = 'add-btn';
      addBtn.textContent = '+';
      addBtn.addEventListener('click', () => {
        const val = input.value.trim();
        if (val && !this._options.some(o => o.value === val)) {
          this._options.push({ value: val, label: val });
          this._selected.add(val);
          this.renderTags();
          this.emitChange();
          input.value = '';
        }
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addBtn.click();
        }
      });

      addWrapper.appendChild(input);
      addWrapper.appendChild(addBtn);
      this.container.appendChild(addWrapper);
    }

    this.root.appendChild(this.container);
    this.renderTags();
  }

  setOptions(options: TagOption[]): void {
    this._options = options;
    if (this.tagGrid) this.renderTags();
  }

  setSelected(values: string[]): void {
    this._selected = new Set(values);
    if (this.tagGrid) this.renderTags();
  }

  getSelected(): string[] {
    return Array.from(this._selected);
  }

  private renderTags(): void {
    this.tagGrid.innerHTML = '';
    for (const opt of this._options) {
      const tag = document.createElement('div');
      tag.className = 'tag';
      if (this._selected.has(opt.value)) tag.classList.add('selected');

      if (opt.icon) {
        const icon = document.createElement('span');
        icon.className = 'tag-icon';
        icon.textContent = opt.icon;
        tag.appendChild(icon);
      }

      const text = document.createTextNode(opt.label);
      tag.appendChild(text);

      tag.addEventListener('click', () => {
        if (this._selected.has(opt.value)) {
          this._selected.delete(opt.value);
          tag.classList.remove('selected');
        } else {
          this._selected.add(opt.value);
          tag.classList.add('selected');
        }
        this.emitChange();
      });

      this.tagGrid.appendChild(tag);
    }
  }

  private emitChange(): void {
    this.dispatchEvent(new CustomEvent('change', {
      detail: { values: this.getSelected() },
      bubbles: true,
      composed: true,
    }));
  }
}

export function sarahTagSelect(props: {
  label?: string;
  options: TagOption[];
  selected?: string[];
  allowCustom?: boolean;
  onChange?: (values: string[]) => void;
}): SarahTagSelect {
  const el = document.createElement('sarah-tag-select') as SarahTagSelect;
  if (props.label) el.setAttribute('label', props.label);
  if (props.allowCustom) el.setAttribute('allow-custom', '');
  el.setOptions(props.options);
  if (props.selected) el.setSelected(props.selected);
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent) => {
      props.onChange!(e.detail.values);
    }) as EventListener);
  }
  return el;
}
