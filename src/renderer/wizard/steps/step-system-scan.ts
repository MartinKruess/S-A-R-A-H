import type { WizardData } from '../wizard.js';
import { sarahCard } from '../../components/sarah-card.js';
import { sarahProgress } from '../../components/sarah-progress.js';

function getSarah(): { getSystemInfo: () => Promise<Record<string, string>> } {
  return (window as any).__sarah;
}

const SCAN_CSS = `
  .scan {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sarah-space-lg);
    width: 100%;
    max-width: 600px;
  }

  .scan-title {
    font-size: var(--sarah-font-size-xl);
    font-weight: 300;
    color: var(--sarah-text-primary);
    letter-spacing: 0.05em;
  }

  .scan-subtitle {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-secondary);
  }

  .scan-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sarah-space-md);
    width: 100%;
  }

  .scan-grid sarah-card {
    opacity: 0;
    transform: translateY(8px);
    animation: cardIn 0.4s ease forwards;
  }

  @keyframes cardIn {
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

const SYSTEM_LABELS: Record<string, { label: string; icon: string }> = {
  os: { label: 'Betriebssystem', icon: '💻' },
  cpu: { label: 'Prozessor', icon: '⚡' },
  cpuCores: { label: 'CPU Kerne', icon: '🧮' },
  totalMemory: { label: 'Arbeitsspeicher', icon: '🧠' },
  hostname: { label: 'Hostname', icon: '🏷️' },
  shell: { label: 'Shell', icon: '⌨️' },
  arch: { label: 'Architektur', icon: '🔧' },
  freeMemory: { label: 'Freier RAM', icon: '📊' },
};

export function createSystemScanStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = SCAN_CSS;
  container.appendChild(style);

  const scan = document.createElement('div');
  scan.className = 'scan';

  const title = document.createElement('div');
  title.className = 'scan-title';
  title.textContent = 'System-Scan';

  const subtitle = document.createElement('div');
  subtitle.className = 'scan-subtitle';
  subtitle.textContent = 'Ich analysiere dein System...';

  const progress = sarahProgress({ label: 'Scanning...' });

  const grid = document.createElement('div');
  grid.className = 'scan-grid';

  scan.appendChild(title);
  scan.appendChild(subtitle);
  scan.appendChild(progress);
  scan.appendChild(grid);
  container.appendChild(scan);

  runScan(data, progress, grid, subtitle);

  return container;
}

async function runScan(
  data: WizardData,
  progress: HTMLElement & { setProgress: (n: number) => void },
  grid: HTMLElement,
  subtitle: HTMLElement,
): Promise<void> {
  progress.setProgress(20);

  const info = await getSarah().getSystemInfo();
  data.system = info;

  progress.setProgress(60);

  const entries = Object.entries(info);
  let shown = 0;

  for (const [key, value] of entries) {
    const meta = SYSTEM_LABELS[key];
    if (!meta) continue;

    await delay(150);
    const card = sarahCard({ label: meta.label, value: String(value), icon: meta.icon });
    card.style.animationDelay = `${shown * 0.1}s`;
    grid.appendChild(card);
    shown++;
    progress.setProgress(60 + (shown / entries.length) * 40);
  }

  subtitle.textContent = 'Scan abgeschlossen!';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
