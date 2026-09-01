import { afterAll, beforeAll, describe, expect, it } from 'vitest';

class FakeShadowRoot {
  private readonly children: FakeHTMLElement[] = [];

  constructor(private readonly host: EventTarget) {}

  prepend(child: FakeHTMLElement): void {
    this.children.unshift(child);
  }

  appendChild<T extends FakeHTMLElement>(child: T): T {
    child.propagationHost = this.host;
    this.children.push(child);
    return child;
  }

  querySelector(selector: string): FakeHTMLElement | null {
    return selector === 'button'
      ? this.children.find((child) => child.tagName === 'BUTTON') ?? null
      : null;
  }
}

class FakeHTMLElement extends EventTarget {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  shadowRoot: FakeShadowRoot | null = null;
  propagationHost: EventTarget | null = null;
  className = '';
  textContent = '';
  disabled = false;

  constructor(tagName = 'sarah-button') {
    super();
    this.tagName = tagName.toUpperCase();
  }

  attachShadow(): FakeShadowRoot {
    this.shadowRoot = new FakeShadowRoot(this);
    return this.shadowRoot;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild<T extends FakeHTMLElement>(child: T): T {
    return child;
  }

  click(): void {
    const click = new Event('click', { bubbles: true, composed: true });
    this.dispatchEvent(click);

    if (click.bubbles && click.composed) {
      this.propagationHost?.dispatchEvent(
        new Event('click', { bubbles: true, composed: true })
      );
    }
  }
}

const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

beforeAll(() => {
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    value: FakeHTMLElement,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tagName: string): FakeHTMLElement => new FakeHTMLElement(tagName),
    },
  });
});

afterAll(() => {
  if (originalHTMLElement) {
    Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement);
  } else {
    Reflect.deleteProperty(globalThis, 'HTMLElement');
  }

  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', originalDocument);
  } else {
    Reflect.deleteProperty(globalThis, 'document');
  }
});

describe('SarahButton', () => {
  it('delivers one host click for one native button click', async () => {
    const { SarahButton } = await import('../../../src/renderer/components/sarah-button.js');
    const element = new SarahButton();
    element.connectedCallback();

    let clickCount = 0;
    element.addEventListener('click', () => {
      clickCount += 1;
    });

    const nativeButton = element.shadowRoot?.querySelector('button');
    expect(nativeButton).not.toBeNull();
    nativeButton?.click();

    expect(clickCount).toBe(1);
  });
});
