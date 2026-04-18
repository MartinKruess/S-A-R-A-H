import { sarahPanel } from '../../components/index.js';
import { getSarah } from '../../shared/window-global.js';
import { createSystemLoadBody } from './system-load.js';
import { createVoiceIoBody } from './voice-io.js';

export async function createHomeView(): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.className = 'cockpit';

  const config = await getSarah().getConfig();
  const name = config.profile.displayName || 'Nutzer';

  root.appendChild(buildBanner(name));
  root.appendChild(buildSysLoadPanel());
  root.appendChild(buildVoiceIoPanel());
  root.appendChild(buildHero());
  root.appendChild(buildTerminePanel());
  root.appendChild(buildWetterPanel());
  root.appendChild(buildMediaPanel());

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

function buildSysLoadPanel(): HTMLElement {
  const systemLoad = createSystemLoadBody();
  (systemLoad.el as HTMLElement & { __dispose?: () => void }).__dispose = systemLoad.dispose;
  const panel = sarahPanel({
    title: 'SYSTEM LOAD',
    accent: 'cyan',
    children: [systemLoad.el],
  });
  panel.classList.add('cockpit-sysload');
  return panel;
}

function buildVoiceIoPanel(): HTMLElement {
  const voiceIo = createVoiceIoBody();
  (voiceIo.el as HTMLElement & { __dispose?: () => void }).__dispose = voiceIo.dispose;
  const panel = sarahPanel({
    title: 'VOICE I/O',
    accent: 'mint',
    children: [voiceIo.el],
  });
  panel.classList.add('cockpit-voiceio');
  return panel;
}

function buildTerminePanel(): HTMLElement {
  const panel = sarahPanel({
    title: 'TERMINE',
    accent: 'violet',
    children: ['Heute · Diese Woche'],
  });
  panel.classList.add('cockpit-termine');
  return panel;
}

function buildWetterPanel(): HTMLElement {
  const panel = sarahPanel({
    title: 'WETTER',
    accent: 'pink',
    children: ['—'],
  });
  panel.classList.add('cockpit-wetter');
  return panel;
}

function buildMediaPanel(): HTMLElement {
  const panel = sarahPanel({
    title: 'MEDIA',
    accent: 'cyan',
    children: ['—'],
  });
  panel.classList.add('cockpit-media');
  return panel;
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
