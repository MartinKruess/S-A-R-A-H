import { sarahPanel } from '../../components/index.js';
import { getSarah } from '../../shared/window-global.js';
import { createSystemLoadBody } from './system-load.js';

export async function createHomeView(): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.className = 'cockpit';

  const config = await getSarah().getConfig();
  const name = config.profile.displayName || 'Nutzer';

  root.appendChild(buildBanner(name));
  root.appendChild(buildLeftColumn());
  root.appendChild(buildHero());
  root.appendChild(buildRightColumn());

  return root;
}

function buildBanner(name: string): HTMLElement {
  const banner = document.createElement('div');
  banner.className = 'cockpit-banner';

  const greeting = document.createElement('div');
  greeting.className = 'cockpit-greeting';
  greeting.textContent = `Willkommen, ${name}`;

  const clock = document.createElement('div');
  clock.className = 'cockpit-clock';
  clock.textContent = formatClock();

  const intervalId = window.setInterval(() => {
    if (!clock.isConnected) {
      window.clearInterval(intervalId);
      return;
    }
    clock.textContent = formatClock();
  }, 1000);

  banner.appendChild(greeting);
  banner.appendChild(clock);
  return banner;
}

function buildLeftColumn(): HTMLElement {
  const column = document.createElement('div');
  column.className = 'cockpit-left';

  const systemLoad = createSystemLoadBody();
  // `systemLoad.dispose` is intentionally not auto-wired: the dashboard view
  // lives for the lifetime of its window. Exposed on the element for future
  // lifecycle hooks.
  (systemLoad.el as HTMLElement & { __dispose?: () => void }).__dispose = systemLoad.dispose;

  column.appendChild(sarahPanel({
    title: 'SYSTEM LOAD',
    accent: 'cyan',
    children: [systemLoad.el],
  }));

  column.appendChild(sarahPanel({
    title: 'VOICE I/O',
    accent: 'mint',
    children: ['IN · OUT'],
  }));

  return column;
}

function buildRightColumn(): HTMLElement {
  const column = document.createElement('div');
  column.className = 'cockpit-right';

  column.appendChild(sarahPanel({
    title: 'TERMINE',
    accent: 'violet',
    children: ['Heute · Diese Woche'],
  }));

  column.appendChild(sarahPanel({
    title: 'WETTER & MEDIA',
    accent: 'pink',
    children: ['—'],
  }));

  return column;
}

function buildHero(): HTMLElement {
  const hero = document.createElement('div');
  hero.className = 'cockpit-hero';

  const stage = document.createElement('div');
  stage.className = 'cockpit-hero-stage';

  const grid = document.createElement('div');
  grid.className = 'cockpit-hero-grid';

  const halo = document.createElement('div');
  halo.className = 'cockpit-hero-halo';

  const planet = document.createElement('div');
  planet.className = 'cockpit-hero-planet';

  stage.appendChild(grid);
  stage.appendChild(halo);
  stage.appendChild(planet);

  const caption = document.createElement('div');
  caption.className = 'cockpit-hero-caption';
  caption.textContent = 'S.A.R.A.H. · CORE ONLINE';

  hero.appendChild(stage);
  hero.appendChild(caption);
  return hero;
}

function formatClock(): string {
  const now = new Date();
  const dateFmt = new Intl.DateTimeFormat('de-DE', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
  });
  const timeFmt = new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const datePart = dateFmt.format(now).replace('.', '');
  const timePart = timeFmt.format(now);
  return `${datePart}  ${timePart}`.toUpperCase();
}
