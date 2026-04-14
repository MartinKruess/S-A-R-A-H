import { SarahHexOrb } from './sarahHexOrb';

// --- Type declarations for preload-exposed API ---
interface BootStatus {
  step: 'whisper' | 'router' | 'router-ready' | 'piper' | 'piper-ready';
  message?: string;
}

interface SarahAPI {
  version: string;
  splashDone: () => void;
  bootReady: () => void;
  revealDone: () => void;
  onBootStatus: (cb: (data: BootStatus) => void) => () => void;
  splashTts: (text: string) => Promise<void>;
  voice: {
    onPlayAudio: (cb: (data: { audio: number[]; sampleRate: number }) => void) => () => void;
    playbackDone: () => Promise<void>;
  };
}

declare var sarah: SarahAPI;

// ============================================================
// Three.js HexOrb
// ============================================================
const orbContainer = document.getElementById('orb')!;
const orb = new SarahHexOrb(orbContainer);

// Start orb small, dimmed, and shifted down
const ORB_START_SCALE = 0.4;
const ORB_START_LIGHT = 0.1;
const ORB_START_Y = -0.35;
orb.setOrbScale(ORB_START_SCALE);
orb.setLightIntensity(ORB_START_LIGHT);
orb.setOrbOffset(0, ORB_START_Y, 0);

// ============================================================
// Boot sequence state
// ============================================================
const statusEl = document.getElementById('boot-status')!;
const bubbleEl = document.getElementById('splash-bubble')!;

let routerReady = false;
let piperReady = false;
let breakTriggered = false;
let ttsTriggered = false;
let dotInterval: ReturnType<typeof setInterval> | null = null;

function showStatus(message: string, animated = false): void {
  statusEl.classList.remove('visible');
  if (dotInterval) {
    clearInterval(dotInterval);
    dotInterval = null;
  }

  setTimeout(() => {
    if (animated) {
      const base = message.replace(/\s*\.{3}\s*$/, '').replace(/\s*\.\.\.\s*$/, '');
      let dotCount = 0;
      const updateDots = () => {
        const dots = '.'.repeat(dotCount % 4);
        statusEl.textContent = dots.length > 0 ? `${base} ${dots}` : base;
        dotCount++;
      };
      updateDots();
      dotInterval = setInterval(updateDots, 500);
    } else {
      statusEl.textContent = message;
    }
    statusEl.classList.add('visible');
  }, 150);
}

function hideStatus(): void {
  statusEl.classList.remove('visible');
  if (dotInterval) {
    clearInterval(dotInterval);
    dotInterval = null;
  }
}

function showBubble(text: string): void {
  bubbleEl.textContent = text;
  bubbleEl.classList.add('visible');
}

function hideBubble(): void {
  bubbleEl.classList.remove('visible');
}

// ============================================================
// 2D Canvas for particles/streak (overlay)
// ============================================================
const canvas2d = document.getElementById('splash-canvas') as HTMLCanvasElement;
const ctx = canvas2d.getContext('2d')!;

