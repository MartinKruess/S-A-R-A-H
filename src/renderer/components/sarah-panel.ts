import { SarahElement } from './base.js';

type PanelAccent = 'cyan' | 'violet' | 'pink' | 'mint';
type PanelState = 'idle' | 'loading' | 'error' | 'stale';

const ACCENTS: readonly PanelAccent[] = ['cyan', 'violet', 'pink', 'mint'];
const STATES: readonly PanelState[] = ['idle', 'loading', 'error', 'stale'];

function isAccent(value: string | null): value is PanelAccent {
  return value !== null && (ACCENTS as readonly string[]).includes(value);
}

function isState(value: string | null): value is PanelState {
  return value !== null && (STATES as readonly string[]).includes(value);
}

const CHAMFER_WRAPPER = `polygon(
  12px 0, calc(100% - 12px) 0, 100% 12px,
  100% calc(100% - 12px), calc(100% - 12px) 100%,
  12px 100%, 0 calc(100% - 12px), 0 12px
)`;

const CHAMFER_INNER = `polygon(
  11px 0, calc(100% - 11px) 0, 100% 11px,
  100% calc(100% - 11px), calc(100% - 11px) 100%,
  11px 100%, 0 calc(100% - 11px), 0 11px
)`;

const CSS = `
  :host {
    display: block;
  }

  .panel-wrapper {
    position: relative;
    padding: 1px;
    background: var(--panel-accent, linear-gradient(135deg, var(--cockpit-accent-cyan), var(--cockpit-accent-violet)));
    box-shadow: 0 0 20px rgba(0, 229, 255, 0.15);
    clip-path: ${CHAMFER_WRAPPER};
    height: 100%;
    transition: box-shadow 200ms ease;
    animation: cockpit-panel-breathe 6s ease-in-out infinite;
  }

  :host(:hover) .panel-wrapper {
    box-shadow: 0 0 40px rgba(0, 229, 255, 0.3);
  }

  :host([accent="violet"]) .panel-wrapper {
    background: var(--panel-accent, linear-gradient(135deg, var(--cockpit-accent-violet), var(--cockpit-accent-pink)));
    box-shadow: 0 0 20px rgba(124, 58, 237, 0.15);
  }

  :host([accent="violet"]:hover) .panel-wrapper {
    box-shadow: 0 0 40px rgba(124, 58, 237, 0.3);
  }

  :host([accent="pink"]) .panel-wrapper {
    background: var(--panel-accent, linear-gradient(135deg, var(--cockpit-accent-pink), var(--cockpit-accent-cyan)));
    box-shadow: 0 0 20px rgba(255, 47, 209, 0.15);
  }

  :host([accent="pink"]:hover) .panel-wrapper {
    box-shadow: 0 0 40px rgba(255, 47, 209, 0.3);
  }

  :host([accent="mint"]) .panel-wrapper {
    background: var(--panel-accent, linear-gradient(135deg, var(--cockpit-accent-mint), var(--cockpit-accent-cyan)));
    box-shadow: 0 0 20px rgba(34, 255, 192, 0.15);
  }

  :host([accent="mint"]:hover) .panel-wrapper {
    box-shadow: 0 0 40px rgba(34, 255, 192, 0.3);
  }

  :host([state="error"]) .panel-wrapper {
    background: var(--cockpit-accent-red);
    box-shadow: 0 0 20px rgba(255, 59, 59, 0.25);
  }

  :host([state="error"]:hover) .panel-wrapper {
    box-shadow: 0 0 40px rgba(255, 59, 59, 0.5);
  }

  @keyframes cockpit-panel-breathe {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.98; }
  }

  @media (prefers-reduced-motion: reduce) {
    .panel-wrapper {
      transition: none;
      animation: none;
    }
  }

  .panel-inner {
    position: relative;
    background: var(--cockpit-bg-panel);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    clip-path: ${CHAMFER_INNER};
    padding: 16px;
    min-height: var(--panel-min-height, 120px);
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .panel-header[hidden] {
    display: none;
  }

  .panel-title {
    font-family: var(--cockpit-font-heading);
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--cockpit-text-hud);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .panel-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }

  .panel-actions[hidden] {
    display: none;
  }

  .panel-body {
    flex: 1;
    min-height: 0;
    position: relative;
    font-family: var(--cockpit-font-body);
    color: var(--cockpit-text-hud);
  }

  :host([state="loading"]) .panel-body {
    opacity: 0.6;
  }

  :host([state="stale"]) .panel-body {
    opacity: 0.4;
  }

  .panel-skeleton {
    display: none;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: linear-gradient(90deg, transparent, var(--cockpit-text-hud), transparent);
    opacity: 0.25;
    animation: panel-skeleton-pulse 1.6s ease-in-out infinite;
  }

  :host([state="loading"]) .panel-skeleton {
    display: block;
  }

  @keyframes panel-skeleton-pulse {
    0%, 100% { transform: translateX(-30%); opacity: 0.1; }
    50% { transform: translateX(30%); opacity: 0.35; }
  }

  .panel-stale-dot {
    display: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--cockpit-accent-cyan);
    box-shadow: 0 0 6px var(--cockpit-accent-cyan);
  }

  :host([state="stale"]) .panel-stale-dot {
    display: inline-block;
  }

  .panel-error-text {
    display: none;
    font-family: var(--cockpit-font-body);
    color: var(--cockpit-accent-red);
    font-size: 0.9rem;
  }

  :host([state="error"]) .panel-error-text.is-visible {
    display: block;
  }
`;

