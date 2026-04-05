import { registerComponents } from '../components/index.js';
import { sarahStepper } from '../components/sarah-stepper.js';
import { sarahButton } from '../components/sarah-button.js';
import { createWelcomeStep } from './steps/step-welcome.js';
import { createSystemScanStep } from './steps/step-system-scan.js';
import { createProfileStep } from './steps/step-profile.js';
import { createPersonalizationStep } from './steps/step-personalization.js';
import { createFinishStep } from './steps/step-finish.js';

// Type declarations for preload bridge
declare const sarah: {
  version: string;
  splashDone: () => void;
  getSystemInfo: () => Promise<Record<string, string>>;
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  isFirstRun: () => Promise<boolean>;
};

// Make sarah available to step modules
(window as any).__sarah = sarah;

// Register all Web Components
registerComponents();

// Wizard state
export interface WizardData {
  system: Record<string, string>;
  profile: {
    displayName: string;
    city: string;
    language: string;
    timezone: string;
  };
  personalization: {
    accentColor: string;
    voice: string;
    speechRate: number;
  };
}

const wizardData: WizardData = {
  system: {},
  profile: {
    displayName: '',
    city: '',
    language: 'de',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  personalization: {
    accentColor: '#00d4ff',
    voice: 'default-female-de',
    speechRate: 1.0,
  },
};

const STEPS = [
  { id: 'welcome', label: 'Willkommen' },
  { id: 'system', label: 'System-Scan' },
  { id: 'profile', label: 'Profil' },
  { id: 'personalization', label: 'Personalisierung' },
  { id: 'finish', label: 'Fertig' },
];

let currentStep = 0;

// DOM references
const sidebar = document.getElementById('sidebar')!;
const slideArea = document.getElementById('slide-area')!;
const navArea = document.getElementById('nav-area')!;

// Create stepper
const stepper = sarahStepper({
  steps: STEPS,
  activeIndex: 0,
  onStepClick: (index) => {
    if (index < currentStep) goToStep(index);
  },
});
sidebar.appendChild(stepper);

// Step renderers — each returns an HTMLElement
type StepRenderer = (data: WizardData) => HTMLElement;

const stepRenderers: StepRenderer[] = [
  createWelcomeStep,
  createSystemScanStep,
  createProfileStep,
  createPersonalizationStep,
  createFinishStep,
];

// Navigation
function renderNav(): void {
  navArea.innerHTML = '';

  if (currentStep > 0) {
    navArea.appendChild(sarahButton({
      label: 'Zurück',
      variant: 'secondary',
      onClick: () => goToStep(currentStep - 1),
    }));
  }

  if (currentStep < STEPS.length - 1) {
    navArea.appendChild(sarahButton({
      label: 'Weiter',
      variant: 'primary',
      onClick: () => goToStep(currentStep + 1),
    }));
  }

  if (currentStep === STEPS.length - 1) {
    navArea.appendChild(sarahButton({
      label: 'S.A.R.A.H. starten',
      variant: 'primary',
      onClick: finishWizard,
    }));
  }
}

function goToStep(index: number): void {
  currentStep = index;
  stepper.setActive(currentStep);
  renderStep();
  renderNav();
}

function renderStep(): void {
  slideArea.innerHTML = '';
  const stepContent = stepRenderers[currentStep](wizardData);
  slideArea.appendChild(stepContent);
}

async function finishWizard(): Promise<void> {
  await sarah.saveConfig({
    setupComplete: true,
    system: wizardData.system,
    profile: wizardData.profile,
    personalization: wizardData.personalization,
  });

  // Reload to dashboard
  window.location.href = 'dashboard.html';
}

// Initialize
goToStep(0);
