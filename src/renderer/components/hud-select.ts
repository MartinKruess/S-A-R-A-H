import { SarahElement, createElement } from './base.js';
import {
  LABEL_PREFIX,
  SYSTEM_DEFAULT_LABEL,
  toDeviceOptions,
  type DeviceInfoLike,
  type HudSelectKind,
  type HudSelectOption,
} from './hud-select-options.js';

export { toDeviceOptions } from './hud-select-options.js';
export type { HudSelectKind, HudSelectOption, DeviceInfoLike } from './hud-select-options.js';

const CSS = `
  :host {
    display: inline-block;
    position: relative;
  }

  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--cockpit-font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    text-transform: none;
    color: var(--cockpit-text-hud);
    background: rgba(216, 241, 255, 0.04);
    border: 1px solid rgba(216, 241, 255, 0.14);
    border-radius: 999px;
    padding: 4px 10px 4px 12px;
    cursor: pointer;
    user-select: none;
    transition: border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
    outline: none;
    max-width: 100%;
  }

  .trigger:hover,
  .trigger:focus-visible {
    border-color: var(--panel-accent-color, var(--cockpit-accent-cyan));
    box-shadow: 0 0 10px color-mix(in srgb, var(--panel-accent-color, var(--cockpit-accent-cyan)) 40%, transparent);
    background: rgba(216, 241, 255, 0.07);
  }

  :host([open]) .trigger {
    border-color: var(--panel-accent-color, var(--cockpit-accent-cyan));
    box-shadow: 0 0 14px color-mix(in srgb, var(--panel-accent-color, var(--cockpit-accent-cyan)) 55%, transparent);
  }

  .trigger-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22ch;
  }

  .trigger-chevron {
    width: 10px;
    height: 10px;
    flex: 0 0 auto;
    transition: transform 180ms ease;
    color: var(--panel-accent-color, var(--cockpit-accent-cyan));
  }

  :host([open]) .trigger-chevron {
    transform: rotate(180deg);
  }

  /* Uses the native Popover API so the listbox renders in the top layer,
     escaping the sarah-panel's clip-path / backdrop-filter containing block.
     Default popover UA styles (inset: 0, margin: auto, border, background)
     need to be neutralised so positionPopup() can anchor via top/left/bottom. */
  .listbox {
    position: fixed;
    inset: unset;
    margin: 0;
    min-width: 220px;
    max-width: 360px;
    max-height: 260px;
    overflow-y: auto;
    padding: 4px;
    list-style: none;
    background: rgba(11, 18, 32, 0.96);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid color-mix(in srgb, var(--panel-accent-color, var(--cockpit-accent-cyan)) 40%, rgba(216, 241, 255, 0.18));
    border-radius: 10px;
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.55),
      0 0 22px color-mix(in srgb, var(--panel-accent-color, var(--cockpit-accent-cyan)) 30%, transparent);
  }

  .option {
    font-family: var(--cockpit-font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.03em;
    color: var(--cockpit-text-hud);
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background 120ms ease, color 120ms ease, box-shadow 120ms ease;
  }

  .option[aria-selected="true"] {
    color: var(--panel-accent-color, var(--cockpit-accent-cyan));
  }

  .option.is-active,
  .option:hover {
    background: color-mix(in srgb, var(--panel-accent-color, var(--cockpit-accent-cyan)) 14%, transparent);
    color: var(--panel-accent-color, var(--cockpit-accent-cyan));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--panel-accent-color, var(--cockpit-accent-cyan)) 45%, transparent);
  }

  @media (prefers-reduced-motion: reduce) {
    .trigger, .trigger-chevron, .option {
      transition: none;
    }
  }
`;

/**
 * Popup sizing constants. The CSS in this file is the source of truth — these
 * values mirror the `.listbox` rule above and are used by `positionPopup()` for
 * flip/clamp math. Keep in sync when editing the CSS block.
 */
const POPUP_MAX_HEIGHT = 260; // must match .listbox max-height in CSS above
const POPUP_MIN_WIDTH = 220;  // must match .listbox min-width in CSS above
const POPUP_GAP = 6;          // gap between trigger and popup

/** Lightweight id counter so every listbox/option has a stable DOM id. */
let uidCounter = 0;
function nextUid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

/**
 * Cockpit-styled custom combobox. Enumerates media devices itself and keeps
 * its option list in sync with `devicechange`. On first open it may request
 * a one-shot mic permission so that `enumerateDevices()` returns labels.
 *
 * Events:
 *   `change` — CustomEvent<{ value: string }> when a user selects an option.
 */
