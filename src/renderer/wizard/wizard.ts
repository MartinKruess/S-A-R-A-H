import { registerComponents } from '../components/index.js';
import { sarahStepper } from '../components/sarah-stepper.js';
import { sarahButton } from '../components/sarah-button.js';
import { createWelcomeStep } from './steps/step-welcome.js';
import { createSystemScanStep } from './steps/step-system-scan.js';
import { createRequiredStep } from './steps/step-required.js';
import { createPersonalStep } from './steps/step-personal.js';
import { createDynamicStep, hasDynamicQuestions } from './steps/step-dynamic.js';
import { createFilesStep } from './steps/step-files.js';
import { createTrustStep } from './steps/step-trust.js';
import { createPersonalizationStep } from './steps/step-personalization.js';
import { createFinishStep } from './steps/step-finish.js';

export type ProgramType = 'exe' | 'launcher' | 'appx' | 'updater';

export interface ProgramEntry {
  name: string;
  path: string;
  type: ProgramType;
  source: 'detected' | 'manual' | 'learned';
  verified: boolean;
  aliases: string[];
  duplicateGroup?: string;
}

export interface PdfCategory {
  tag: string;
  folder: string;
  pattern: string;
  inferFromExisting: boolean;
}

declare const sarah: {
  version: string;
  splashDone: () => void;
  getSystemInfo: () => Promise<Record<string, string>>;
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  isFirstRun: () => Promise<boolean>;
  selectFolder: (title?: string) => Promise<string | null>;
  detectPrograms: () => Promise<{ name: string; path: string; verified: boolean; aliases: string[] }[]>;
  scanFolderExes: (folderPath: string) => Promise<{ name: string; path: string; verified: boolean; aliases: string[] }[]>;
};

(window as any).__sarah = sarah;

registerComponents();

export interface WizardData {
  system: Record<string, string>;
  profile: {
    displayName: string;
    city: string;
    usagePurposes: string[];
    lastName: string;
    address: string;
    hobbies: string[];
    profession: string;
    activities: string;
    responseStyle: string;
    tone: string;
  };
  skills: {
    programming: string | null;
    programmingStack: string[];
    programmingResources: string[];
    programmingProjectsFolder: string;
    design: string | null;
    office: string | null;
  };
  resources: {
    emails: string[];
    programs: ProgramEntry[];
    favoriteLinks: string[];
    pdfCategories: PdfCategory[];
    picturesFolder: string;
    installFolder: string;
    gamesFolder: string;
    extraProgramsFolder: string;
  };
  trust: {
    memoryAllowed: boolean;
    fileAccess: string;
  };
  personalization: {
    accentColor: string;
    voice: string;
    speechRate: number;
  };
  skippedSteps: Set<string>;
}

const wizardData: WizardData = {
  system: {},
  profile: {
    displayName: '',
    city: '',
    usagePurposes: [],
    lastName: '',
    address: '',
    hobbies: [],
    profession: '',
    activities: '',
    responseStyle: 'mittel',
    tone: 'freundlich',
  },
  skills: {
    programming: null,
    programmingStack: [],
    programmingResources: ['Stack Overflow', 'GitHub', 'MDN'],
    programmingProjectsFolder: '',
    design: null,
    office: null,
  },
  resources: {
    emails: [],
    programs: [],
    favoriteLinks: [],
    pdfCategories: [],
    picturesFolder: '',
    installFolder: '',
    gamesFolder: '',
    extraProgramsFolder: '',
  },
  trust: {
    memoryAllowed: true,
    fileAccess: 'specific-folders',
  },
  personalization: {
    accentColor: '#00d4ff',
    voice: 'default-female-de',
    speechRate: 1.0,
  },
  skippedSteps: new Set(),
};

interface StepDef {
  id: string;
  label: string;
  optional: boolean;
  renderer: (data: WizardData) => HTMLElement;
  shouldShow?: (data: WizardData) => boolean;
}

