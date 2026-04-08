/**
 * <sarah-svg> — loads public/sarah.svg inline so currentColor and external CSS work.
 * Usage: <sarah-svg width="22" height="22"></sarah-svg>
 * No Shadow DOM — SVG inherits styles from the page.
 *
 * Orb controller API:
 *   element.triggerBreak()   — play crack/burst animation
 *   element.setActive(bool)  — toggle hex-grid visibility
 *   element.setAccent(color) — change accent color
 */

export class SarahSvg extends HTMLElement {
  private svg: SVGElement | null = null;
  private busy = false;
  private breakDuration = 700;

  connectedCallback(): void {
    const w = this.getAttribute('width') ?? '24';
    const h = this.getAttribute('height') ?? '24';
    this.style.display = 'inline-flex';
    this.style.alignItems = 'center';
    this.style.justifyContent = 'center';
    this.style.cursor = 'pointer';

    fetch('public/sarah.svg')
      .then(r => r.text())
      .then(svgText => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = svgText;
        const svg = wrapper.querySelector('svg');
        if (svg) {
          svg.setAttribute('width', w);
          svg.setAttribute('height', h);
          svg.style.display = 'block';
          svg.style.overflow = 'visible';
          this.appendChild(svg);
          this.svg = svg;
        }
      });

    this.addEventListener('click', () => this.triggerBreak());
    this.addEventListener('mouseenter', () => this.triggerBreak());
  }

  triggerBreak(): void {
    if (this.busy || !this.svg) return;
    this.busy = true;

    // Force animation restart: remove class, trigger reflow, re-add
    this.svg.classList.remove('is-breaking');
    void (this.svg as unknown as HTMLElement).offsetWidth;
    this.svg.classList.add('is-breaking');

    setTimeout(() => {
      this.svg?.classList.remove('is-breaking');
      this.busy = false;
    }, this.breakDuration);
  }

  setActive(active: boolean): void {
    if (this.svg) {
      this.svg.classList.toggle('is-active', active);
    }
  }

  setAccent(color: string): void {
    this.style.setProperty('--sarah-accent', color);
  }
}

export function sarahSvg(props?: { width?: string; height?: string }): SarahSvg {
  const el = document.createElement('sarah-svg') as SarahSvg;
  if (props?.width) el.setAttribute('width', props.width);
  if (props?.height) el.setAttribute('height', props.height);
  return el;
}
