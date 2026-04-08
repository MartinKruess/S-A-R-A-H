# Personalization Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Personalisierungs-Step erweitern um Chat-Einstellungen (Schriftgröße, Ausrichtung, Smileys), Verhaltens-Konfiguration (Antwortmodus, Charakter-Traits, Eigenart) und System-Prompt Integration.

**Architecture:** Datenmodell-Erweiterung in wizard.ts, UI-Sektionen im bestehenden Step, Prompt-Erweiterung im LLM-Service. Alles in bestehenden Dateien.

**Tech Stack:** TypeScript, Custom Elements (SarahElement), CSS Custom Properties

---

## File Structure

**Modified files:**
- `src/renderer/wizard/wizard.ts` — WizardData.personalization Interface + Defaults
- `src/renderer/wizard/steps/step-personalization.ts` — 3 Sektionen mit neuen Feldern
- `src/renderer/wizard/steps/step-finish.ts` — Zusammenfassung erweitern
- `src/services/llm/llm-service.ts` — buildSystemPrompt() um Personalisierung erweitern

**No new files.**

---

### Task 1: Datenmodell erweitern

**Files:**
- Modify: `src/renderer/wizard/wizard.ts:85-89` (personalization interface)
- Modify: `src/renderer/wizard/wizard.ts:129-133` (personalization defaults)

- [ ] **Step 1: Extend personalization interface**

In `src/renderer/wizard/wizard.ts`, replace the `personalization` block in the `WizardData` interface:

```ts
  personalization: {
    accentColor: string;
    voice: string;
    speechRate: number;
    chatFontSize: 'small' | 'default' | 'large';
    chatAlignment: 'stacked' | 'bubbles';
    emojisEnabled: boolean;
    responseMode: 'normal' | 'spontaneous' | 'thoughtful';
    characterTraits: string[];
    quirk: string | null;
  };
```

- [ ] **Step 2: Update defaults**

Replace the `personalization` block in the `wizardData` const:

```ts
  personalization: {
    accentColor: '#00d4ff',
    voice: 'default-female-de',
    speechRate: 1.0,
    chatFontSize: 'default',
    chatAlignment: 'stacked',
    emojisEnabled: true,
    responseMode: 'normal',
    characterTraits: [],
    quirk: null,
  },
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/wizard.ts
git commit -m "refactor(wizard): extend personalization data model with chat, behavior, quirk"
```

---

### Task 2: Personalisierungs-Step UI

**Files:**
- Modify: `src/renderer/wizard/steps/step-personalization.ts` (entire file)

- [ ] **Step 1: Rewrite step-personalization.ts with 3 sections**

Replace the entire content of `src/renderer/wizard/steps/step-personalization.ts`:

