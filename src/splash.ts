export {};

// --- Type declarations for preload-exposed API ---
interface SarahAPI {
  version: string;
  splashDone: () => void;
}

declare global {
  interface Window {
    sarah: SarahAPI;
  }
}

// ============================================================
// Canvas setup
// ============================================================
const canvas = document.getElementById("splash-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function resizeCanvas(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// ============================================================
// Bezier path utility
// ============================================================
function quadraticBezier(
  t: number,
  p0: [number, number],
  p1: [number, number],
  p2: [number, number]
): [number, number] {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

function getStreakPath(): {
  start: [number, number];
  control: [number, number];
  end: [number, number];
} {
  const w = canvas.width;
  const h = canvas.height;
  const centerY = h * 0.52;
  const arcDepth = h * 0.10;

  return {
    start: [w * 0.15, centerY],
    control: [w * 0.4, centerY + arcDepth],
    end: [w * 0.65, centerY],
  };
}

// ============================================================
// Light streak
// ============================================================
interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

const STREAK_DURATION = 2500;
const TRAIL_MAX_AGE = 35;
const trail: TrailPoint[] = [];

function drawStreakHead(x: number, y: number): void {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 30);
  glow.addColorStop(0, "rgba(255, 248, 235, 0.9)");
  glow.addColorStop(0.3, "rgba(255, 240, 220, 0.4)");
  glow.addColorStop(1, "rgba(255, 240, 220, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, 30, 0, Math.PI * 2);
  ctx.fill();

  const core = ctx.createRadialGradient(x, y, 0, x, y, 6);
  core.addColorStop(0, "rgba(255, 255, 255, 1)");
  core.addColorStop(1, "rgba(255, 248, 235, 0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
}

function drawTrail(): void {
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
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(curr.x, curr.y);
    ctx.stroke();
  }
}

function updateTrail(x: number, y: number): void {
  trail.unshift({ x, y, age: 0 });
  for (let i = 0; i < trail.length; i++) {
    trail[i]!.age++;
  }
  while (trail.length > TRAIL_MAX_AGE) {
    trail.pop();
  }
}

function fadeOutTrail(): boolean {
  for (let i = 0; i < trail.length; i++) {
    trail[i]!.age += 2;
  }
  while (trail.length > 0 && trail[trail.length - 1]!.age > TRAIL_MAX_AGE) {
    trail.pop();
  }
  return trail.length > 0;
}

// ============================================================
// Particle system
// ============================================================
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  decay: number;
  size: number;
  color: string;
}

const particles: Particle[] = [];

function spawnParticlesFromElement(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const count = Math.floor(rect.width * rect.height / 120);
  const style = window.getComputedStyle(el);
  const color = style.color;

  for (let i = 0; i < count; i++) {
    const x = rect.left + Math.random() * rect.width;
    const y = rect.top + Math.random() * rect.height;
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.5 + Math.random() * 2.5;

    particles.push({
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

function spawnParticlesFromTrail(): void {
  for (const point of trail) {
    if (Math.random() > 0.5) continue;
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.3 + Math.random() * 1.5;
    particles.push({
      x: point.x,
      y: point.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      decay: 0.01 + Math.random() * 0.015,
      size: 1 + Math.random() * 2,
      color: "rgba(255, 245, 230, 1)",
    });
  }
}

function updateAndDrawParticles(): boolean {
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

// ============================================================
// Animation timeline
// ============================================================
const title = document.getElementById("splash-title")!;
const subtitle = document.getElementById("splash-subtitle")!;

type Phase = "fade-in" | "streak" | "streak-fade" | "pause" | "dissolve" | "done";

let phase: Phase = "fade-in";
let phaseStart = 0;
let streakProgress = 0;

function startPhase(newPhase: Phase): void {
  phase = newPhase;
  phaseStart = performance.now();
}

function elapsed(): number {
  return performance.now() - phaseStart;
}

function tick(now: number): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  switch (phase) {
    case "fade-in": {
      const t = elapsed();
      if (t < 50) {
        title.classList.add("visible");
      }
      if (t > 300) {
        subtitle.classList.add("visible");
      }
      if (t > 1000) {
        startPhase("streak");
      }
      break;
    }

    case "streak": {
      const t = elapsed();
      streakProgress = Math.min(t / STREAK_DURATION, 1);
      const eased = streakProgress < 0.5
        ? 2 * streakProgress * streakProgress
        : 1 - Math.pow(-2 * streakProgress + 2, 2) / 2;

      const path = getStreakPath();
      const [x, y] = quadraticBezier(eased, path.start, path.control, path.end);
      updateTrail(x, y);
      drawTrail();
      drawStreakHead(x, y);

      if (streakProgress >= 1) {
        startPhase("streak-fade");
      }
      break;
    }

    case "streak-fade": {
      const hasTrail = fadeOutTrail();
      drawTrail();
      if (!hasTrail) {
        startPhase("pause");
      }
      break;
    }

    case "pause": {
      if (elapsed() > 500) {
        spawnParticlesFromElement(title);
        spawnParticlesFromElement(subtitle);
        spawnParticlesFromTrail();

        title.style.transition = "opacity 0.3s";
        subtitle.style.transition = "opacity 0.3s";
        title.style.opacity = "0";
        subtitle.style.opacity = "0";

        startPhase("dissolve");
      }
      break;
    }

    case "dissolve": {
      const alive = updateAndDrawParticles();
      if (!alive) {
        startPhase("done");
      }
      break;
    }

    case "done": {
      window.sarah.splashDone();
      return;
    }
  }

  requestAnimationFrame(tick);
}

// --- Start ---
requestAnimationFrame(tick);
