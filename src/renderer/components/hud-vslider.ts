import { SarahElement, createElement } from './base.js';
import {
  computeMarkerPosition,
  formatVSliderValueText,
  type HudVSliderUnit,
} from './hud-vslider-format.js';

export { formatVSliderValueText, computeMarkerPosition } from './hud-vslider-format.js';
export type { HudVSliderUnit } from './hud-vslider-format.js';

const CSS = `
  :host {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    color: var(--panel-accent-color, var(--cockpit-accent-cyan));
  }

  .track-wrap {
    position: relative;
    height: 100px;
    min-height: 100px;
    display: flex;
    align-items: stretch;
    justify-content: center;
    padding: 0 6px;
  }

  /* Default-marker tick — a subtle horizontal line at a configured fraction */
  .marker {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: 10px;
    height: 1px;
    background: color-mix(in srgb, currentColor 55%, transparent);
    opacity: 0.6;
    pointer-events: none;
  }

  input[type="range"] {
    /* Vertical orientation per current WHATWG/CSS spec — avoids the deprecated
       -webkit-appearance: slider-vertical. */
    writing-mode: vertical-lr;
    direction: rtl;
    appearance: slider-vertical; /* tolerated by Chromium; harmless fallback */
    width: 18px;
    height: 100%;
    margin: 0;
    padding: 0;
    background: transparent;
    -webkit-appearance: none;
    outline: none;
    cursor: pointer;
  }

  /* Track (WebKit / Chromium / Electron) */
  input[type="range"]::-webkit-slider-runnable-track {
    width: 4px;
    height: 100%;
    background: linear-gradient(
      to top,
      rgba(216, 241, 255, 0.08),
      color-mix(in srgb, currentColor 80%, transparent) 50%,
      rgba(216, 241, 255, 0.08)
    );
    border-radius: 2px;
  }

  /* Thumb (WebKit / Chromium / Electron) */
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 6px;
    border-radius: 2px;
    background: currentColor;
    box-shadow:
      0 0 6px color-mix(in srgb, currentColor 70%, transparent),
      0 0 1px rgba(0, 0, 0, 0.6);
    border: none;
    cursor: pointer;
    /* Centre the thumb on the 4px track (track sits inside 18px input).
       The rotation from writing-mode means "margin-left" shifts across the
       track's short axis. */
    margin-left: -5px;
  }

  input[type="range"]:focus-visible::-webkit-slider-thumb {
    box-shadow:
      0 0 0 2px color-mix(in srgb, currentColor 55%, transparent),
      0 0 8px color-mix(in srgb, currentColor 70%, transparent);
  }

  .label {
    font-family: var(--cockpit-font-heading);
    font-size: 0.6rem;
    letter-spacing: 0.15em;
    color: var(--cockpit-text-dim);
    text-transform: uppercase;
    user-select: none;
  }

  @media (prefers-reduced-motion: reduce) {
    input[type="range"]::-webkit-slider-thumb {
      transition: none;
    }
  }
`;

/**
 * Vertical cockpit-styled slider. Wraps a native `<input type="range">`
 * rotated via `writing-mode: vertical-lr; direction: rtl;` so the 0 end is
 * at the bottom.
 *
 * Events:
 *   `input`  — CustomEvent<{ value: number }> fired during drag, rAF-throttled.
 *   `change` — CustomEvent<{ value: number }> fired on drag-end (native change).
 *
 * The `input` stream is throttled to one event per animation frame so a hot
 * drag doesn't fire 60+ `saveConfig` calls per second. Consumers that only
 * want the committed value should listen to `change`.
 */
export class HudVSlider extends SarahElement {
  private input!: HTMLInputElement;
  private labelEl!: HTMLSpanElement;
  private markerEl: HTMLDivElement | null = null;
  private unit: HudVSliderUnit = 'percent';
  private _defaultMarker: number | null = null;
  private _rafHandle: number | null = null;
  private _pendingInputValue: number | null = null;
  private _suppressEvents = false;

  connectedCallback(): void {
    this.injectStyles(CSS);

    const unitAttr = this.getAttribute('unit');
    if (unitAttr === 'percent' || unitAttr === 'multiplier' || unitAttr === 'raw') {
      this.unit = unitAttr;
    }

    const markerAttr = this.getAttribute('default-marker');
    if (markerAttr !== null) {
      const parsed = Number.parseFloat(markerAttr);
      if (Number.isFinite(parsed)) this._defaultMarker = parsed;
    }

    const wrap = document.createElement('div');
    wrap.className = 'track-wrap';

    this.input = document.createElement('input');
    this.input.type = 'range';
    this.input.min = this.getAttribute('min') ?? '0';
    this.input.max = this.getAttribute('max') ?? '1';
    this.input.step = this.getAttribute('step') ?? '0.01';
    const valueAttr = this.getAttribute('value');
    this.input.value = valueAttr ?? this.input.min;
    // writing-mode: vertical-lr + direction: rtl is the modern spec-compliant
    // replacement for the deprecated orient="vertical".
    this.input.setAttribute('aria-orientation', 'vertical');

    this.syncAriaValueText();

    wrap.appendChild(this.input);

    if (this._defaultMarker !== null) {
      this.markerEl = document.createElement('div');
      this.markerEl.className = 'marker';
      this.markerEl.setAttribute('aria-hidden', 'true');
      this.positionMarker();
      wrap.appendChild(this.markerEl);
    }

    this.labelEl = document.createElement('span');
    this.labelEl.className = 'label';
    this.labelEl.textContent = this.getAttribute('label') ?? '';

    this.input.addEventListener('input', this.onInputEvent);
    this.input.addEventListener('change', this.onChangeEvent);

    this.root.appendChild(wrap);
    this.root.appendChild(this.labelEl);
  }

