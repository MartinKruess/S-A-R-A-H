# S.A.R.A.H. — Setup-Wizard Design Spec

> Smart Assistant for Resource and Administration Handling
> Erster Baustein: Einrichtungsassistent (Setup-Wizard)

---

## 1. Überblick

Der Setup-Wizard ist der erste Screen nach dem Splash und läuft **einmalig** beim allerersten Start der App. Er sammelt System-Informationen und User-Präferenzen, damit S.A.R.A.H. personalisiert arbeiten kann.

Nach Abschluss des Wizards wird ein Flag gesetzt (z.B. in einer lokalen Config-Datei), sodass beim nächsten Start direkt die Sarah-Persona geladen wird.

---

## 2. Design-Grundsätze

### 2.1 Visueller Stil

- **Dunkel & futuristisch**, Jarvis-inspiriert
- Dunkler Hintergrund (`#0a0a1a`) als Basis
- Leuchtende Akzente: Cyan, Blau, Violett, Orange
- Glow-Effekte, holographische Elemente, subtile Animationen
- Glassmorphism, feine Linien, Transparenzen
- Hoher Detailgrad, kompatibel mit Level-4 3D-Persona (Stylized Realistisch)

### 2.2 CSS-Architektur

Alle Farben und Design-Tokens werden über **CSS Custom Properties** definiert, um spätere User-Anpassungen zu ermöglichen.

```
styles/
  theme.css           ← CSS-Variablen (Farben, Abstände, Schatten, Glows)
  base.css            ← Reset, Schriften, globale Styles
  components.css      ← Web Component Styles (sarah-button, sarah-input, etc.)
  wizard.css          ← Wizard-spezifische Layouts (Stepper, Slides)
  dashboard.css       ← Dashboard-spezifisch (später)
```

**`theme.css`** — Zentrale Variablen-Datei:
```css
:root {
  /* Hintergrund */
  --sarah-bg-primary: #0a0a1a;
  --sarah-bg-secondary: #12122a;
  --sarah-bg-surface: rgba(255, 255, 255, 0.03);

  /* Text */
  --sarah-text-primary: #e8e8f0;
  --sarah-text-secondary: #a0a0b8;
  --sarah-text-muted: #555566;

  /* Akzente */
  --sarah-accent-cyan: #00d4ff;
  --sarah-accent-blue: #4466ff;
  --sarah-accent-violet: #8855ff;
  --sarah-accent-orange: #ff8844;

  /* Glow */
  --sarah-glow-cyan: rgba(0, 212, 255, 0.3);
  --sarah-glow-blue: rgba(68, 102, 255, 0.3);
  --sarah-glow-violet: rgba(136, 85, 255, 0.3);

  /* Abstände */
  --sarah-space-xs: 4px;
  --sarah-space-sm: 8px;
  --sarah-space-md: 16px;
  --sarah-space-lg: 24px;
  --sarah-space-xl: 48px;

  /* Radien */
  --sarah-radius-sm: 4px;
  --sarah-radius-md: 8px;
  --sarah-radius-lg: 16px;

  /* Transitions */
  --sarah-transition-fast: 150ms ease;
  --sarah-transition-normal: 300ms ease;
  --sarah-transition-slow: 600ms ease;
}
```

- **Der Wizard nutzt immer die Default-Variablen** (läuft vor jeder Personalisierung)
- **Eigene `wizard.css`** für Wizard-spezifische Layouts (Stepper-Timeline, Slide-Transitions), nicht für eigene Farben
- Spätere User-Themes überschreiben nur die Variablen in `theme.css` → alles passt sich automatisch an

---

## 3. Komponenten-System

### 3.1 Ansatz: Web Components + Factory-Wrapper

Jede Komponente wird als **Native Web Component** registriert (`customElements.define`) und hat zusätzlich eine **Factory-Funktion** als Wrapper für dynamische JS-Nutzung.

### 3.2 Nutzung

