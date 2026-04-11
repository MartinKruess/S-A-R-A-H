import { sarahCard } from '../../components/sarah-card.js';
import type { SarahApi } from '../../../core/sarah-api.js';

function getSarah(): SarahApi {
  return (window as any).__sarah as SarahApi;
}

export async function createHomeView(): Promise<HTMLElement> {
  const container = document.createElement('div');

  const config = await getSarah().getConfig();
  const { profile, resources } = config;

  // Greeting
  const greeting = document.createElement('div');
  greeting.className = 'home-greeting';
  const name = profile.displayName || 'Nutzer';
  greeting.textContent = `Hallo, ${name}!`;
  container.appendChild(greeting);

  const subtitle = document.createElement('div');
  subtitle.className = 'home-subtitle';
  subtitle.textContent = 'Willkommen zurück bei S.A.R.A.H.';
  container.appendChild(subtitle);

  // Summary cards
  const cards = document.createElement('div');
  cards.className = 'home-cards';

  const programCount = Array.isArray(resources.programs) ? resources.programs.length : 0;
  const folderCount = Array.isArray(resources.importantFolders) ? resources.importantFolders.filter((f: string) => f).length : 0;

  cards.appendChild(sarahCard({ icon: '📦', label: 'Programme', value: String(programCount) }));
  cards.appendChild(sarahCard({ icon: '📁', label: 'Ordner', value: String(folderCount) }));
  cards.appendChild(sarahCard({ icon: '🎨', label: 'Akzentfarbe', value: config.personalization?.accentColor || '#00d4ff' }));
  cards.appendChild(sarahCard({ icon: '🔒', label: 'Dateizugriff', value: config.trust?.fileAccess || 'Nicht gesetzt' }));

  container.appendChild(cards);

  return container;
}