  disconnectedCallback(): void {
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
    this._pendingInputValue = null;
    this.input?.removeEventListener('input', this.onInputEvent);
    this.input?.removeEventListener('change', this.onChangeEvent);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get value(): number {
    if (!this.input) {
      const attr = this.getAttribute('value');
      return attr !== null ? Number.parseFloat(attr) : 0;
    }
    return Number.parseFloat(this.input.value);
  }

  set value(v: number) {
    if (!Number.isFinite(v)) return;
    if (this.input) {
      this.input.value = String(v);
      this.syncAriaValueText();
    } else {
      this.setAttribute('value', String(v));
    }
  }

  get defaultMarker(): number | null {
    return this._defaultMarker;
  }

  set defaultMarker(v: number | null) {
    this._defaultMarker = v;
    if (!this.input) return;
    if (v === null) {
      if (this.markerEl) {
        this.markerEl.remove();
        this.markerEl = null;
      }
      return;
    }
    if (!this.markerEl) {
      this.markerEl = document.createElement('div');
      this.markerEl.className = 'marker';
      this.markerEl.setAttribute('aria-hidden', 'true');
      this.input.parentElement?.appendChild(this.markerEl);
    }
    this.positionMarker();
  }

  /**
   * Set `value` without dispatching `input`/`change`. Used by parents that
   * receive a config-echo event and want to sync the UI without looping back
   * into `saveConfig`.
   */
  setValueSilent(v: number): void {
    this._suppressEvents = true;
    try {
      this.value = v;
    } finally {
      this._suppressEvents = false;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private positionMarker(): void {
    if (!this.markerEl) return;
    const min = Number.parseFloat(this.input.min);
    const max = Number.parseFloat(this.input.max);
    const frac = computeMarkerPosition(this._defaultMarker ?? 0, min, max);
    this.markerEl.style.bottom = `${(frac * 100).toFixed(2)}%`;
  }

  private syncAriaValueText(): void {
    if (!this.input) return;
    const v = Number.parseFloat(this.input.value);
    this.input.setAttribute('aria-valuetext', formatVSliderValueText(v, this.unit));
  }

  private onInputEvent = (): void => {
    this.syncAriaValueText();
    if (this._suppressEvents) return;
    // rAF-throttle so a fast drag doesn't fire one event per mouse pixel.
    this._pendingInputValue = Number.parseFloat(this.input.value);
    if (this._rafHandle !== null) return;
    this._rafHandle = requestAnimationFrame(() => {
      this._rafHandle = null;
      const v = this._pendingInputValue;
      this._pendingInputValue = null;
      if (v === null || !Number.isFinite(v)) return;
      this.dispatchEvent(new CustomEvent('input', {
        detail: { value: v },
        bubbles: true,
        composed: true,
      }));
    });
  };

  private onChangeEvent = (): void => {
    // Flush any pending throttled input first so consumers see the final
    // mid-drag value before the commit.
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
      this._pendingInputValue = null;
    }
    this.syncAriaValueText();
    if (this._suppressEvents) return;
    const v = Number.parseFloat(this.input.value);
    if (!Number.isFinite(v)) return;
    this.dispatchEvent(new CustomEvent('change', {
      detail: { value: v },
      bubbles: true,
      composed: true,
    }));
  };
}

/** Factory for the `hud-vslider` custom element. */
export function hudVSlider(props: {
  label: string;
  min?: number;
  max?: number;
  step?: number;
  value: number;
  defaultMarker?: number;
  unit?: HudVSliderUnit;
  onChange?: (value: number) => void;
  onInput?: (value: number) => void;
}): HudVSlider {
  const attrs: Record<string, string> = {
    label: props.label,
    value: String(props.value),
  };
  if (props.min !== undefined) attrs.min = String(props.min);
  if (props.max !== undefined) attrs.max = String(props.max);
  if (props.step !== undefined) attrs.step = String(props.step);
  if (props.defaultMarker !== undefined) attrs['default-marker'] = String(props.defaultMarker);
  if (props.unit !== undefined) attrs.unit = props.unit;

  const el = createElement<HudVSlider>('hud-vslider', attrs);

  if (props.onChange) {
    el.addEventListener('change', ((e: CustomEvent<{ value: number }>) => {
      props.onChange!(e.detail.value);
    }) as EventListener);
  }
  if (props.onInput) {
    el.addEventListener('input', ((e: CustomEvent<{ value: number }>) => {
      props.onInput!(e.detail.value);
    }) as EventListener);
  }
  return el;
}
