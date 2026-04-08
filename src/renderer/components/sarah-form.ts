import { SarahElement } from './base.js';

const CSS = `
  .form-wrapper {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-lg);
    width: 100%;
    max-width: 720px;
  }

  @media (min-width: 600px) {
    .form-wrapper {
      max-width: 80%;
      margin: 0 auto;
    }
  }

  .form-title {
    font-size: var(--sarah-font-size-lg);
    color: var(--sarah-text-primary);
    font-weight: 400;
    letter-spacing: 0.02em;
  }

  .form-description {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-secondary);
    line-height: 1.5;
  }

  .form-fields {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--sarah-space-md);
  }
`;

export class SarahForm extends SarahElement {
  private fieldsContainer!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const wrapper = document.createElement('div');
    wrapper.className = 'form-wrapper';

    const title = this.getAttribute('title');
    if (title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'form-title';
      titleEl.textContent = title;
      wrapper.appendChild(titleEl);
    }

    const description = this.getAttribute('description');
    if (description) {
      const descEl = document.createElement('div');
      descEl.className = 'form-description';
      descEl.textContent = description;
      wrapper.appendChild(descEl);
    }

    this.fieldsContainer = document.createElement('div');
    this.fieldsContainer.className = 'form-fields';

    const slot = document.createElement('slot');
    this.fieldsContainer.appendChild(slot);

    wrapper.appendChild(this.fieldsContainer);
    this.root.appendChild(wrapper);
  }
}

export function sarahForm(props: {
  title?: string;
  description?: string;
  children?: HTMLElement[];
}): SarahForm {
  const el = document.createElement('sarah-form') as SarahForm;
  if (props.title) el.setAttribute('title', props.title);
  if (props.description) el.setAttribute('description', props.description);
  if (props.children) {
    for (const child of props.children) {
      el.appendChild(child);
    }
  }
  return el;
}
