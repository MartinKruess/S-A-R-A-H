import { sarahTabs, type TabItem } from '../../components/sarah-tabs.js';
import { getSarah } from '../../shared/settings-utils.js';
import { resolveInitialTabId } from '../../components/sarah-tabs-logic.js';
import { createProfileSection } from './sections/profile-section.js';
import { createFilesSection } from './sections/files-section.js';
import { createTrustSection } from './sections/trust-section.js';
import { createPersonalizationSection } from './sections/personalization-section.js';
import { createControlsSection } from './sections/controls-section.js';
import { createAudioSection } from './sections/audio-section.js';
import type { SarahConfig } from '../../../core/config-schema.js';

type TabId = 'profile' | 'personal' | 'management' | 'control' | 'security';

const TABS: TabItem[] = [
  { id: 'profile',    label: 'Profil' },
  { id: 'personal',   label: 'Persönliche Einstellungen' },
  { id: 'management', label: 'Verwaltung' },
  { id: 'control',    label: 'Bedienung' },
  { id: 'security',   label: 'Sicherheit' },
];

const VALID_IDS = TABS.map(t => t.id);

function buildPanelContent(id: TabId, config: SarahConfig): HTMLElement[] {
  switch (id) {
    case 'profile':    return [createProfileSection(config)];
    case 'personal':   return [createPersonalizationSection(config), createAudioSection(config)];
    case 'management': return [createFilesSection(config)];
    case 'control':    return [createControlsSection(config)];
    case 'security':   return [createTrustSection(config)];
  }
}

export async function createSettingsView(): Promise<HTMLElement> {
  const container = document.createElement('div');

  const pageTitle = document.createElement('div');
  pageTitle.className = 'home-greeting settings-page-title';
  pageTitle.textContent = 'Einstellungen';
  container.appendChild(pageTitle);

  const config = await getSarah().getConfig();

  // Tab-Strip
  const initialId = resolveInitialTabId(location.hash, 'profile', VALID_IDS) as TabId;
  const tabStripWrapper = document.createElement('div');
  tabStripWrapper.className = 'settings-tabs-wrapper';
  const tabStrip = sarahTabs({
    tabs: TABS,
    activeId: initialId,
    onChange: (id) => showPanel(id as TabId),
  });
  tabStripWrapper.appendChild(tabStrip);
  container.appendChild(tabStripWrapper);

  // Panels — alle einmal rendern, inaktive verstecken
  const panelContainer = document.createElement('div');
  const panels: Record<TabId, HTMLElement> = {} as Record<TabId, HTMLElement>;
  for (const tab of TABS) {
    const panel = document.createElement('div');
    panel.id = `panel-${tab.id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `tab-${tab.id}`);
    for (const section of buildPanelContent(tab.id as TabId, config)) {
      panel.appendChild(section);
    }
    if (tab.id !== initialId) panel.hidden = true;
    panelContainer.appendChild(panel);
    panels[tab.id as TabId] = panel;
  }
  container.appendChild(panelContainer);

  // Footer-Link
  const footerLink = document.createElement('a');
  footerLink.className = 'settings-footer-link';
  footerLink.href = 'wizard.html';
  footerLink.textContent = 'Einrichtung erneut durchführen';
  container.appendChild(footerLink);

  // Tab-Switching
  let currentId: TabId = initialId;
  function showPanel(id: TabId, updateHash = true): void {
    if (id === currentId) return;
    panels[currentId].hidden = true;
    panels[id].hidden = false;
    currentId = id;
    if (updateHash) {
      const url = `${location.pathname}${location.search}#${id}`;
      history.replaceState(null, '', url);
    }
  }

  // Hash-Sync für Browser-Back/Forward
  window.addEventListener('hashchange', () => {
    const id = resolveInitialTabId(location.hash, 'profile', VALID_IDS) as TabId;
    if (id !== currentId) {
      tabStrip.setActiveId(id);
      showPanel(id, false);
    }
  });

  return container;
}
