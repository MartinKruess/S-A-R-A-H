import { sarahButton } from '../../components/sarah-button.js';
import { getSarah } from '../../shared/settings-utils.js';
import { createProfileSection } from './sections/profile-section.js';
import { createFilesSection } from './sections/files-section.js';
import { createTrustSection } from './sections/trust-section.js';
import { createPersonalizationSection } from './sections/personalization-section.js';
import { createControlsSection } from './sections/controls-section.js';

export async function createSettingsView(): Promise<HTMLElement> {
  const container = document.createElement('div');

  const pageTitle = document.createElement('div');
  pageTitle.className = 'home-greeting';
  pageTitle.style.marginBottom = 'var(--sarah-space-xl)';
  pageTitle.textContent = 'Einstellungen';
  container.appendChild(pageTitle);

  const config = await getSarah().getConfig();

  container.appendChild(createProfileSection(config));
  container.appendChild(createFilesSection(config));
  container.appendChild(createTrustSection(config));
  container.appendChild(createPersonalizationSection(config));
  container.appendChild(createControlsSection(config));

  // Wizard re-run button
  const wizardSection = document.createElement('div');
  wizardSection.className = 'settings-section';
  wizardSection.appendChild(sarahButton({
    label: 'Einrichtung erneut durchführen',
    variant: 'secondary',
    onClick: () => { window.location.href = 'wizard.html'; },
  }));
  container.appendChild(wizardSection);

  return container;
}