function resizeCanvas(): void {
  canvas2d.width = window.innerWidth;
  canvas2d.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

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
  const w = canvas2d.width;
  const h = canvas2d.height;
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
    ctx.lineCap = 'round';
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
      color: 'rgba(255, 245, 230, 1)',
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
const title = document.getElementById('splash-title')!;
const subtitle = document.getElementById('splash-subtitle')!;

type Phase = 'fade-in' | 'streak' | 'streak-fade' | 'pause' | 'dissolve'
  | 'boot-wait' | 'boot-reveal' | 'boot-bubble'
  | 'boot-piper-wait' | 'boot-break' | 'done';

let phase: Phase = 'fade-in';
let phaseStart = 0;
let streakProgress = 0;

function startPhase(newPhase: Phase): void {
  phase = newPhase;
  phaseStart = performance.now();
}

function elapsed(): number {
  return performance.now() - phaseStart;
}

// ============================================================
// Audio playback for splash TTS
// ============================================================
let audioContext: AudioContext | null = null;

function playTtsAudio(audioData: number[], sampleRate: number): Promise<void> {
  return new Promise((resolve) => {
    if (!audioContext) audioContext = new AudioContext({ sampleRate });
    const buffer = audioContext.createBuffer(1, audioData.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < audioData.length; i++) {
      channel[i] = audioData[i]!;
    }
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => {
      sarah.voice.playbackDone();
      resolve();
    };
    source.start();
  });
}

let ttsAudioResolve: (() => void) | null = null;

sarah.voice.onPlayAudio(({ audio, sampleRate }) => {
  playTtsAudio(audio, sampleRate).then(() => {
    if (ttsAudioResolve) {
      ttsAudioResolve();
      ttsAudioResolve = null;
    }
  });
});

// ============================================================
// Boot status IPC listener
// ============================================================
sarah.onBootStatus((data) => {
  switch (data.step) {
    case 'whisper':
    case 'router':
    case 'piper':
      if (data.message) showStatus(data.message, true);
      break;
    case 'router-ready':
      routerReady = true;
      hideStatus();
      break;
    case 'piper-ready':
      piperReady = true;
      hideStatus();
      break;
  }
});

function tick(now: number): void {
  // 2D overlay
  ctx.clearRect(0, 0, canvas2d.width, canvas2d.height);

  switch (phase) {
    case 'fade-in': {
      const t = elapsed();
      if (t > 600) {
        title.classList.add('visible');
      }
      if (t > 900) {
        subtitle.classList.add('visible');
      }
      if (t > 3500) {
        startPhase('streak');
      }
      break;
    }

    case 'streak': {
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
        startPhase('streak-fade');
      }
      break;
    }

    case 'streak-fade': {
      const hasTrail = fadeOutTrail();
      drawTrail();
      if (!hasTrail) {
        startPhase('pause');
      }
      break;
    }

    case 'pause': {
      if (elapsed() > 1500) {
        spawnParticlesFromElement(title);
        spawnParticlesFromElement(subtitle);
        spawnParticlesFromTrail();

        title.style.transition = 'opacity 0.3s';
        subtitle.style.transition = 'opacity 0.3s';
        title.style.opacity = '0';
        subtitle.style.opacity = '0';

        startPhase('dissolve');
      }
      break;
    }

    case 'dissolve': {
      const alive = updateAndDrawParticles();
      if (!alive) {
        sarah.bootReady();
        startPhase('boot-wait');
      }
      break;
    }

    case 'boot-wait': {
      if (routerReady) {
        startPhase('boot-reveal');
      }
      break;
    }

    case 'boot-reveal': {
      const t = elapsed();

      if (t < 1400) {
        const p = t / 1400;
        const cx = canvas2d.width / 2;
        const cy = canvas2d.height * 0.52;
        const glowR = canvas2d.height * 0.35;
        const pulse = Math.sin(p * Math.PI);
        const glowAlpha = pulse * 0.18;

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
        grad.addColorStop(0, `rgba(212, 175, 55, ${glowAlpha})`);
        grad.addColorStop(0.5, `rgba(212, 175, 55, ${glowAlpha * 0.3})`);
        grad.addColorStop(1, 'rgba(212, 175, 55, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas2d.width, canvas2d.height);

        const lightP = p * 0.15;
        orb.setLightIntensity(ORB_START_LIGHT + lightP);
      } else {
        const revealT = t - 1400;
        const REVEAL_MS = 3500;
        const p = Math.min(revealT / REVEAL_MS, 1);
        const eased = 1 - Math.pow(1 - p, 4);

        const scale = ORB_START_SCALE + (1.0 - ORB_START_SCALE) * eased;
        orb.setOrbScale(scale);

        const yOffset = ORB_START_Y * (1 - eased);
        orb.setOrbOffset(0, yOffset, 0);

        const lightBase = ORB_START_LIGHT + 0.15;
        const light = lightBase + (1.0 - lightBase) * eased;
        orb.setLightIntensity(light);

        if (p >= 1) {
          sarah.revealDone();
          startPhase('boot-bubble');
        }
      }
      break;
    }

    case 'boot-bubble': {
      const t = elapsed();
      if (t < 100) {
        showBubble('Willkommen!');
      }
      if (t > 2000) {
        hideBubble();
        startPhase('boot-piper-wait');
      }
      break;
    }

    case 'boot-piper-wait': {
      if (piperReady) {
        startPhase('boot-break');
      }
      break;
    }

    case 'boot-break': {
      const t = elapsed();
      if (t >= 0 && !breakTriggered) {
        breakTriggered = true;
        orb.triggerBreak(3000);
      }
      if (t >= 200 && !ttsTriggered) {
        ttsTriggered = true;
        sarah.splashTts('Huch, jetzt bin ich einsatzbereit!');
        ttsAudioResolve = () => {
          startPhase('done');
        };
      }
      if (t > 6000 && phase === 'boot-break') {
        startPhase('done');
      }
      break;
    }

    case 'done': {
      sarah.splashDone();
      return;
    }
  }

  requestAnimationFrame(tick);
}

// --- Start ---
requestAnimationFrame(tick);
