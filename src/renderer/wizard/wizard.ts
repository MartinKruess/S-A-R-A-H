import { registerComponents } from '../components/index.js';
import { createWelcomeStep } from './steps/step-welcome.js';
import { createSystemScanStep } from './steps/step-system-scan.js';
import { createRequiredStep } from './steps/step-required.js';
import { createPersonalStep } from './steps/step-personal.js';
import { createDynamicStep, hasDynamicQuestions } from './steps/step-dynamic.js';
import { createFilesStep } from './steps/step-files.js';
import { createTrustStep } from './steps/step-trust.js';
import { createPersonalizationStep } from './steps/step-personalization.js';
import { createFinishStep } from './steps/step-finish.js';
import { WizardController, type StepDef } from './wizard-controller.js';
import { installSarah } from '../shared/window-global.js';

import type { SarahApi } from '../../core/sarah-api.js';
import type { SarahConfig } from '../../core/config-schema.js';
export type { ProgramEntry, PdfCategory, CustomCommand } from '../../core/config-schema.js';
import type { ProgramEntry } from '../../core/config-schema.js';
export type ProgramType = ProgramEntry['type'];

declare const sarah: SarahApi;
installSarah(sarah);

registerComponents();

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

const controller = new WizardController(
  wizardData,
  STEPS,
  {
    sidebar: document.getElementById('sidebar')!,
    slideArea: document.getElementById('slide-area')!,
    navArea: document.getElementById('nav-area')!,
  },
  sarah,
);

controller.start();
