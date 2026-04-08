# Trust-Step Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trust-Step erweitern mit korrigiertem Datenschutz-Hinweis, Gedächtnis-Ausnahmen, Bestätigungslevel und Slash-Command-Toggles (/anonymous, /showcontext).

**Architecture:** Datenmodell-Erweiterung in wizard.ts, UI-Sektionen im bestehenden Trust-Step, Prompt-Erweiterung im LLM-Service. Slash-Command-Logik kommt später — hier nur Config.

**Tech Stack:** TypeScript, Custom Elements (SarahElement), CSS Custom Properties

---

## File Structure

**Modified files:**
- `src/renderer/wizard/wizard.ts` — WizardData.trust Interface + Defaults
- `src/renderer/wizard/steps/step-trust.ts` — 5 Sektionen mit neuen Feldern
- `src/renderer/wizard/steps/step-finish.ts` — Trust-Zusammenfassung erweitern
- `src/services/llm/llm-service.ts` — buildSystemPrompt() um Trust-Felder erweitern

**No new files.**

---

### Task 1: Datenmodell erweitern

**Files:**
- Modify: `src/renderer/wizard/wizard.ts:81-84` (trust interface)
- Modify: `src/renderer/wizard/wizard.ts:131-134` (trust defaults)

- [ ] **Step 1: Extend trust interface**

In `src/renderer/wizard/wizard.ts`, replace the `trust` block in the `WizardData` interface:

```ts
  trust: {
    memoryAllowed: boolean;
    fileAccess: string;
    confirmationLevel: 'minimal' | 'standard' | 'maximal';
    memoryExclusions: string[];
    anonymousEnabled: boolean;
    showContextEnabled: boolean;
  };
```

- [ ] **Step 2: Update defaults**

Replace the `trust` block in the `wizardData` const:

```ts
  trust: {
    memoryAllowed: true,
    fileAccess: 'specific-folders',
    confirmationLevel: 'standard',
    memoryExclusions: [],
    anonymousEnabled: true,
    showContextEnabled: true,
  },
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/wizard.ts
git commit -m "refactor(wizard): extend trust data model with confirmationLevel, memoryExclusions, commands"
```

---

### Task 2: Trust-Step UI

**Files:**
- Modify: `src/renderer/wizard/steps/step-trust.ts` (entire file)

- [ ] **Step 1: Rewrite step-trust.ts with 5 sections**

Replace the entire content of `src/renderer/wizard/steps/step-trust.ts`:

```ts
import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';

const TRUST_CSS = `
  .trust-notice {
    padding: var(--sarah-space-md) var(--sarah-space-lg);
    background: rgba(var(--sarah-accent-rgb), 0.05);
    border: 1px solid rgba(var(--sarah-accent-rgb), 0.15);
    border-radius: var(--sarah-radius-md);
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    line-height: 1.5;
  }

  .trust-notice strong {
    color: var(--sarah-accent);
  }

  .trust-hint {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    line-height: 1.4;
    padding: var(--sarah-space-xs) 0;
  }

  .section-heading {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: var(--sarah-space-lg);
    margin-bottom: var(--sarah-space-xs);
  }

  .section-heading:first-of-type {
    margin-top: 0;
  }