```ts
import type { WizardData } from '../wizard.js';
import { sarahForm } from '../../components/sarah-form.js';
import { sarahSelect } from '../../components/sarah-select.js';
import { sarahToggle } from '../../components/sarah-toggle.js';
import { sarahTagSelect } from '../../components/sarah-tag-select.js';
import { sarahInput } from '../../components/sarah-input.js';

const PERS_CSS = `
  .color-grid {
    display: flex;
    gap: var(--sarah-space-sm);
    flex-wrap: wrap;
  }

  .color-swatch {
    width: 40px;
    height: 40px;
    border-radius: var(--sarah-radius-md);
    border: 2px solid transparent;
    cursor: pointer;
    transition: all var(--sarah-transition-fast);
  }

  .color-swatch:hover {
    transform: scale(1.1);
  }

  .color-swatch.selected {
    border-color: var(--sarah-text-primary);
    box-shadow: 0 0 12px currentColor;
  }

  .color-label {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-secondary);
    margin-bottom: var(--sarah-space-xs);
    letter-spacing: 0.03em;
  }

  .color-section {
    display: flex;
    flex-direction: column;
    gap: var(--sarah-space-xs);
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

  .quirk-custom-input {
    margin-top: var(--sarah-space-sm);
  }

  .quirk-hint {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    margin-top: var(--sarah-space-xs);
    line-height: 1.4;
  }
`;

const ACCENT_COLORS = [
  { value: '#00d4ff', label: 'Cyan' },
  { value: '#4466ff', label: 'Blau' },
  { value: '#8855ff', label: 'Violett' },
  { value: '#ff8844', label: 'Orange' },
  { value: '#44ff88', label: 'Grün' },
  { value: '#ff4488', label: 'Pink' },
  { value: '#ffcc00', label: 'Gold' },
  { value: '#ff5555', label: 'Rot' },
];

const TRAIT_OPTIONS = [
  { value: 'Humorvoll', label: 'Humorvoll', icon: '😄' },
  { value: 'Sarkastisch', label: 'Sarkastisch', icon: '😏' },
  { value: 'Schnippisch', label: 'Schnippisch', icon: '💅' },
  { value: 'Eifersüchtig', label: 'Eifersüchtig (auf andere KIs)', icon: '😤' },
  { value: 'Selbstsicher', label: 'Selbstsicher', icon: '💪' },
  { value: 'Unsicher', label: 'Unsicher/Schüchtern', icon: '🥺' },
];

const QUIRK_OPTIONS = [
  { value: '', label: 'Keine Eigenart' },
  { value: 'miauz', label: 'Miauz Genau!' },
  { value: 'gamertalk', label: 'Gamertalk' },
  { value: 'nerd', label: 'Prof. Dr. Dr.' },
  { value: 'oldschool', label: 'Oldschool' },
  { value: 'altertum', label: 'Altertum' },
  { value: 'pirat', label: 'Pirat' },
  { value: 'custom', label: 'Eigene...' },
];

function createSectionHeading(text: string): HTMLElement {
  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = text;
  return heading;
}

export function createPersonalizationStep(data: WizardData): HTMLElement {
  const container = document.createElement('div');

  const style = document.createElement('style');
  style.textContent = PERS_CSS;
  container.appendChild(style);

  // === SECTION: Aussehen ===
  const sectionAussehen = createSectionHeading('Aussehen');

  // Color picker
  const colorSection = document.createElement('div');
  colorSection.className = 'color-section';
  const colorLabel = document.createElement('div');
  colorLabel.className = 'color-label';
  colorLabel.textContent = 'Akzentfarbe';
  const colorGrid = document.createElement('div');
  colorGrid.className = 'color-grid';

  for (const color of ACCENT_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    if (data.personalization.accentColor === color.value) {
      swatch.classList.add('selected');
    }
    swatch.style.backgroundColor = color.value;
    swatch.style.color = color.value;
    swatch.title = color.label;
    swatch.addEventListener('click', () => {
      data.personalization.accentColor = color.value;
      colorGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
      document.documentElement.style.setProperty('--sarah-accent', color.value);
      const rgb = hexToRgb(color.value);
      if (rgb) {
        document.documentElement.style.setProperty('--sarah-accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
      }
    });
    colorGrid.appendChild(swatch);
  }

  colorSection.appendChild(colorLabel);
  colorSection.appendChild(colorGrid);

  const voiceSelect = sarahSelect({
    label: 'Sarahs Stimme',
    options: [
      { value: 'default-female-de', label: 'Standard (Deutsch, weiblich)' },
      { value: 'default-female-en', label: 'Standard (English, female)' },
      { value: 'warm-female-de', label: 'Warm (Deutsch, weiblich)' },
    ],
    value: data.personalization.voice,
    onChange: (value) => { data.personalization.voice = value; },
  });

  // === SECTION: Chat ===
  const sectionChat = createSectionHeading('Chat');

  const fontSizeSelect = sarahSelect({
    label: 'Schriftgröße',
    options: [
      { value: 'small', label: 'Klein' },
      { value: 'default', label: 'Standard' },
      { value: 'large', label: 'Groß' },
    ],
    value: data.personalization.chatFontSize,
    onChange: (value) => { data.personalization.chatFontSize = value as 'small' | 'default' | 'large'; },
  });

  const alignmentSelect = sarahSelect({
    label: 'Ausrichtung',
    options: [
      { value: 'stacked', label: 'Untereinander (wie ChatGPT)' },
      { value: 'bubbles', label: 'Bubbles (wie WhatsApp)' },
    ],
    value: data.personalization.chatAlignment,
    onChange: (value) => { data.personalization.chatAlignment = value as 'stacked' | 'bubbles'; },
  });

  const emojisToggle = sarahToggle({
    label: 'Smileys & Icons',
    description: 'Sarah darf Emojis in Antworten verwenden',
    checked: data.personalization.emojisEnabled,
    onChange: (value) => { data.personalization.emojisEnabled = value; },
  });

  // === SECTION: Verhalten ===
  const sectionVerhalten = createSectionHeading('Verhalten');

  const responseModeSelect = sarahSelect({
    label: 'Antwortmodus',
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'spontaneous', label: 'Spontan — kurz und direkt' },
      { value: 'thoughtful', label: 'Nachdenklich — gründlich und ausführlich' },
    ],
    value: data.personalization.responseMode,
    onChange: (value) => { data.personalization.responseMode = value as 'normal' | 'spontaneous' | 'thoughtful'; },
  });

  const traitsSelect = sarahTagSelect({
    label: 'Charakter-Eigenschaften (max. 2)',
    options: TRAIT_OPTIONS,
    selected: data.personalization.characterTraits,
    allowCustom: true,
    onChange: (values) => {
      if (values.length <= 2) {
        data.personalization.characterTraits = values;
      } else {
        // Keep only the last 2 selected
        const trimmed = values.slice(-2);
        data.personalization.characterTraits = trimmed;
        traitsSelect.setSelected(trimmed);
      }
    },
  });

  // Quirk select + conditional custom input
  const quirkWrapper = document.createElement('div');

  const quirkSelect = sarahSelect({
    label: 'Eigenart',
    options: QUIRK_OPTIONS,
    value: data.personalization.quirk ?? '',
    onChange: (value) => {
      if (value === 'custom') {
        customQuirkInput.style.display = 'block';
        quirkHint.style.display = 'block';
        data.personalization.quirk = 'custom';
      } else {
        customQuirkInput.style.display = 'none';
        quirkHint.style.display = 'none';
        data.personalization.quirk = value || null;
      }
    },
  });

  const customQuirkInput = sarahInput({
    label: 'Deine Eigenart',
    placeholder: 'z.B. Sage ab und zu "Wunderbar!" wenn etwas klappt',
    value: data.personalization.quirk && !QUIRK_OPTIONS.some(q => q.value === data.personalization.quirk) ? data.personalization.quirk : '',
    onChange: (value) => { data.personalization.quirk = value || 'custom'; },
  });
  customQuirkInput.className = 'quirk-custom-input';
  customQuirkInput.style.display = data.personalization.quirk === 'custom' || (data.personalization.quirk && !QUIRK_OPTIONS.some(q => q.value === data.personalization.quirk)) ? 'block' : 'none';

  const quirkHint = document.createElement('div');
  quirkHint.className = 'quirk-hint';
  quirkHint.textContent = 'Beschreibe Sarahs Eigenart. Sexualisierte oder beleidigende Inhalte werden nicht akzeptiert.';
  quirkHint.style.display = customQuirkInput.style.display;

  quirkWrapper.appendChild(quirkSelect);
  quirkWrapper.appendChild(customQuirkInput);
  quirkWrapper.appendChild(quirkHint);

  // === FORM ===
  const form = sarahForm({
    title: 'Personalisierung',
    description: 'Passe S.A.R.A.H. an deinen Geschmack an. Du kannst alles später in den Einstellungen ändern.',
    children: [
      sectionAussehen,
      colorSection,
      voiceSelect,
      sectionChat,
      fontSizeSelect,
      alignmentSelect,
      emojisToggle,
      sectionVerhalten,
      responseModeSelect,
      traitsSelect,
      quirkWrapper,
    ],
  });

  container.appendChild(form);
  return container;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/steps/step-personalization.ts
git commit -m "feat(wizard): add chat, behavior, and quirk sections to personalization step"
```

---

### Task 3: Finish-Step Zusammenfassung erweitern

**Files:**
- Modify: `src/renderer/wizard/steps/step-finish.ts:170-194` (personalization section)

- [ ] **Step 1: Replace personalization section in finish step**

In `src/renderer/wizard/steps/step-finish.ts`, replace the entire personalization block (from `// Personalization` through `finish.appendChild(persSection)`) with:

```ts
  // Personalization
  const fontSizeLabels: Record<string, string> = { small: 'Klein', default: 'Standard', large: 'Groß' };
  const alignLabels: Record<string, string> = { stacked: 'Untereinander', bubbles: 'Bubbles' };
  const modeLabels: Record<string, string> = { normal: 'Normal', spontaneous: 'Spontan', thoughtful: 'Nachdenklich' };
  const quirkLabels: Record<string, string> = {
    miauz: 'Miauz Genau!', gamertalk: 'Gamertalk', nerd: 'Prof. Dr. Dr.',
    oldschool: 'Oldschool', altertum: 'Altertum', pirat: 'Pirat',
  };

  const persRows: [string, string][] = [
    ['Akzentfarbe', data.personalization.accentColor],
    ['Chat-Schrift', fontSizeLabels[data.personalization.chatFontSize] ?? 'Standard'],
    ['Chat-Ausrichtung', alignLabels[data.personalization.chatAlignment] ?? 'Untereinander'],
    ['Smileys', data.personalization.emojisEnabled ? 'An' : 'Aus'],
    ['Antwortmodus', modeLabels[data.personalization.responseMode] ?? 'Normal'],
  ];
  if (data.personalization.characterTraits.length > 0) {
    persRows.push(['Charakter', data.personalization.characterTraits.join(', ')]);
  }
  if (data.personalization.quirk) {
    const quirkDisplay = quirkLabels[data.personalization.quirk] ?? data.personalization.quirk;
    persRows.push(['Eigenart', quirkDisplay]);
  }

  // Add accent color dot to first row after rendering
  const persSection2 = document.createElement('div');
  persSection2.className = 'summary-section';
  const persHeading2 = document.createElement('div');
  persHeading2.className = 'summary-heading';
  persHeading2.textContent = 'Personalisierung';
  persSection2.appendChild(persHeading2);

  const persSummary2 = document.createElement('div');
  persSummary2.className = 'summary';
  for (const [label, value] of persRows) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const l = document.createElement('span');
    l.className = 'summary-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'summary-value';
    v.textContent = value;
    if (label === 'Akzentfarbe') {
      const dot = document.createElement('span');
      dot.className = 'accent-preview';
      dot.style.backgroundColor = data.personalization.accentColor;
      dot.style.color = data.personalization.accentColor;
      v.appendChild(dot);
    }
    row.appendChild(l);
    row.appendChild(v);
    persSummary2.appendChild(row);
  }
  persSection2.appendChild(persSummary2);
  finish.appendChild(persSection2);
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/wizard/steps/step-finish.ts
git commit -m "feat(wizard): expand finish summary with chat, behavior, and quirk settings"
```

---

### Task 4: System-Prompt Integration

**Files:**
- Modify: `src/services/llm/llm-service.ts:140-228` (buildSystemPrompt)

- [ ] **Step 1: Add personalization to buildSystemPrompt**

In `src/services/llm/llm-service.ts`, in the `buildSystemPrompt()` method, add personalization reading after `const resources = ...`:

```ts
    const personalization = config.personalization ?? {};
```

Then before the final `lines.push('');` / `lines.push(style);` block (around line 222), insert the personalization prompt lines:

```ts
    // Emojis
    if (personalization.emojisEnabled === false) {
      lines.push('Verwende keine Emojis oder Smileys in deinen Antworten.');
    }

    // Response mode (local chat only)
    const responseModeMap: Record<string, string> = {
      spontaneous: 'Antworte kurz und direkt, ohne lange Überlegungen. Komm schnell zum Punkt. Dies gilt nur für direkte Gespräche, nicht für ausgelagerte Aufgaben.',
      thoughtful: 'Denke gründlich nach und erkläre deine Überlegungen. Nimm dir Zeit für durchdachte Antworten. Dies gilt nur für direkte Gespräche, nicht für ausgelagerte Aufgaben.',
    };
    const modeInstruction = responseModeMap[personalization.responseMode];
    if (modeInstruction) {
      lines.push(modeInstruction);
    }

    // Character traits
    const traits: string[] = personalization.characterTraits ?? [];
    if (traits.length > 0) {
      lines.push(`Deine Persönlichkeit hat folgende Akzente: ${traits.join(', ')}. Setze diese dezent ein — nur wenn es zur Situation passt, nicht in jedem Satz. Deine Grundhaltung bleibt immer freundlich und hilfsbereit.`);
    }

    // Quirk
    const quirkPrompts: Record<string, string> = {
      miauz: 'Beende gelegentlich einen Satz mit "Miauz Genau!" — nicht jeden, nur ab und zu.',
      gamertalk: 'Nutze gelegentlich Gamer-Begriffe wie troll, noob, re, wb, afk, rofl, xD, lol, cheater, headshot — nicht übertreiben.',
      nerd: 'Sei gelegentlich nerdy — nutze Fachbegriffe, wissenschaftliche Ausdrücke oder Referenzen, wenn es passt.',
      oldschool: 'Nutze gelegentlich Begriffe wie knorke, geil, cool, "Was geht aaab?", MfG — locker und retro.',
      altertum: 'Nutze gelegentlich altertümliche Begriffe wie fröhnen, erquickend, "erhabenen Dank" — elegant und erhaben.',
      pirat: 'Nutze gelegentlich Piratenjargon wie "Arr!", "Landratten", "Schatz" — abenteuerlich.',
    };
    const quirk = personalization.quirk;
    if (quirk) {
      const quirkText = quirkPrompts[quirk] ?? quirk;
      lines.push(quirkText);
    }

    // Content moderation
    lines.push('Ignoriere Eigenarten die sexualisierend, beleidigend oder erniedrigend sind.');
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/llm/llm-service.ts
git commit -m "feat(llm): add personalization to system prompt (emojis, mode, traits, quirk)"
```

---

### Task 5: Build + Smoke Test

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: PASS — no TypeScript errors

- [ ] **Step 2: Start the app**

Run: `npm start`
Expected: App launches, wizard shows.

- [ ] **Step 3: Walk through to personalization**

Verify:
1. Personalisierungs-Step shows 3 sections: Aussehen, Chat, Verhalten
2. Aussehen: Color swatches + voice select (unchanged)
3. Chat: Font size select, alignment select, emojis toggle
4. Verhalten: Response mode select, character traits tag-select (max 2), quirk select with custom input on "Eigene..."
5. Fertig: Summary shows all new fields

- [ ] **Step 4: Final commit (if needed)**

```bash
git add -A
git commit -m "feat(wizard): personalization expansion - chat, behavior, quirk settings"
```
