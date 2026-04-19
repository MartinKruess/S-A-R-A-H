import { SarahElement, createElement } from './base.js';
import {
  ariaPressedFor,
  nextPressedState,
  shouldTriggerToggle,
} from './hud-toggle-logic.js';

export { ariaPressedFor, nextPressedState, shouldTriggerToggle } from './hud-toggle-logic.js';

const CSS = `
  :host {
    display: inline-block;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--cockpit-font-heading);
    font-size: 0.68rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--cockpit-text-hud);
    background: color-mix(
      in srgb,
      var(--panel-accent-color, var(--cockpit-accent-cyan)) 6%,
      rgba(216, 241, 255, 0.04)
    );
    border: 1px solid color-mix(
      in srgb,
      var(--panel-accent-color, var(--cockpit-accent-cyan)) 30%,
      rgba(216, 241, 255, 0.14)
    );
    border-radius: 999px;
    padding: 4px 12px;
    cursor: pointer;
    user-select: none;
    outline: none;
    /* Raised 3D shadow — unmuted state */
    box-shadow:
      -2px -2px 4px rgba(216, 241, 255, 0.1),
      2px 2px 6px rgba(0, 0, 0, 0.6);
    transition:
      box-shadow 180ms ease,
      color 180ms ease,
      background 180ms ease,
      border-color 180ms ease;
  }

  .btn:hover {
    border-color: color-mix(
      in srgb,
      var(--panel-accent-color, var(--cockpit-accent-cyan)) 55%,
      rgba(216, 241, 255, 0.2)
    );
  }

  .btn:focus-visible {
    border-color: var(--panel-accent-color, var(--cockpit-accent-cyan));
    box-shadow:
      -2px -2px 4px rgba(216, 241, 255, 0.1),
      2px 2px 6px rgba(0, 0, 0, 0.6),
      0 0 10px color-mix(
        in srgb,
        var(--panel-accent-color, var(--cockpit-accent-cyan)) 45%,
        transparent
      );
  }

  /* Pressed 3D shadow — muted state */
  :host([pressed]) .btn {
    color: color-mix(
      in srgb,
      var(--cockpit-text-hud) 65%,
      transparent
    );
    box-shadow:
      inset -2px -2px 4px rgba(216, 241, 255, 0.08),
      inset 2px 2px 6px rgba(0, 0, 0, 0.5);
  }

  :host([pressed]) .btn:focus-visible {
    box-shadow:
      inset -2px -2px 4px rgba(216, 241, 255, 0.08),
      inset 2px 2px 6px rgba(0, 0, 0, 0.5),
      0 0 10px color-mix(
        in srgb,
        var(--panel-accent-color, var(--cockpit-accent-cyan)) 45%,
        transparent
      );
  }

  @media (prefers-reduced-motion: reduce) {
    .btn {
      transition: none;
    }
  }
`;

/**
 * Cockpit-styled 3D push-button used as the microphone mute toggle. Raised
 * when unmuted, visually "pressed" (inset shadow) when muted.
 *
 * Events:
 *   `change` — CustomEvent<{ value: boolean }> fired when the user toggles
 *              via click, Enter, or Space. Not fired when `.pressed` is set
 *              programmatically (for config-echo sync).
 */
export class HudToggle extends SarahElement {
  private btn!: HTMLButtonElement;
  private _pressed = false;
  private _suppressChange = false;

  connectedCallback(): void {
    this.injectStyles(CSS);

    this._pressed = this.hasAttribute('pressed');

    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'btn';
    this.btn.setAttribute('role', 'button');
    this.btn.tabIndex = 0;
    this.btn.textContent = this.getAttribute('label') ?? '';
    this.syncAria();

    this.btn.addEventListener('click', this.onClick);
    this.btn.addEventListener('keydown', this.onKeydown);
    this.btn.addEventListener('keyup', this.onKeyup);

    this.root.appendChild(this.btn);
  }

  disconnectedCallback(): void {
    this.btn?.removeEventListener('click', this.onClick);
    this.btn?.removeEventListener('keydown', this.onKeydown);
    this.btn?.removeEventListener('keyup', this.onKeyup);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get pressed(): boolean {
    return this._pressed;
  }

  set pressed(val: boolean) {
    if (this._pressed === val) return;
    this._pressed = val;
    if (val) {
      this.setAttribute('pressed', '');
    } else {
      this.removeAttribute('pressed');
    }
    this.syncAria();
  }

  /**
   * Set the pressed state without dispatching `change`. Used by parents that
   * receive a config-echo event and want to sync the UI without triggering
   * the onChange callback (which would write the same value back into config
   * and loop).
   */
  setPressedSilent(val: boolean): void {
    this._suppressChange = true;
    try {
      this.pressed = val;
    } finally {
      this._suppressChange = false;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private syncAria(): void {
    if (!this.btn) return;
    this.btn.setAttribute('aria-pressed', ariaPressedFor(this._pressed));
    const ariaLabel = this.getAttribute('aria-label') ?? this.getAttribute('label') ?? '';
    if (ariaLabel) {
      this.btn.setAttribute('aria-label', ariaLabel);
    }
  }

  private toggle(): void {
    this.pressed = nextPressedState(this._pressed);
    if (!this._suppressChange) {
      this.dispatchEvent(new CustomEvent('change', {
        detail: { value: this._pressed },
        bubbles: true,
        composed: true,
      }));
    }
  }

  private onClick = (): void => {
    this.toggle();
  };

  /**
   * Enter triggers on keydown (native button convention). Space is handled
   * on keyup so auto-repeat doesn't fire multiple toggles.
   */
  private onKeydown = (evt: KeyboardEvent): void => {
    if (shouldTriggerToggle(evt.key, 'keydown')) {
      evt.preventDefault();
      this.toggle();
    } else if (evt.key === ' ') {
      // Prevent page scroll; actual toggle happens on keyup.
      evt.preventDefault();
    }
  };

  private onKeyup = (evt: KeyboardEvent): void => {
    if (shouldTriggerToggle(evt.key, 'keyup')) {
      evt.preventDefault();
      this.toggle();
    }
  };
}

/** Factory for the `hud-toggle` custom element. */
export function hudToggle(props: {
  label: string;
  pressed?: boolean;
  ariaLabel?: string;
  onChange?: (value: boolean) => void;
}): HudToggle {
  const attrs: Record<string, string> = { label: props.label };
  if (props.pressed) attrs.pressed = '';
  if (props.ariaLabel) attrs['aria-label'] = props.ariaLabel;
  const el = createElement<HudToggle>('hud-toggle', attrs);
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent<{ value: boolean }>) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
