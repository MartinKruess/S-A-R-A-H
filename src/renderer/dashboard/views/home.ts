import { getSarah } from '../../shared/window-global.js';

export async function createHomeView(): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.className = 'cockpit';

  const config = await getSarah().getConfig();
  const name = config.profile.displayName || 'Nutzer';

  root.appendChild(buildBanner(name));
  root.appendChild(buildColumn('cockpit-left', 2));
  root.appendChild(buildHero());
  root.appendChild(buildColumn('cockpit-right', 2));

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

  // Update clock every second. Detach listener when banner is removed from DOM.
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

function buildColumn(className: string, count: number): HTMLElement {
  const column = document.createElement('div');
  column.className = className;
  for (let i = 0; i < count; i++) {
    const stub = document.createElement('div');
    stub.className = 'cockpit-panel-stub';
    column.appendChild(stub);
  }
  return column;
}

function buildHero(): HTMLElement {
  const hero = document.createElement('div');
  hero.className = 'cockpit-hero';
  hero.textContent = 'Demnächst';
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
  // "Dienstag, 24. Apr." + "  " + "11:52" → upper-cased
  const datePart = dateFmt.format(now).replace('.', '');
  const timePart = timeFmt.format(now);
  return `${datePart}  ${timePart}`.toUpperCase();
}
