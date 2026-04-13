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

import type { SarahApi } from '../../core/sarah-api.js';
export type { ProgramEntry, PdfCategory, CustomCommand } from '../../core/config-schema.js';
import type { ProgramEntry, PdfCategory, CustomCommand } from '../../core/config-schema.js';
export type ProgramType = ProgramEntry['type'];

declare const sarah: SarahApi;

(window as any).__sarah = sarah;

registerComponents();

import type { SarahConfig } from '../../core/config-schema.js';

export interface WizardData {
  system: SarahConfig['system'];
  profile: SarahConfig['profile'];
  skills: SarahConfig['skills'];
  resources: SarahConfig['resources'];
  trust: SarahConfig['trust'];
  personalization: SarahConfig['personalization'];
  controls: SarahConfig['controls'];
  skippedSteps: Set<string>;
}

const wizardData: WizardData = {
  system: { os: '', platform: '', arch: '', cpu: '', cpuCores: '', totalMemory: '', freeMemory: '', hostname: '', shell: '', language: '', timezone: '', folders: { documents: '', downloads: '', pictures: '', desktop: '' } },
  profile: {
    displayName: '',
    city: '',
    usagePurposes: [],
    lastName: '',
    address: '',
    hobbies: [],
    profession: '',
    activities: '',
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
    importantFolders: [],
  },
  trust: {
    memoryAllowed: true,
    fileAccess: 'specific-folders',
    confirmationLevel: 'standard',
    memoryExclusions: [],
    anonymousEnabled: true,
    showContextEnabled: true,
  },
  personalization: {
    accentColor: '#00d4ff',
    voice: 'default-female-de',
    speechRate: 1.0,
    chatFontSize: 'default',
    chatAlignment: 'stacked',
    emojisEnabled: true,
    responseMode: 'normal',
    responseLanguage: 'de',
    responseStyle: 'mittel',
    tone: 'freundlich',
    characterTraits: [],
    quirk: null,
  },
  controls: {
    voiceMode: 'off',
    pushToTalkKey: 'F9',
    quietModeDuration: 60,
    customCommands: [],
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
    controls: wizardData.controls,
    integrations: {
      context7: useContext7,
    },
  });

  sarah.splashDone();
}

goToStep(0);
