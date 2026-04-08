import { SarahElement } from './base.js';

function getSarah(): { selectFolder: (title?: string) => Promise<string | null> } {
  return (window as any).__sarah ?? (window as any).sarah;
}

const CSS = `
  .path-wrapper {
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

  .path-row {
    display: flex;
    gap: var(--sarah-space-sm);
  }

  .path-display {
    flex: 1;
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-primary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-sm);
    min-height: 40px;
    display: flex;
    align-items: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path-display.empty {
    color: var(--sarah-text-muted);
  }

  .browse-btn {
    padding: var(--sarah-space-sm) var(--sarah-space-md);
    background: var(--sarah-bg-surface);
    border: 1px solid var(--sarah-border);
    border-radius: var(--sarah-radius-md);
    color: var(--sarah-text-secondary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-sm);
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
    white-space: nowrap;
  }

  .browse-btn:hover {
    border-color: var(--sarah-accent);
    color: var(--sarah-accent);
  }
`;

export class SarahPathPicker extends SarahElement {
  private _value = '';
  private pathDisplay!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const wrapper = document.createElement('div');
    wrapper.className = 'path-wrapper';

    const labelText = this.getAttribute('label');
    if (labelText) {
      const label = document.createElement('label');
      label.textContent = labelText;
      wrapper.appendChild(label);
    }

    const row = document.createElement('div');
    row.className = 'path-row';

    this.pathDisplay = document.createElement('div');
    this.pathDisplay.className = 'path-display empty';
    this.pathDisplay.textContent = this.getAttribute('placeholder') ?? 'Kein Ordner ausgewählt';

    const browseBtn = document.createElement('button');
    browseBtn.className = 'browse-btn';
    browseBtn.textContent = 'Durchsuchen';
    browseBtn.addEventListener('click', async () => {
      const folder = await getSarah().selectFolder(labelText ?? undefined);
      if (folder) {
        this._value = folder;
        this.pathDisplay.textContent = folder;
        this.pathDisplay.classList.remove('empty');
        this.dispatchEvent(new CustomEvent('change', {
          detail: { value: folder },
          bubbles: true,
          composed: true,
        }));
      }
    });

    const presetValue = this.getAttribute('value');
    if (presetValue) {
      this._value = presetValue;
      this.pathDisplay.textContent = presetValue;
      this.pathDisplay.classList.remove('empty');
    }

    row.appendChild(this.pathDisplay);
    row.appendChild(browseBtn);
    wrapper.appendChild(row);
    this.root.appendChild(wrapper);
  }

  get value(): string {
    return this._value;
  }

  set value(v: string) {
    this._value = v;
    if (this.pathDisplay) {
      this.pathDisplay.textContent = v || this.getAttribute('placeholder') || 'Kein Ordner ausgewählt';
      this.pathDisplay.classList.toggle('empty', !v);
    }
  }
}

export function sarahPathPicker(props: {
  label?: string;
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
}): SarahPathPicker {
  const el = document.createElement('sarah-path-picker') as SarahPathPicker;
  if (props.label) el.setAttribute('label', props.label);
  if (props.placeholder) el.setAttribute('placeholder', props.placeholder);
  if (props.value) el.setAttribute('value', props.value);
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
