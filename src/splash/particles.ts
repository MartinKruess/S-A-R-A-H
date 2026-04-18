import type { TrailPoint } from './streak.js';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  decay: number;
  size: number;
  color: string;
}

export class Particles {
  readonly particles: Particle[] = [];

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  spawnFromElement(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const count = Math.floor(rect.width * rect.height / 120);
    const style = window.getComputedStyle(el);
    const color = style.color;

    for (let i = 0; i < count; i++) {
      const x = rect.left + Math.random() * rect.width;
      const y = rect.top + Math.random() * rect.height;
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 2.5;

      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.0,
        decay: 0.008 + Math.random() * 0.012,
        size: 1 + Math.random() * 2.5,
        color,
      });
    }
  }

  spawnFromTrail(trail: TrailPoint[]): void {
    for (const point of trail) {
      if (Math.random() > 0.5) continue;
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.3 + Math.random() * 1.5;
      this.particles.push({
        x: point.x,
        y: point.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.0,
        decay: 0.01 + Math.random() * 0.015,
        size: 1 + Math.random() * 2,
        color: 'rgba(255, 245, 230, 1)',
      });
    }
  }

  updateAndDraw(): boolean {
    const { ctx, particles } = this;
    let alive = false;
    for (const p of particles) {
      if (p.life <= 0) continue;
      alive = true;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;
      p.vx *= 0.995;
      p.vy *= 0.995;

      const alpha = Math.max(0, p.life);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return alive;
  }
}