/**
 * Chamfered panel primitive for the cockpit dashboard.
 *
 * Consumer contract: when no data is yet available, render `"--"` in the body,
 * not `"0"` — this component does not enforce it.
 */
export class SarahPanel extends SarahElement {
  private wrapperEl!: HTMLElement;
  private innerEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private titleSlot!: HTMLSlotElement;
  private actionsEl!: HTMLElement;
  private actionsSlot!: HTMLSlotElement;
  private bodyEl!: HTMLElement;
  private bodySlot!: HTMLSlotElement;
  private staleDotEl!: HTMLElement;
  private errorTextEl!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    if (!isAccent(this.getAttribute('accent'))) {
      this.setAttribute('accent', 'cyan');
    }
    if (!isState(this.getAttribute('state'))) {
      this.setAttribute('state', 'idle');
    }

    this.wrapperEl = document.createElement('div');
    this.wrapperEl.className = 'panel-wrapper';

    this.innerEl = document.createElement('div');
    this.innerEl.className = 'panel-inner';

    this.headerEl = document.createElement('div');
    this.headerEl.className = 'panel-header';

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'panel-title';

    this.titleSlot = document.createElement('slot');
    this.titleSlot.name = 'title';

    const titleText = document.createElement('span');
    titleText.className = 'panel-title-text';
    titleText.textContent = this.getAttribute('title') ?? '';
    this.titleSlot.appendChild(titleText);

    this.titleEl.appendChild(this.titleSlot);

    this.staleDotEl = document.createElement('span');
    this.staleDotEl.className = 'panel-stale-dot';

    this.actionsEl = document.createElement('div');
    this.actionsEl.className = 'panel-actions';
    this.actionsSlot = document.createElement('slot');
    this.actionsSlot.name = 'actions';
    this.actionsEl.appendChild(this.actionsSlot);

    this.headerEl.appendChild(this.titleEl);
    this.headerEl.appendChild(this.staleDotEl);
    this.headerEl.appendChild(this.actionsEl);

    const skeleton = document.createElement('div');
    skeleton.className = 'panel-skeleton';

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'panel-body';

    this.errorTextEl = document.createElement('div');
    this.errorTextEl.className = 'panel-error-text';
    this.errorTextEl.textContent = 'Fehler';

    this.bodySlot = document.createElement('slot');

    this.bodyEl.appendChild(skeleton);
    this.bodyEl.appendChild(this.errorTextEl);
    this.bodyEl.appendChild(this.bodySlot);

    this.innerEl.appendChild(this.headerEl);
    this.innerEl.appendChild(this.bodyEl);
    this.wrapperEl.appendChild(this.innerEl);
    this.root.appendChild(this.wrapperEl);

    this.titleSlot.addEventListener('slotchange', () => this.syncHeaderVisibility());
    this.actionsSlot.addEventListener('slotchange', () => this.syncHeaderVisibility());
    this.bodySlot.addEventListener('slotchange', () => this.syncErrorTextVisibility());

    this.syncHeaderVisibility();
    this.syncErrorTextVisibility();
  }

  static get observedAttributes(): string[] {
    return ['title', 'accent', 'state'];
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (!this.titleEl) return;
    if (name === 'title') {
      const textEl = this.titleEl.querySelector('.panel-title-text');
      if (textEl) textEl.textContent = value ?? '';
      this.syncHeaderVisibility();
    }
    if (name === 'state') {
      this.syncErrorTextVisibility();
    }
  }

  private syncHeaderVisibility(): void {
    const hasTitleAttr = (this.getAttribute('title') ?? '').trim().length > 0;
    const hasTitleSlot = this.titleSlot.assignedNodes().length > 0;
    const hasActions = this.actionsSlot.assignedNodes().length > 0;

    this.actionsEl.hidden = !hasActions;
    this.headerEl.hidden = !(hasTitleAttr || hasTitleSlot || hasActions);
  }

  private syncErrorTextVisibility(): void {
    const state = this.getAttribute('state');
    const hasBodyContent = this.bodySlot.assignedNodes().length > 0;
    this.errorTextEl.classList.toggle('is-visible', state === 'error' && !hasBodyContent);
  }
}

export function sarahPanel(props: {
  title?: string;
  accent?: PanelAccent;
  state?: PanelState;
  children?: (HTMLElement | string)[];
}): SarahPanel {
  const el = document.createElement('sarah-panel') as SarahPanel;
  if (props.title) el.setAttribute('title', props.title);
  el.setAttribute('accent', props.accent ?? 'cyan');
  el.setAttribute('state', props.state ?? 'idle');
  if (props.children) {
    for (const child of props.children) {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
      } else {
        el.appendChild(child);
      }
    }
  }
  return el;
}
