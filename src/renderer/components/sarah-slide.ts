import { SarahElement } from './base.js';

const CSS = `
  :host {
    display: block;
    width: 100%;
    height: 100%;
    position: absolute;
    top: 0;
    left: 0;
    opacity: 0;
    transform: translateY(12px);
    transition: opacity var(--sarah-transition-slow),
                transform var(--sarah-transition-slow);
    pointer-events: none;
  }

  :host(.active) {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }

  .slide-content {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--sarah-space-xl);
  }
`;

export class SarahSlide extends SarahElement {
  connectedCallback(): void {
    this.injectStyles(CSS);
    const content = document.createElement('div');
    content.className = 'slide-content';
    const slot = document.createElement('slot');
    content.appendChild(slot);
    this.root.appendChild(content);
  }

  show(): void {
    this.classList.add('active');
  }

  hide(): void {
    this.classList.remove('active');
  }
}

export function sarahSlide(props?: {
  children?: HTMLElement[];
  active?: boolean;
}): SarahSlide {
  const el = document.createElement('sarah-slide') as SarahSlide;
  if (props?.children) {
    for (const child of props.children) {
      el.appendChild(child);
    }
  }
  if (props?.active) el.classList.add('active');
  return el;
}
