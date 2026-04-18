export interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

export const STREAK_DURATION = 2500;
export const TRAIL_MAX_AGE = 35;

export class Streak {
  readonly trail: TrailPoint[] = [];

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  drawHead(x: number, y: number): void {
    const { ctx } = this;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 30);
    glow.addColorStop(0, 'rgba(255, 248, 235, 0.9)');
    glow.addColorStop(0.3, 'rgba(255, 240, 220, 0.4)');
    glow.addColorStop(1, 'rgba(255, 240, 220, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 30, 0, Math.PI * 2);
    ctx.fill();

    const core = ctx.createRadialGradient(x, y, 0, x, y, 6);
    core.addColorStop(0, 'rgba(255, 255, 255, 1)');
    core.addColorStop(1, 'rgba(255, 248, 235, 0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  drawTrail(): void {
    const { ctx, trail } = this;
    if (trail.length < 2) return;
    for (let i = 1; i < trail.length; i++) {
      const prev = trail[i - 1]!;
      const curr = trail[i]!;
      const life = 1 - curr.age / TRAIL_MAX_AGE;
      if (life <= 0) continue;
      const alpha = life * life * 0.6;
      const width = life * 4;
      ctx.strokeStyle = `rgba(255, 245, 230, ${alpha})`;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(curr.x, curr.y);
      ctx.stroke();
    }
  }

  updateTrail(x: number, y: number): void {
    const { trail } = this;
    trail.unshift({ x, y, age: 0 });
    for (let i = 0; i < trail.length; i++) {
      trail[i]!.age++;
    }
    while (trail.length > TRAIL_MAX_AGE) {
      trail.pop();
    }
  }

  fadeOutTrail(): boolean {
    const { trail } = this;
    for (let i = 0; i < trail.length; i++) {
      trail[i]!.age += 2;
    }
    while (trail.length > 0 && trail[trail.length - 1]!.age > TRAIL_MAX_AGE) {
      trail.pop();
    }
    return trail.length > 0;
  }
}
