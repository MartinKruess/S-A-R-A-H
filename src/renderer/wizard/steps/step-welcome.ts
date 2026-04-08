import type { WizardData } from '../wizard.js';

const WELCOME_CSS = `
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: var(--sarah-space-lg);
    max-width: 500px;
  }

  .welcome-avatar {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    border: 2px solid var(--sarah-accent);
    box-shadow: 0 0 30px var(--sarah-glow),
                0 0 60px var(--sarah-glow-subtle);
    background: var(--sarah-bg-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 3rem;
    animation: float 3s ease-in-out infinite;
  }

  .welcome-title {
    font-size: var(--sarah-font-size-xxl);
    font-weight: 300;
    letter-spacing: 0.15em;
    color: var(--sarah-text-primary);
  }

  .welcome-text {
    font-size: var(--sarah-font-size-md);
    color: var(--sarah-text-secondary);
    line-height: 1.6;
    opacity: 0;
    animation: fadeUp 0.6s ease forwards;
    animation-delay: 0.3s;
  }

  .welcome-subtitle {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    letter-spacing: 0.1em;
    opacity: 0;
    animation: fadeUp 0.6s ease forwards;
    animation-delay: 0.6s;
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-8px); }
  }

  @keyframes fadeUp {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

export function createWelcomeStep(_data: WizardData): HTMLElement {
  const container = document.createElement('div');

  // Inject scoped styles
  const style = document.createElement('style');
  style.textContent = WELCOME_CSS;
  container.appendChild(style);

  const welcome = document.createElement('div');
  welcome.className = 'welcome';

  // Avatar placeholder (will be replaced by 3D persona later)
  const avatar = document.createElement('div');
  avatar.className = 'welcome-avatar';
  avatar.textContent = 'S';

  const title = document.createElement('div');
  title.className = 'welcome-title';
  title.textContent = 'S.A.R.A.H.';

  const text = document.createElement('div');
  text.className = 'welcome-text';
  text.textContent = 'Hallo! Ich bin Sarah — dein persönlicher Assistent. Ich helfe dir bei der Einrichtung, damit ich optimal für dich arbeiten kann.';

  const subtitle = document.createElement('div');
  subtitle.className = 'welcome-subtitle';
  subtitle.textContent = 'Smart Assistant for Resource and Administration Handling';

  welcome.appendChild(avatar);
  welcome.appendChild(title);
  welcome.appendChild(text);
  welcome.appendChild(subtitle);
  container.appendChild(welcome);

  return container;
}
