import type { SplashCanvas } from './canvas.js';
import { getStreakPath, quadraticBezier } from './bezier.js';
import { Streak, STREAK_DURATION } from './streak.js';
import { Particles } from './particles.js';

type Phase = 'fade-in' | 'streak' | 'streak-fade' | 'pause' | 'dissolve' | 'done';

export interface TimelineTargets {
  title: HTMLElement;
  subtitle: HTMLElement;
}

export function runTimeline(
  canvas: SplashCanvas,
  targets: TimelineTargets,
  onDone: () => void,
): void {
  const { el, ctx } = canvas;
  const { title, subtitle } = targets;
  const streak = new Streak(ctx);
  const particles = new Particles(ctx);

  let phase: Phase = 'fade-in';
  let phaseStart = performance.now();
  let streakProgress = 0;

  const startPhase = (next: Phase): void => {
    phase = next;
    phaseStart = performance.now();
  };
  const elapsed = (): number => performance.now() - phaseStart;

  const tick = (): void => {
    ctx.clearRect(0, 0, el.width, el.height);

    switch (phase) {
      case 'fade-in': {
        const t = elapsed();
        if (t > 600) title.classList.add('visible');
        if (t > 900) subtitle.classList.add('visible');
        if (t > 3500) startPhase('streak');
        break;
      }

      case 'streak': {
        const t = elapsed();
        streakProgress = Math.min(t / STREAK_DURATION, 1);
        const eased = streakProgress < 0.5
          ? 2 * streakProgress * streakProgress
          : 1 - Math.pow(-2 * streakProgress + 2, 2) / 2;

        const path = getStreakPath(el);
        const [x, y] = quadraticBezier(eased, path.start, path.control, path.end);
        streak.updateTrail(x, y);
        streak.drawTrail();
        streak.drawHead(x, y);

        if (streakProgress >= 1) startPhase('streak-fade');
        break;
      }

      case 'streak-fade': {
        const hasTrail = streak.fadeOutTrail();
        streak.drawTrail();
        if (!hasTrail) startPhase('pause');
        break;
      }

      case 'pause': {
        if (elapsed() > 1500) {
          particles.spawnFromElement(title);
          particles.spawnFromElement(subtitle);
          particles.spawnFromTrail(streak.trail);

          title.style.transition = 'opacity 0.3s';
          subtitle.style.transition = 'opacity 0.3s';
          title.style.opacity = '0';
          subtitle.style.opacity = '0';

          startPhase('dissolve');
        }
        break;
      }

      case 'dissolve': {
        if (!particles.updateAndDraw()) startPhase('done');
        break;
      }

      case 'done': {
        onDone();
        return;
      }
    }

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}