**Im HTML (deklarativ):**
```html
<sarah-form>
  <sarah-input label="Name" required></sarah-input>
  <sarah-input label="Stadt"></sarah-input>
  <sarah-button type="primary">Weiter</sarah-button>
</sarah-form>
```

**Im TypeScript (programmatisch via Factory):**
```ts
const form = SarahForm({ children: [
  SarahInput({ label: 'Name', required: true }),
  SarahInput({ label: 'Stadt' }),
  SarahButton({ text: 'Weiter', type: 'primary' }),
]})
```

### 3.3 Komponenten für den Wizard

Benötigte Komponenten (erste Iteration):

| Komponente | Beschreibung |
|---|---|
| `sarah-button` | Primary, Secondary, Ghost-Varianten |
| `sarah-input` | Text-Input mit Label, Validation, Glow-Fokus |
| `sarah-select` | Dropdown/Select |
| `sarah-form` | Form-Wrapper (Fieldset, Layout, Submission) |
| `sarah-stepper` | Vertikale Timeline-Navigation |
| `sarah-slide` | Fullscreen-Slide-Container |
| `sarah-card` | Info-Karte (z.B. für System-Scan Ergebnisse) |
| `sarah-progress` | Progress-Bar (z.B. für System-Scan) |
| `sarah-toggle` | Toggle/Switch (z.B. für Einstellungen) |
| `sarah-color-picker` | Farbauswahl (Personalisierung) |

### 3.4 Dateistruktur

```
src/
  components/
    sarah-button.ts
    sarah-input.ts
    sarah-select.ts
    sarah-form.ts
    sarah-stepper.ts
    sarah-slide.ts
    sarah-card.ts
    sarah-progress.ts
    sarah-toggle.ts
    sarah-color-picker.ts
    index.ts            ← Re-exports aller Komponenten + Factories
```

---

## 4. Layout

