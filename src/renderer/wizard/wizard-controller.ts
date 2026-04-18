import { sarahStepper } from '../components/sarah-stepper.js';
import { sarahButton } from '../components/sarah-button.js';
import { SarahInput } from '../components/sarah-input.js';
import type { WizardData } from './wizard.js';
import type { SarahApi } from '../../core/sarah-api.js';

export interface StepDef {
  id: string;
  label: string;
  optional: boolean;
  renderer: (data: WizardData) => HTMLElement;
  shouldShow?: (data: WizardData) => boolean;
}

export interface WizardDom {
  sidebar: HTMLElement;
  slideArea: HTMLElement;
  navArea: HTMLElement;
}

export class WizardController {
  private currentStep = 0;
  private navigating = false;
  private visibleSteps: StepDef[];
  private stepper: ReturnType<typeof sarahStepper>;

  constructor(
    private data: WizardData,
    private steps: StepDef[],
    private dom: WizardDom,
    private api: SarahApi,
  ) {
    this.visibleSteps = this.getVisibleSteps();
    this.stepper = sarahStepper({
      steps: this.visibleSteps.map(s => ({ id: s.id, label: s.label })),
      activeIndex: 0,
      onStepClick: (index) => {
        if (index < this.currentStep) this.goToStep(index);
      },
    });
    this.dom.sidebar.appendChild(this.stepper);
  }

  start(): void {
    this.goToStep(0);
  }

  private getVisibleSteps(): StepDef[] {
    return this.steps.filter(s => !s.shouldShow || s.shouldShow(this.data));
  }

  private refreshStepper(): void {
    this.visibleSteps = this.getVisibleSteps();
    this.stepper.setSteps(this.visibleSteps.map(s => ({ id: s.id, label: s.label })));
    this.stepper.setActive(this.currentStep);
  }

  private validateCurrentStep(): boolean {
    const step = this.visibleSteps[this.currentStep];

    if (step.id === 'system' && !this.data.system.os) {
      return false;
    }

    const inputs = this.dom.slideArea.querySelectorAll<SarahInput>('sarah-input[required]');
    let valid = true;
    inputs.forEach(input => {
      if (!input.validate()) valid = false;
    });
    return valid;
  }

  private goToStep(index: number): void {
    if (this.navigating) return;
    this.navigating = true;
    this.currentStep = index;
    this.refreshStepper();
    this.renderStep();
    this.renderNav();
    setTimeout(() => { this.navigating = false; }, 200);
  }

  private renderStep(): void {
    this.dom.slideArea.innerHTML = '';
    const step = this.visibleSteps[this.currentStep];
    this.dom.slideArea.appendChild(step.renderer(this.data));
  }

  private renderNav(): void {
    this.dom.navArea.innerHTML = '';
    const step = this.visibleSteps[this.currentStep];

    if (this.currentStep > 0) {
      this.dom.navArea.appendChild(sarahButton({
        label: 'Zurück',
        variant: 'secondary',
        onClick: () => this.goToStep(this.currentStep - 1),
      }));
    }

    const spacer = document.createElement('div');
    spacer.className = 'wizard-nav-spacer';
    this.dom.navArea.appendChild(spacer);

    if (step.optional && this.currentStep < this.visibleSteps.length - 1) {
      this.dom.navArea.appendChild(sarahButton({
        label: 'Überspringen',
        variant: 'ghost',
        onClick: () => {
          this.data.skippedSteps.add(step.id);
          this.goToStep(this.currentStep + 1);
        },
      }));
    }

    if (this.currentStep < this.visibleSteps.length - 1) {
      const nextStep = this.visibleSteps[this.currentStep + 1];
      const nextLabel = step.optional ? `Weiter mit ${nextStep.label}` : 'Weiter';
      this.dom.navArea.appendChild(sarahButton({
        label: nextLabel,
        variant: 'primary',
        onClick: () => {
          if (this.validateCurrentStep()) this.goToStep(this.currentStep + 1);
        },
      }));
    }

    if (this.currentStep === this.visibleSteps.length - 1) {
      this.dom.navArea.appendChild(sarahButton({
        label: 'S.A.R.A.H. starten',
        variant: 'primary',
        onClick: () => { this.finish().catch(err => console.error('[Wizard] finish failed:', err)); },
      }));
    }
  }

  private async finish(): Promise<void> {
    const useContext7 = this.data.profile.usagePurposes.includes('Programmieren');

    await this.api.saveConfig({
      onboarding: {
        setupComplete: true,
        firstStart: true,
      },
      system: this.data.system,
      profile: {
        ...this.data.profile,
        usagePurposes: this.data.profile.usagePurposes,
        hobbies: this.data.profile.hobbies,
      },
      skills: this.data.skills,
      resources: this.data.resources,
      trust: this.data.trust,
      personalization: this.data.personalization,
      controls: this.data.controls,
      integrations: {
        context7: useContext7,
      },
    });

    this.api.wizardDone();
  }
}