const STEPS: StepDef[] = [
  { id: 'welcome', label: 'Willkommen', optional: false, renderer: createWelcomeStep },
  { id: 'system', label: 'System-Scan', optional: false, renderer: createSystemScanStep },
  { id: 'required', label: 'Pflichtfelder', optional: false, renderer: createRequiredStep },
  { id: 'personal', label: 'Persönliches', optional: true, renderer: createPersonalStep },
  {
    id: 'dynamic', label: 'Vertiefung', optional: false, renderer: createDynamicStep,
    shouldShow: (data) => hasDynamicQuestions(data),
  },
  { id: 'files', label: 'Dateien & Apps', optional: true, renderer: createFilesStep },
  { id: 'trust', label: 'Vertrauen', optional: false, renderer: createTrustStep },
  { id: 'personalization', label: 'Personalisierung', optional: false, renderer: createPersonalizationStep },
  { id: 'finish', label: 'Fertig', optional: false, renderer: createFinishStep },
];

let currentStep = 0;
let navigating = false;

const sidebar = document.getElementById('sidebar')!;
const slideArea = document.getElementById('slide-area')!;
const navArea = document.getElementById('nav-area')!;

function validateCurrentStep(): boolean {
  const step = visibleSteps[currentStep];

  // System scan must complete before advancing
  if (step.id === 'system' && !wizardData.system.os) {
    return false;
  }

  // Check all required sarah-input elements in current slide
  const inputs = slideArea.querySelectorAll('sarah-input[required]');
  let valid = true;
  inputs.forEach(input => {
    if (!(input as any).validate()) valid = false;
  });
  return valid;
}

function getVisibleSteps(): StepDef[] {
  return STEPS.filter(s => !s.shouldShow || s.shouldShow(wizardData));
}

let visibleSteps = getVisibleSteps();

const stepper = sarahStepper({
  steps: visibleSteps.map(s => ({ id: s.id, label: s.label })),
  activeIndex: 0,
  onStepClick: (index) => {
    if (index < currentStep) goToStep(index);
  },
});
sidebar.appendChild(stepper);

function refreshStepper(): void {
  visibleSteps = getVisibleSteps();
  stepper.setSteps(visibleSteps.map(s => ({ id: s.id, label: s.label })));
  stepper.setActive(currentStep);
}

function renderNav(): void {
  navArea.innerHTML = '';

  const step = visibleSteps[currentStep];

  if (currentStep > 0) {
    navArea.appendChild(sarahButton({
      label: 'Zurück',
      variant: 'secondary',
      onClick: () => goToStep(currentStep - 1),
    }));
  }

  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  navArea.appendChild(spacer);

  if (step.optional && currentStep < visibleSteps.length - 1) {
    navArea.appendChild(sarahButton({
      label: 'Überspringen',
      variant: 'ghost',
      onClick: () => {
        wizardData.skippedSteps.add(step.id);
        goToStep(currentStep + 1);
      },
    }));
  }

  if (currentStep < visibleSteps.length - 1) {
    const nextStep = visibleSteps[currentStep + 1];
    const nextLabel = step.optional
      ? `Weiter mit ${nextStep.label}`
      : 'Weiter';
    navArea.appendChild(sarahButton({
      label: nextLabel,
      variant: 'primary',
      onClick: () => {
        if (validateCurrentStep()) goToStep(currentStep + 1);
      },
    }));
  }

  if (currentStep === visibleSteps.length - 1) {
    navArea.appendChild(sarahButton({
      label: 'S.A.R.A.H. starten',
      variant: 'primary',
      onClick: finishWizard,
    }));
  }
}

function goToStep(index: number): void {
  if (navigating) return;
  navigating = true;
  currentStep = index;
  refreshStepper();
  renderStep();
  renderNav();
  setTimeout(() => { navigating = false; }, 200);
}

function renderStep(): void {
  slideArea.innerHTML = '';
  const step = visibleSteps[currentStep];
  const stepContent = step.renderer(wizardData);
  slideArea.appendChild(stepContent);
}

async function finishWizard(): Promise<void> {
  const useContext7 = wizardData.profile.usagePurposes.includes('Programmieren');

  await sarah.saveConfig({
    onboarding: {
      setupComplete: true,
    },
    system: wizardData.system,
    profile: {
      ...wizardData.profile,
      usagePurposes: wizardData.profile.usagePurposes,
      hobbies: wizardData.profile.hobbies,
    },
    skills: wizardData.skills,
    resources: wizardData.resources,
    trust: wizardData.trust,
    personalization: wizardData.personalization,
    integrations: {
      context7: useContext7,
    },
  });

  window.location.href = 'dashboard.html';
}

goToStep(0);