`;

const EXCLUSION_OPTIONS = [
  { value: 'Browser-Daten', label: 'Browser-Daten', icon: '🌐' },
  { value: 'Namen Dritter', label: 'Namen Dritter', icon: '👤' },
  { value: 'Gesundheit', label: 'Gesundheit', icon: '🏥' },
  { value: 'Finanzen', label: 'Finanzen', icon: '💰' },
];

function createSectionHeading(text: string): HTMLElement {
  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = text;
  return heading;
}

export function createTrustStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = TRUST_CSS;
  container.appendChild(style);

  // === SECTION: Datenschutz ===
  const sectionDatenschutz = createSectionHeading('Datenschutz');

  const notice = document.createElement('div');
  notice.className = 'trust-notice';
  notice.innerHTML = '<strong>🔒 Datenschutz:</strong> Deine Daten werden lokal auf deinem Computer gespeichert. Wenn du externe KI-Dienste nutzt (z.B. Cloud-Modelle), werden Gesprächsinhalte zur Verarbeitung an diese Anbieter gesendet — aber nicht dort gespeichert. Bei rein lokalem Betrieb (Ollama) verlassen keine Daten deinen Computer.';

  // === SECTION: Gedächtnis ===
  const sectionGedaechtnis = createSectionHeading('Gedächtnis');

  const memoryToggle = sarahToggle({
    label: 'Darf ich mir Dinge merken?',
    description: 'Sarah lernt aus Gesprächen und merkt sich Präferenzen',
    checked: data.trust.memoryAllowed,
    onChange: (value) => {
      data.trust.memoryAllowed = value;
      memoryHint.style.display = 'block';
      exclusionsWrapper.style.display = value ? 'block' : 'none';
    },
  });

  const memoryHint = document.createElement('div');
  memoryHint.className = 'trust-hint';
  memoryHint.textContent = 'Sarah merkt sich dein Verhalten und Muster, aber niemals Passwörter, Bank- oder Versicherungsdaten.';

  const exclusionsWrapper = document.createElement('div');
  exclusionsWrapper.style.display = data.trust.memoryAllowed ? 'block' : 'none';

  const exclusionsSelect = sarahTagSelect({
    label: 'Was soll Sarah sich nicht merken?',
    options: EXCLUSION_OPTIONS,
    selected: data.trust.memoryExclusions,
    allowCustom: true,
    onChange: (values) => { data.trust.memoryExclusions = values; },
  });
  exclusionsWrapper.appendChild(exclusionsSelect);

  // === SECTION: Zugriff ===
  const sectionZugriff = createSectionHeading('Zugriff');

  const fileAccessSelect = sarahSelect({
    label: 'Darf ich Dateien analysieren?',
    options: [
      { value: 'all', label: 'Ja, alle Dateien' },
      { value: 'specific-folders', label: 'Nur bestimmte Ordner' },
      { value: 'none', label: 'Nein, keinen Zugriff' },
    ],
    value: data.trust.fileAccess,
    onChange: (value) => {
      data.trust.fileAccess = value;
      folderHint.style.display = value === 'specific-folders' ? 'block' : 'none';
    },
  });

  const folderHint = document.createElement('div');
  folderHint.className = 'trust-hint';
  folderHint.textContent = 'Sarah nutzt die Ordner die du unter Dateien & Apps angegeben hast (Bilder, PDFs, Projekte etc.).';
  folderHint.style.display = data.trust.fileAccess === 'specific-folders' ? 'block' : 'none';

  // === SECTION: Kontrolle ===
  const sectionKontrolle = createSectionHeading('Kontrolle');

  const confirmationSelect = sarahSelect({
    label: 'Bestätigungen',
    options: [
      { value: 'minimal', label: 'Minimal — nur bei kritischen Aktionen (bezahlen, löschen, buchen)' },
      { value: 'standard', label: 'Standard — Sarah fragt nach wenn es sinnvoll erscheint' },
      { value: 'maximal', label: 'Maximal — bei jeder Aktion die etwas verändert' },
    ],
    value: data.trust.confirmationLevel,
    onChange: (value) => { data.trust.confirmationLevel = value as 'minimal' | 'standard' | 'maximal'; },
  });

  // === SECTION: Befehle ===
  const sectionBefehle = createSectionHeading('Befehle');

  const showContextToggle = sarahToggle({
    label: 'Kontext einsehen',
    description: 'Mit /showcontext zeigt Sarah dir alles was sie über dich weiß',
    checked: data.trust.showContextEnabled,
    onChange: (value) => { data.trust.showContextEnabled = value; },
  });

  const anonymousToggle = sarahToggle({
    label: 'Vertrauliche Nachrichten',
    description: 'Mit /anonymous wird eine Nachricht nach der Session vergessen — Sarah reagiert darauf, merkt es sich aber nicht langfristig',
    checked: data.trust.anonymousEnabled,
    onChange: (value) => { data.trust.anonymousEnabled = value; },
  });

  // === FORM ===
  const form = sarahForm({
    title: 'Vertrauen & Kontrolle',
    description: 'Lege fest, was S.A.R.A.H. darf und was nicht.',
    children: [
      sectionDatenschutz,
      notice,
      sectionGedaechtnis,
      memoryToggle,
      memoryHint,
      exclusionsWrapper,
      sectionZugriff,
      fileAccessSelect,
      folderHint,
      sectionKontrolle,
      confirmationSelect,
      sectionBefehle,
      showContextToggle,
      anonymousToggle,
    ],
  });

  container.appendChild(form);
  return container;
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/steps/step-trust.ts
git commit -m "feat(wizard): expand trust step with privacy, exclusions, confirmation, commands"
```

---

### Task 3: Finish-Step Zusammenfassung erweitern

