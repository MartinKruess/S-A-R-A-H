import { registerComponents } from '../components/index.js';
import { applyAccentColor } from '../shared/accent.js';
import { createHomeView } from './views/home.js';
import { createSettingsView } from './views/settings.js';

import type { SarahApi } from '../../core/sarah-api.js';

declare const sarah: SarahApi;

(window as any).__sarah = sarah;

registerComponents();

// Apply saved accent color
sarah.getConfig().then((config) => {
  const color = config.personalization?.accentColor;
  if (color && color !== '#00d4ff') {
    applyAccentColor(color);
  }
});

type DialogView = 'dashboard' | 'settings';

const viewFactories: Record<DialogView, () => Promise<HTMLElement>> = {
  dashboard: createHomeView,
  settings: createSettingsView,
};

async function mount(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') as DialogView | null;

  if (!view || !viewFactories[view]) return;

  document.title = view === 'settings' ? 'S.A.R.A.H. — Einstellungen' : 'S.A.R.A.H. — Dashboard';

  const container = document.getElementById('dialog-content')!;
  const el = await viewFactories[view]();
  container.appendChild(el);
}

mount();
