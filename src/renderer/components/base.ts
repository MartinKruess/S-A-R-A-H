/**
 * Shared theme CSS injected into every component's Shadow DOM.
 * CSS custom properties defined on :root pierce Shadow DOM automatically,
 * but we need base styles (font, color) inside each shadow root.
 */
export const THEME_CSS = `
  :host {
    font-family: var(--sarah-font-family);
    color: var(--sarah-text-primary);
    box-sizing: border-box;
  }
  :host *, :host *::before, :host *::after {
    box-sizing: border-box;
  }
`;

/**
 * Base class for all sarah-* components.
 * Provides Shadow DOM with theme styles pre-injected.
 */
export class SarahElement extends HTMLElement {
  protected root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  /** Inject a <style> block into the shadow root. Prepends THEME_CSS automatically. */
  protected injectStyles(css: string): void {
    const style = document.createElement('style');
    style.textContent = THEME_CSS + css;
    this.root.prepend(style);
  }
}

/** Helper type for factory function props. */
export type ChildrenProp = { children?: (HTMLElement | string)[] };

/** Convenience: create an element, set attributes, append children. */
export function createElement<T extends HTMLElement>(
  tag: string,
  attrs?: Record<string, string>,
  children?: (HTMLElement | string)[]
): T {
  const el = document.createElement(tag) as T;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
      } else {
        el.appendChild(child);
      }
    }
  }
  return el;
}