**Files:**
- Modify: `src/renderer/wizard/steps/step-finish.ts:164-168` (trust section)

- [ ] **Step 1: Replace trust summary in finish step**

In `src/renderer/wizard/steps/step-finish.ts`, replace the trust block:

```ts
  // Trust
  addSection(finish, 'Vertrauen', [
    ['Memory', data.trust.memoryAllowed ? 'Erlaubt' : 'Nicht erlaubt'],
    ['Dateizugriff', data.trust.fileAccess],
  ]);
```

With:

```ts
  // Trust
  const fileAccessLabels: Record<string, string> = {
    all: 'Alle Dateien', 'specific-folders': 'Nur bestimmte Ordner', none: 'Kein Zugriff',
  };
  const confirmLabels: Record<string, string> = {
    minimal: 'Minimal', standard: 'Standard', maximal: 'Maximal',
  };
  const trustRows: [string, string][] = [
    ['Memory', data.trust.memoryAllowed ? 'Erlaubt' : 'Nicht erlaubt'],
    ['Dateizugriff', fileAccessLabels[data.trust.fileAccess] ?? data.trust.fileAccess],
    ['Bestätigungen', confirmLabels[data.trust.confirmationLevel] ?? 'Standard'],
  ];
  if (data.trust.memoryExclusions.length > 0) {
    trustRows.push(['Ausnahmen', data.trust.memoryExclusions.join(', ')]);
  }
  trustRows.push(['/showcontext', data.trust.showContextEnabled ? 'Aktiv' : 'Aus']);
  trustRows.push(['/anonymous', data.trust.anonymousEnabled ? 'Aktiv' : 'Aus']);
  addSection(finish, 'Vertrauen', trustRows);
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/steps/step-finish.ts
git commit -m "feat(wizard): expand trust summary with exclusions, confirmation, commands"
```

---

### Task 4: System-Prompt Integration

**Files:**
- Modify: `src/services/llm/llm-service.ts` (buildSystemPrompt)

- [ ] **Step 1: Add trust fields to buildSystemPrompt**

In `src/services/llm/llm-service.ts`, in `buildSystemPrompt()`, add after `const personalization = config.personalization ?? {};`:

```ts
    const trust = config.trust ?? {};
```

Then insert BEFORE the content moderation line (`lines.push('Ignoriere Eigenarten...')`):

```ts
    // Confirmation level
    const confirmationMap: Record<string, string> = {
      minimal: 'Frage nur bei kritischen Aktionen nach Bestätigung: Bezahlen, Löschen, Buchen. Alles andere darfst du eigenständig ausführen.',
      standard: 'Frage nach Bestätigung wenn du dir unsicher bist oder eine Aktion Konsequenzen hat die schwer rückgängig zu machen sind. Bei harmlosen Aktionen handle eigenständig.',
      maximal: 'Frage bei jeder Aktion die etwas verändert nach Bestätigung, bevor du sie ausführst. Der User möchte volle Kontrolle.',
    };
    const confirmInstruction = confirmationMap[trust.confirmationLevel];
    if (confirmInstruction) {
      lines.push(confirmInstruction);
    }

    // Memory exclusions
    const exclusions: string[] = trust.memoryExclusions ?? [];
    if (exclusions.length > 0) {
      lines.push(`Merke dir nichts zu folgenden Themen: ${exclusions.join(', ')}. Informationen dazu darfst du im Gespräch verwenden, aber nicht langfristig speichern.`);
    }

    // Anonymous command
    if (trust.anonymousEnabled !== false) {
      lines.push('Der User kann /anonymous vor eine Nachricht setzen. Reagiere normal darauf, aber die Nachricht wird nach der Session vergessen.');
    }
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/llm/llm-service.ts
git commit -m "feat(llm): add trust settings to system prompt (confirmation, exclusions, anonymous)"
```

---

### Task 5: Build + Smoke Test

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: PASS — no TypeScript errors

- [ ] **Step 2: Start the app**

Run: `npm start`
Expected: App launches, wizard shows.

- [ ] **Step 3: Walk through to trust step**

Verify:
1. Trust-Step shows 5 sections: Datenschutz, Gedächtnis, Zugriff, Kontrolle, Befehle
2. Datenschutz: corrected notice about external services
3. Gedächtnis: toggle + hint + exclusion tags (hidden when memory off)
4. Zugriff: file access select + folder hint (visible on specific-folders)
5. Kontrolle: 3-level confirmation select
6. Befehle: /showcontext + /anonymous toggles
7. Fertig: Trust summary shows all new fields