export class HudSelect extends SarahElement {
  private trigger!: HTMLButtonElement;
  private triggerLabel!: HTMLSpanElement;
  private listbox!: HTMLUListElement;
  private optionEls: HTMLLIElement[] = [];
  private options: HudSelectOption[] = [];
  private kind: HudSelectKind = 'audioinput';
  private _value: string = '';
  private _open = false;
  private _activeIndex = -1;
  private _hasRequestedPermission = false;
  private _devicesListener: (() => void) | null = null;
  private _windowListeners: Array<{ target: EventTarget; type: string; fn: EventListener }> = [];
  private _listboxId: string = '';
  private _refreshInFlight: Promise<void> | null = null;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const kindAttr = this.getAttribute('kind');
    if (kindAttr === 'audioinput' || kindAttr === 'audiooutput') {
      this.kind = kindAttr;
    }

    this._listboxId = nextUid('hud-select-listbox');

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'trigger';
    this.trigger.setAttribute('role', 'combobox');
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', this._listboxId);

    this.triggerLabel = document.createElement('span');
    this.triggerLabel.className = 'trigger-label';

    const chevron = document.createElement('span');
    chevron.className = 'trigger-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="10" height="10" fill="currentColor">
        <path d="M6 8L1 3h10z"/>
      </svg>
    `;

    this.trigger.appendChild(this.triggerLabel);
    this.trigger.appendChild(chevron);

    this.listbox = document.createElement('ul');
    this.listbox.className = 'listbox';
    this.listbox.id = this._listboxId;
    this.listbox.setAttribute('role', 'listbox');
    this.listbox.setAttribute('popover', 'manual');
    this.listbox.tabIndex = -1;

    this.root.appendChild(this.trigger);
    this.root.appendChild(this.listbox);

    this.trigger.addEventListener('click', this.onTriggerClick);
    this.trigger.addEventListener('keydown', this.onTriggerKeydown);

    // Seed with a pure "System-Standard" option so the component renders
    // something even before devices arrive.
    this.setOptions(toDeviceOptions([], this.kind));

    this.attachDeviceChangeListener();
    // Initial best-effort enumeration (labels will be empty until permission).
    void this.refreshDevices(false);
  }

  disconnectedCallback(): void {
    this.closePopup();
    this.detachDeviceChangeListener();
    this.removeWindowListeners();
    this.trigger?.removeEventListener('click', this.onTriggerClick);
    this.trigger?.removeEventListener('keydown', this.onTriggerKeydown);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get value(): string {
    return this._value;
  }

  set value(v: string) {
    if (this._value === v) return;
    this._value = v;
    // Guard: `value` may be set before the element is connected to the DOM
    // (e.g. when a view builds its subtree in-memory and appends later).
    // `triggerLabel` / `trigger` are only assigned in `connectedCallback`,
    // so we skip the sync calls here and let `setOptions()` (called from
    // `connectedCallback` and `refreshDevices`) apply the stored `_value`
    // once the DOM is in place.
    if (!this.triggerLabel || !this.trigger) return;
    this.syncTriggerLabel();
    this.syncOptionSelection();
  }

  setKind(kind: HudSelectKind): void {
    if (this.kind === kind) return;
    this.kind = kind;
    void this.refreshDevices(false);
  }

  setOptions(options: HudSelectOption[]): void {
    this.options = options;
    this.renderOptions();
    this.syncTriggerLabel();
    this.syncOptionSelection();
  }

  /**
   * Explicitly re-enumerate devices. Public so parents can force a refresh.
   *
   * Concurrent callers (e.g. rapid open/close firing both the initial
   * enumeration and the on-open permission refresh) share a single in-flight
   * promise — this prevents two parallel `setOptions()` calls from racing.
   */
  refreshDevices(requestPermissionIfNeeded: boolean): Promise<void> {
    if (this._refreshInFlight !== null) {
      return this._refreshInFlight;
    }
    const p = this.doRefreshDevices(requestPermissionIfNeeded).finally(() => {
      this._refreshInFlight = null;
    });
    this._refreshInFlight = p;
    return p;
  }

  private async doRefreshDevices(requestPermissionIfNeeded: boolean): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    let devices: DeviceInfoLike[] = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
      console.warn('[hud-select] enumerateDevices failed:', err);
      devices = [];
    }

    const needsPermission =
      requestPermissionIfNeeded &&
      this.kind === 'audioinput' &&
      !this._hasRequestedPermission &&
      devices.filter((d) => d.kind === 'audioinput').every((d) => !d.label);

    if (needsPermission) {
      this._hasRequestedPermission = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        try {
          devices = await navigator.mediaDevices.enumerateDevices();
        } catch (err) {
          console.warn('[hud-select] re-enumerate after permission failed:', err);
        }
      } catch (err) {
        // User denied or device unavailable — fall back to whatever we had.
        console.warn('[hud-select] getUserMedia permission denied or failed:', err);
      }
    }

    this.setOptions(toDeviceOptions(devices, this.kind));
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private renderOptions(): void {
    this.listbox.innerHTML = '';
    this.optionEls = this.options.map((opt, i) => {
      const li = document.createElement('li');
      li.className = 'option';
      li.id = `${this._listboxId}-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.value = opt.value;
      li.textContent = opt.label;
      li.addEventListener('mouseenter', () => this.setActiveIndex(i, false));
      li.addEventListener('click', () => this.selectIndex(i));
      this.listbox.appendChild(li);
      return li;
    });
  }

  private syncTriggerLabel(): void {
    const current = this.options.find((o) => o.value === this._value);
    const deviceName = current?.label ?? SYSTEM_DEFAULT_LABEL;
    this.triggerLabel.textContent = `${LABEL_PREFIX[this.kind]}: ${deviceName}`;
    this.trigger.setAttribute('aria-label', this.triggerLabel.textContent);
  }

  private syncOptionSelection(): void {
    for (let i = 0; i < this.optionEls.length; i++) {
      const selected = this.options[i]?.value === this._value;
      this.optionEls[i].setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  }

  private setActiveIndex(index: number, scrollIntoView: boolean): void {
    if (index < 0 || index >= this.optionEls.length) {
      this._activeIndex = -1;
      this.trigger.removeAttribute('aria-activedescendant');
      for (const el of this.optionEls) el.classList.remove('is-active');
      return;
    }
    this._activeIndex = index;
    for (let i = 0; i < this.optionEls.length; i++) {
      this.optionEls[i].classList.toggle('is-active', i === index);
    }
    const active = this.optionEls[index];
    this.trigger.setAttribute('aria-activedescendant', active.id);
    if (scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  private selectIndex(index: number): void {
    const opt = this.options[index];
    if (!opt) return;
    const changed = opt.value !== this._value;
    this._value = opt.value;
    this.syncTriggerLabel();
    this.syncOptionSelection();
    this.closePopup();
    if (changed) {
      this.dispatchEvent(new CustomEvent('change', {
        detail: { value: opt.value },
        bubbles: true,
        composed: true,
      }));
    }
  }

  // ── Popup open/close ──────────────────────────────────────────────────────

  private openPopup(): void {
    if (this._open) return;
    this._open = true;
    this.setAttribute('open', '');
    this.trigger.setAttribute('aria-expanded', 'true');
    this.showListbox();
    this.positionPopup();
    // Start active index on the currently selected option, or first.
    const selIdx = this.options.findIndex((o) => o.value === this._value);
    this.setActiveIndex(selIdx >= 0 ? selIdx : 0, true);

    // Trigger permission / refresh on first open (mic only).
    void this.refreshDevices(true);

    // Close on outside click / scroll / resize.
    const onDocClick = (evt: Event): void => {
      const path = evt.composedPath();
      if (!path.includes(this)) this.closePopup();
    };
    const onScroll = (): void => this.positionPopup();
    const onResize = (): void => this.positionPopup();
    const onKeyDown = (evt: KeyboardEvent): void => this.onDocumentKeydown(evt);

    document.addEventListener('mousedown', onDocClick, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKeyDown, true);

    this._windowListeners.push(
      { target: document, type: 'mousedown', fn: onDocClick as EventListener },
      { target: window, type: 'scroll', fn: onScroll as EventListener },
      { target: window, type: 'resize', fn: onResize as EventListener },
      { target: document, type: 'keydown', fn: onKeyDown as EventListener },
    );
  }

  private closePopup(): void {
    if (!this._open) return;
    this._open = false;
    this.removeAttribute('open');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.removeAttribute('aria-activedescendant');
    for (const el of this.optionEls) el.classList.remove('is-active');
    this._activeIndex = -1;
    this.hideListbox();
    this.removeWindowListeners();
  }

  private showListbox(): void {
    const el = this.listbox as HTMLElement & { showPopover?: () => void };
    if (typeof el.showPopover === 'function') {
      try {
        el.showPopover();
        return;
      } catch (err) {
        console.warn('[hud-select] showPopover failed, using fallback display', err);
      }
    }
    this.listbox.style.display = 'block';
  }

  private hideListbox(): void {
    const el = this.listbox as HTMLElement & { hidePopover?: () => void; matches: (sel: string) => boolean };
    if (typeof el.hidePopover === 'function') {
      try {
        if (el.matches(':popover-open')) el.hidePopover();
        return;
      } catch (err) {
        console.warn('[hud-select] hidePopover failed, using fallback display', err);
      }
    }
    this.listbox.style.display = 'none';
  }

  private removeWindowListeners(): void {
    for (const entry of this._windowListeners) {
      if (entry.type === 'mousedown' || entry.type === 'keydown') {
        (entry.target as Document).removeEventListener(entry.type, entry.fn, true);
      } else if (entry.type === 'scroll') {
        (entry.target as Window).removeEventListener(entry.type, entry.fn, true);
      } else {
        (entry.target as Window).removeEventListener(entry.type, entry.fn);
      }
    }
    this._windowListeners = [];
  }

  private positionPopup(): void {
    const rect = this.trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    // If the trigger has scrolled fully out of the viewport, close the popup
    // rather than pinning it to an invisible anchor.
    if (rect.bottom < 0 || rect.top > viewportH) {
      this.closePopup();
      return;
    }

    // Prefer below; if not enough space, flip above.
    const spaceBelow = viewportH - rect.bottom;
    const placeAbove = spaceBelow < POPUP_MAX_HEIGHT + POPUP_GAP && rect.top > spaceBelow;

    // Horizontal: align to trigger's left edge, but clamp so the popup fits
    // within the viewport (accounting for its effective width).
    const effectiveWidth = Math.max(this.listbox.offsetWidth, rect.width, POPUP_MIN_WIDTH);
    const maxLeft = viewportW - effectiveWidth - POPUP_GAP;
    const clampedLeft = Math.min(Math.max(POPUP_GAP, rect.left), Math.max(POPUP_GAP, maxLeft));

    this.listbox.style.left = `${clampedLeft}px`;
    this.listbox.style.minWidth = `${Math.max(rect.width, POPUP_MIN_WIDTH)}px`;
    if (placeAbove) {
      this.listbox.style.top = '';
      this.listbox.style.bottom = `${viewportH - rect.top + POPUP_GAP}px`;
    } else {
      this.listbox.style.bottom = '';
      this.listbox.style.top = `${rect.bottom + POPUP_GAP}px`;
    }
  }

  // ── Device-change subscription ────────────────────────────────────────────

  private attachDeviceChangeListener(): void {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return;
    const handler = (): void => {
      void this.refreshDevices(false);
    };
    navigator.mediaDevices.addEventListener('devicechange', handler);
    this._devicesListener = () => {
      navigator.mediaDevices.removeEventListener('devicechange', handler);
    };
  }

  private detachDeviceChangeListener(): void {
    if (this._devicesListener) {
      this._devicesListener();
      this._devicesListener = null;
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  private onTriggerClick = (): void => {
    if (this._open) {
      this.closePopup();
    } else {
      this.openPopup();
    }
  };

  private onTriggerKeydown = (evt: KeyboardEvent): void => {
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp' || evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      if (!this._open) {
        this.openPopup();
        return;
      }
    }
    if (this._open) {
      this.handlePopupKey(evt);
    }
  };

  private onDocumentKeydown = (evt: KeyboardEvent): void => {
    if (!this._open) return;
    this.handlePopupKey(evt);
  };

  private handlePopupKey(evt: KeyboardEvent): void {
    switch (evt.key) {
      case 'ArrowDown': {
        evt.preventDefault();
        const next = Math.min(this.optionEls.length - 1, this._activeIndex + 1);
        this.setActiveIndex(next >= 0 ? next : 0, true);
        break;
      }
      case 'ArrowUp': {
        evt.preventDefault();
        const prev = Math.max(0, this._activeIndex - 1);
        this.setActiveIndex(prev, true);
        break;
      }
      case 'Home': {
        evt.preventDefault();
        this.setActiveIndex(0, true);
        break;
      }
      case 'End': {
        evt.preventDefault();
        this.setActiveIndex(this.optionEls.length - 1, true);
        break;
      }
      case 'Enter':
      case ' ': {
        evt.preventDefault();
        if (this._activeIndex >= 0) {
          this.selectIndex(this._activeIndex);
          this.trigger.focus();
        }
        break;
      }
      case 'Escape': {
        evt.preventDefault();
        this.closePopup();
        this.trigger.focus();
        break;
      }
      case 'Tab': {
        this.closePopup();
        // Let Tab continue so the next focusable element gets focus.
        break;
      }
      default:
        break;
    }
  }
}

/** Factory for the `hud-select` custom element. */
export function hudSelect(props: {
  kind: HudSelectKind;
  value?: string;
  onChange?: (value: string) => void;
}): HudSelect {
  const el = createElement<HudSelect>('hud-select', { kind: props.kind });
  if (props.value !== undefined) el.value = props.value;
  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent<{ value: string }>) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
