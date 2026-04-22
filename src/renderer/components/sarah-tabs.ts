import { SarahElement } from './base.js';
import { keyToTabAction, nextTabIndex } from './sarah-tabs-logic.js';

const CSS = `
  .tablist {
    display: flex;
    flex-direction: row;
    gap: var(--sarah-space-lg);
    border-bottom: 1px solid var(--sarah-border);
    padding: 0;
    margin: 0;
  }

  .tab {
    appearance: none;
    background: none;
    border: none;
    padding: var(--sarah-space-sm) 0;
    margin-bottom: -1px;
    color: var(--sarah-text-secondary);
    font-family: var(--sarah-font-family);
    font-size: var(--sarah-font-size-md);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color var(--sarah-transition-fast), border-color var(--sarah-transition-fast);
  }

  .tab:hover {
    color: var(--sarah-text-primary);
  }

  .tab[aria-selected="true"] {
    color: var(--sarah-accent);
    border-bottom-color: var(--sarah-accent);
  }

  .tab:focus-visible {
    outline: 2px solid var(--sarah-accent-hover);
    outline-offset: 4px;
    border-radius: var(--sarah-radius-sm);
  }
`;

export interface TabItem {
  id: string;
  label: string;
}

export class SarahTabs extends SarahElement {
  private _tabs: TabItem[] = [];
  private _activeId: string | null = null;
  private container!: HTMLElement;

  connectedCallback(): void {
    this.injectStyles(CSS);

    this.container = document.createElement('div');
    this.container.className = 'tablist';
    this.container.setAttribute('role', 'tablist');
    this.container.setAttribute('aria-orientation', 'horizontal');
    this.root.appendChild(this.container);

    this.render();
  }

  setTabs(tabs: TabItem[]): void {
    this._tabs = tabs;
    if (this._activeId === null && tabs.length > 0) {
      this._activeId = tabs[0].id;
    }
    if (this.container) this.render();
  }

  /**
   * Programmatisch den aktiven Tab setzen.
   * Feuert KEIN `tab-change`-Event (Setter = externe Ursache, Event wäre Echo).
   */
  setActiveId(id: string): void {
    if (!this._tabs.some(t => t.id === id)) return;
    this._activeId = id;
    if (this.container) this.render();
  }

  getActiveId(): string | null {
    return this._activeId;
  }

  private render(): void {
    this.container.innerHTML = '';
    this._tabs.forEach((tab) => {
      const button = document.createElement('button');
      button.className = 'tab';
      button.type = 'button';
      button.id = `tab-${tab.id}`;
      button.textContent = tab.label;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `panel-${tab.id}`);
      const isActive = tab.id === this._activeId;
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      button.tabIndex = isActive ? 0 : -1;

      button.addEventListener('click', () => this.activate(tab.id));
      button.addEventListener('keydown', (e) => this.handleKey(e, tab.id));

      this.container.appendChild(button);
    });
  }

  private activate(id: string): void {
    if (id === this._activeId) return;
    this._activeId = id;
    this.render();
    this.focusTab(id);
    this.dispatchEvent(new CustomEvent('tab-change', {
      detail: { id },
      bubbles: true,
      composed: true,
    }));
  }

  private handleKey(e: KeyboardEvent, currentId: string): void {
    const action = keyToTabAction(e.key);
    if (action === null) return;
    e.preventDefault();

    if (action === 'activate') {
      this.activate(currentId);
      return;
    }

    const currentIndex = this._tabs.findIndex(t => t.id === currentId);
    if (currentIndex < 0) return;
    const nextIndex = nextTabIndex(currentIndex, action, this._tabs.length);
    const nextId = this._tabs[nextIndex].id;
    this.activate(nextId);
  }

  private focusTab(id: string): void {
    const btn = this.root.querySelector<HTMLElement>(`#tab-${id}`);
    btn?.focus();
  }
}

export function sarahTabs(props: {
  tabs: TabItem[];
  activeId?: string;
  onChange?: (id: string) => void;
}): SarahTabs {
  const el = document.createElement('sarah-tabs') as SarahTabs;
  el.setTabs(props.tabs);
  if (props.activeId) el.setActiveId(props.activeId);
  if (props.onChange) {
    el.addEventListener('tab-change', ((e: CustomEvent) => {
      props.onChange!(e.detail.id);
    }) as EventListener);
  }
  return el;
}
