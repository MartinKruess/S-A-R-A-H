import { sarahTabs } from '../components/sarah-tabs.js';

export interface SettingsSubtab {
  id: string;
  label: string;
  content: HTMLElement;
}

/** Builds a compact second-level tab group inside one settings page. */
export function createSettingsSubtabs(tabs: SettingsSubtab[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'settings-subtabs';

  const panels = new Map<string, HTMLElement>();
  const initialId = tabs[0]?.id;
  const tabStrip = sarahTabs({
    tabs: tabs.map(({ id, label }) => ({ id, label })),
    activeId: initialId,
    onChange: (id) => {
      for (const [panelId, panel] of panels) panel.hidden = panelId !== id;
    },
  });
  tabStrip.classList.add('settings-subtabs-strip');
  root.appendChild(tabStrip);

  const panelRoot = document.createElement('div');
  panelRoot.className = 'settings-subtabs-panels';
  for (const tab of tabs) {
    tab.content.classList.add('settings-subtab-panel');
    tab.content.hidden = tab.id !== initialId;
    tab.content.setAttribute('role', 'tabpanel');
    tab.content.setAttribute('aria-label', tab.label);
    panels.set(tab.id, tab.content);
    panelRoot.appendChild(tab.content);
  }
  root.appendChild(panelRoot);

  return root;
}