### 4.1 Wizard-Struktur

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  ● Willkommen        │                           │
│  │                    │                           │
│  ◉ System-Scan        │     [ Slide Content ]     │
│  │                    │                           │
│  ○ Profil             │     Fullscreen-Bereich    │
│  │                    │     für den aktuellen     │
│  ○ Personalisierung   │     Schritt               │
│  │                    │                           │
│  ○ Fertig             │                           │
│                       │                           │
└──────────────────────────────────────────────────┘
```

- **Links:** Vertikale Stepper-Timeline (~200px breit)
  - Erledigte Schritte: Check-Icon + Glow
  - Aktiver Schritt: Leuchtend, pulsierender Glow
  - Offene Schritte: Gedimmt
- **Rechts:** Fullscreen-Slide für den aktuellen Schritt
- **Slide-Transitions:** Smooth Fade oder Slide-Up zwischen Schritten
- **Navigation:** Vor/Zurück-Buttons im Slide-Bereich unten

---

## 5. Wizard-Schritte

### Schritt 1: Willkommen

**Zweck:** Sarah stellt sich vor. Kein Formular, rein visuell/animiert.

**Inhalt:**
- Sarah-Persona (oder Platzhalter-Animation bis Persona gebaut ist)
- Animierter Text: "Hallo, ich bin Sarah — dein persönlicher Assistent."
- Kurze Beschreibung was S.A.R.A.H. kann
- Button: "Los geht's"

**Besonderheit:** Dieser Schritt ist animiert — Text baut sich auf, Sarah "spricht".

---

### Schritt 2: System-Scan

**Zweck:** Automatische Erkennung der System-Umgebung. User muss nichts eingeben.

**Automatisch erkannt:**
- Betriebssystem + Version (z.B. Windows 10 Pro 10.0.19045)
- Shell (z.B. PowerShell, CMD, Git Bash)
- CPU-Modell + Kerne
- GPU-Modell
- RAM (gesamt)
- Speicherplatz (gesamt / frei)
- Bildschirmauflösung
- Netzwerk-Status

**Darstellung:**
- Animierter Scan-Vorgang (Progress-Bar + nacheinander erscheinende Ergebnisse)
- Ergebnisse in `sarah-card`-Komponenten
- Futuristischer Look: Daten erscheinen wie ein HUD-Scan
- Button: "Weiter"

---

### Schritt 3: Profil

**Zweck:** Persönliche Daten für die Personalisierung.

**Formularfelder:**
| Feld | Typ | Pflicht | Hinweis |
|---|---|---|---|
| Anzeigename | `sarah-input` (text) | Ja | "Wie soll ich dich nennen?" |
| Stadt / Region | `sarah-input` (text) | Nein | Für Wetter, lokale Infos |
| Sprache | `sarah-select` | Ja | Deutsch, English, etc. |
| Zeitzone | `sarah-select` | Ja | Auto-detected, änderbar |

**Vorlesefunktion:** Optional, Button "Lies mir vor" spielt TTS ab.

---

### Schritt 4: Personalisierung

**Zweck:** Visuelle und akustische Einstellungen.

**Formularfelder:**
| Feld | Typ | Pflicht | Hinweis |
|---|---|---|---|
| Akzentfarbe | `sarah-color-picker` | Nein | Default: Cyan. Überschreibt `--sarah-accent-*` |
| Sarah's Stimme | `sarah-select` + Preview | Nein | Auswahl mit Hörprobe |
| Sprachgeschwindigkeit | Slider | Nein | Langsam ↔ Schnell |

**Hinweis:** Dies ist die erste Konfiguration. Erweiterte Einstellungen kommen später in den Settings-Bereich.

---

### Schritt 5: Fertig

**Zweck:** Zusammenfassung und Abschluss.

**Inhalt:**
- Zusammenfassung aller gewählten Einstellungen
- "Alles korrekt?"-Bestätigung
- Button "Zurück" um einzelne Schritte zu korrigieren
- Button "S.A.R.A.H. starten" → setzt `setupComplete`-Flag, lädt Persona/Dashboard

---

## 6. Datenfluss

```
Wizard-Formulare
      │
      ▼
  Config-Datei (JSON)          ← z.B. userData/config.json
      │
      ▼
  Main Process liest Config
      │
      ▼
  App startet mit Persona      (wenn setupComplete === true)
  App startet mit Wizard       (wenn setupComplete === false)
```

**Config-Struktur (Beispiel):**
```json
{
  "setupComplete": true,
  "system": {
    "os": "Windows 10 Pro",
    "shell": "PowerShell",
    "cpu": "AMD Ryzen 7 5800X",
    "gpu": "NVIDIA RTX 3070",
    "ram": "32GB"
  },
  "profile": {
    "displayName": "Martin",
    "city": "Berlin",
    "language": "de",
    "timezone": "Europe/Berlin"
  },
  "personalization": {
    "accentColor": "#00d4ff",
    "voice": "default-female-de",
    "speechRate": 1.0
  }
}
```

---

## 7. Technische Entscheidungen

| Entscheidung | Wahl | Begründung |
|---|---|---|
| UI-Framework | Keines (Vanilla TS) | Kein unnötiger Ballast, 90% der App ist Voice/Persona |
| Komponenten | Web Components + Factory | Deklarativ im HTML, programmatisch in JS |
| Styling | CSS Custom Properties | Einfach überschreibbar für User-Themes |
| Build | `tsc` (bestehend) | Kein Bundler nötig, Electron lädt direkt |
| Config-Speicher | JSON-Datei (Electron `userData`) | Einfach, portabel, kein DB nötig |
| Persona im Wizard | Platzhalter/Animation | 3D-Persona ist separates Teilprojekt |

---

## 8. Abgrenzung (Out of Scope)

Folgende Themen sind **nicht** Teil dieses Specs und werden als separate Teilprojekte behandelt:

- 3D Sarah-Persona (Level 4)
- Dashboard mit System-Widgets
- Voice-Steuerung / Wake-Word
- LLM-Integration
- Chat-Interface
- E-Mail / Web-Recherche
- Memory-System
- Settings-Bereich (erweitert)
