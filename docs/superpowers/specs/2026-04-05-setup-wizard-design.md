# S.A.R.A.H. — Setup-Wizard Design Spec

> Smart Assistant for Resource and Administration Handling
> Erster Baustein: Einrichtungsassistent (Setup-Wizard)

---

## 1. Überblick

Der Setup-Wizard ist der erste Screen nach dem Splash und läuft **einmalig** beim allerersten Start der App. Er sammelt System-Informationen und User-Präferenzen, damit S.A.R.A.H. personalisiert arbeiten kann.

Nach Abschluss des Wizards wird ein Flag gesetzt (z.B. in einer lokalen Config-Datei), sodass beim nächsten Start direkt die Sarah-Persona geladen wird.

**Datenquelle:** `docs/forms/setup-wizard-forms.md` definiert alle Formularfelder.

**Design-Regel:** Frage nur das, was der Assistent nicht selbst erkennen kann.

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
  components.css      ← Shared Component Styles
  wizard.css          ← Wizard-spezifische Layouts (Stepper, Slides)
  dashboard.css       ← Dashboard-spezifisch (später)
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
const form = sarahForm({ children: [
  sarahInput({ label: 'Name', required: true }),
  sarahInput({ label: 'Stadt' }),
  sarahButton({ label: 'Weiter', variant: 'primary' }),
]})
```

### 3.3 Komponenten für den Wizard

| Komponente | Beschreibung | Status |
|---|---|---|
| `sarah-button` | Primary, Secondary, Ghost-Varianten | ✅ Gebaut |
| `sarah-input` | Text-Input mit Label, Validation, Glow-Fokus | ✅ Gebaut |
| `sarah-select` | Dropdown/Select | ✅ Gebaut |
| `sarah-form` | Form-Wrapper (Fieldset, Layout, Submission) | ✅ Gebaut |
| `sarah-stepper` | Vertikale Timeline-Navigation | ✅ Gebaut |
| `sarah-slide` | Fullscreen-Slide-Container | ✅ Gebaut |
| `sarah-card` | Info-Karte (z.B. für System-Scan Ergebnisse) | ✅ Gebaut |
| `sarah-progress` | Progress-Bar (z.B. für System-Scan) | ✅ Gebaut |
| `sarah-tag-select` | Klickbare Badges mit optionalem Input für eigene Tags | 🔲 Neu |
| `sarah-toggle` | Toggle/Switch (z.B. für Memory erlauben) | 🔲 Neu |
| `sarah-path-picker` | Ordner-/Datei-Auswahl via Electron Dialog | 🔲 Neu |

### 3.4 Dateistruktur

```
src/renderer/
  components/
    base.ts
    sarah-button.ts
    sarah-input.ts
    sarah-select.ts
    sarah-form.ts
    sarah-stepper.ts
    sarah-slide.ts
    sarah-card.ts
    sarah-progress.ts
    sarah-tag-select.ts      ← NEU
    sarah-toggle.ts           ← NEU
    sarah-path-picker.ts      ← NEU
    index.ts
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
│  ○ Pflichtfelder      │     Fullscreen-Bereich    │
│  │                    │     für den aktuellen     │
│  ○ Persönliches       │     Schritt               │
│  │                    │                           │
│  ○ Vertiefung         │                           │
│  │                    │                           │
│  ○ Dateien & Apps     │                           │
│  │                    │                           │
│  ○ Vertrauen          │                           │
│  │                    │                           │
│  ○ Personalisierung   │                           │
│  │                    │                           │
│  ○ Fertig             │                           │
│                       │                           │
└──────────────────────────────────────────────────┘
```

- **Links:** Vertikale Stepper-Timeline (~220px breit)
  - Erledigte Schritte: Check-Icon + Glow
  - Aktiver Schritt: Leuchtend, pulsierender Glow
  - Offene Schritte: Gedimmt
  - Übersprungene optionale Schritte: Gedimmt mit Skip-Markierung
- **Rechts:** Fullscreen-Slide für den aktuellen Schritt
- **Slide-Transitions:** Smooth Fade oder Slide-Up zwischen Schritten
- **Navigation:** Vor/Zurück-Buttons im Slide-Bereich unten
- **Optionale Schritte:** Zeigen "Weiter mit [Thema]" und "Überspringen" Buttons

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
| Feld | Anzeige im UI | Beispiel | Zweck |
|---|---|---|---|
| Betriebssystem | Windows erkannt | Windows 11 | Commands |
| Sprache | Systemsprache erkannt | Deutsch | Antwortsprache |
| Zeitzone | Automatisch erkannt | Europe/Berlin | Zeitlogik |
| Shell | Standard-Konsole erkannt | PowerShell | Execution |
| CPU | Prozessor erkannt | AMD Ryzen 7 5800X | System-Info |
| RAM | Arbeitsspeicher erkannt | 32 GB | System-Info |
| Standardordner | Dokumente gefunden | C:\Users\...\Documents | Filezugriff |
| Downloads | Download-Ordner erkannt | C:\Users\...\Downloads | Automationen |
| Bilder | Bilderordner erkannt | C:\Users\...\Pictures | Sortierung |
| Desktop | Desktop erkannt | C:\Users\...\Desktop | Zugriff |
| Installierte Programme | Apps erkannt | Chrome, Word, VS Code | Integration |

**Darstellung:**
- Animierter Scan-Vorgang (Progress-Bar + nacheinander erscheinende Ergebnisse)
- Ergebnisse in `sarah-card`-Komponenten
- Futuristischer Look: Daten erscheinen wie ein HUD-Scan
- Button: "Weiter"

---

### Schritt 3: Pflichtfelder

**Zweck:** Die wichtigsten persönlichen Daten, ohne die S.A.R.A.H. nicht sinnvoll arbeiten kann.

**Formularfelder:**
| Feld | Frage im UI | Typ | Pflicht | Beispiel | Zweck |
|---|---|---|---|---|---|
| Anzeigename | Wie soll ich dich nennen? | `sarah-input` (text) | Ja | Martin | Ansprache im System |
| Stadt | In welcher Stadt bist du? | `sarah-input` (text) | Ja | Hamburg | Lokale Infos (Wetter, Orte) |
| Verwendungszwecke | Wobei soll ich dir helfen? | `sarah-tag-select` | Ja | Dateien, Organisation, Code | Kernfunktion steuern |

**Verwendungszwecke — Vordefinierte Badges:**
- 📁 Dateien
- 📋 Organisation
- 💻 Programmieren
- 🎨 Design / Bildbearbeitung
- 📧 E-Mail
- 🌐 Web / Recherche
- 📊 Office
- 🎮 Gaming
- ➕ Eigenen Bereich hinzufügen (Input-Feld)

**Navigation:** Nur "Weiter" (kein Überspringen — alle Felder sind Pflicht)

---

### Schritt 4: Persönliches (Optional)

**Zweck:** Zusätzliche persönliche Infos für bessere Personalisierung.

**Intro:** "Ich kann dich besser unterstützen, wenn ich mehr über dich weiß. Du kannst diesen Schritt auch überspringen."

**Formularfelder:**
| Feld | Frage im UI | Typ | Beispiel | Zweck |
|---|---|---|---|---|
| Nachname | Möchtest du deinen Nachnamen angeben? | `sarah-input` (text) | Mustermann | Dokumente / Formalität |
| Adresse | Möchtest du deine Adresse speichern? | `sarah-input` (text) | Musterstraße 1 | Selten benötigt |
| Hobbys | Was sind deine Interessen? | `sarah-tag-select` | Fitness, Coding, Musik | Personalisierung |
| Beruf | Was machst du beruflich? | `sarah-input` (text) | Entwickler | Kontext |
| Tätigkeiten | Was machst du häufig? | `sarah-input` (text) | Rechnungen, Planung | Bessere Vorschläge |
| Antwortstil | Wie soll ich antworten? | `sarah-select` | kurz / mittel / ausführlich | UX |
| Tonfall | Wie soll ich klingen? | `sarah-select` | direkt / freundlich / professionell | UX |

**Navigation:** "Weiter mit Vertiefung" + "Überspringen"

---

### Schritt 5: Dynamische Vertiefung (Bedingt)

**Zweck:** Zusatzfragen basierend auf den gewählten Verwendungszwecken aus Schritt 3.

**Wird nur angezeigt, wenn relevante Verwendungszwecke gewählt wurden.**

| Bedingung | Zusatzfrage | Typ | Beispiel |
|---|---|---|---|
| "Programmieren" gewählt | Wie ist dein Level? | `sarah-select` | Anfänger / Mittel / Fortgeschritten / Profi |
| "Design / Bildbearbeitung" gewählt | Wie gut kennst du dich aus? | `sarah-select` | Anfänger / Mittel / Fortgeschritten |
| "Office" gewählt | Wie sicher bist du mit Office? | `sarah-select` | Anfänger / Mittel / Fortgeschritten |

**Wenn keine dynamischen Fragen zutreffen:** Schritt wird automatisch übersprungen.

**Navigation:** "Weiter" (kein Überspringen, da bereits gefiltert)

---

### Schritt 6: Dateien & Programme (Optional)

**Zweck:** Erweiterte Konfiguration für Datei- und Programm-Zugriff.

**Intro:** "Damit ich dir besser helfen kann, zeig mir wo deine wichtigen Dateien liegen. Du kannst das auch später einstellen."

**Formularfelder:**
| Feld | Frage im UI | Typ | Beispiel | Zweck |
|---|---|---|---|---|
| E-Mails | Möchtest du E-Mail-Konten hinterlegen? | Liste (Inputs) | Arbeit / Privat | Zuordnung |
| Wichtige Programme | Welche Programme nutzt du oft? | `sarah-tag-select` | Word, VS Code, Chrome | Automationen |
| Bevorzugte Links | Gibt es Seiten, die du oft nutzt? | Liste (Inputs) | Gmail, Drive, GitHub | Quick Access |
| Wichtige Ordner | Welche Ordner sind wichtig? | `sarah-path-picker` | D:\Dokumente | File-Handling |
| PDF-Ablage | Wo speicherst du PDFs? | `sarah-path-picker` | D:\PDF | Automatisierung |
| Bilderordner | Wo liegen deine Bilder? | `sarah-path-picker` | D:\Bilder | Sortierung |
| Installationsordner | Wo installierst du Programme? | `sarah-path-picker` | D:\Apps | Systemsteuerung |

**Hinweis:** Einige Ordner werden in Schritt 2 (System-Scan) automatisch erkannt und hier vorausgefüllt.

**Navigation:** "Weiter mit Vertrauen & Kontrolle" + "Überspringen"

---

### Schritt 7: Vertrauen & Kontrolle

**Zweck:** Berechtigungen und Datenschutz-Einstellungen.

**Formularfelder:**
| Feld | Frage im UI | Typ | Beispiel | Zweck |
|---|---|---|---|---|
| Speicher erlauben | Darf ich mir Dinge merken? | `sarah-toggle` | Ja / Nein | Memory-System |
| Datei-Zugriff | Darf ich Dateien analysieren? | `sarah-select` | Alle / Nur bestimmte Ordner / Nein | Sicherheit |

**Hinweis-Text:** "Alle Daten werden ausschließlich lokal auf deinem Computer gespeichert. Nichts wird ins Internet gesendet."

**Navigation:** "Weiter" (nicht überspringbar — Vertrauen muss explizit gesetzt werden)

---

### Schritt 8: Personalisierung

**Zweck:** Visuelle und akustische Einstellungen.

**Formularfelder:**
| Feld | Typ | Pflicht | Hinweis |
|---|---|---|---|
| Akzentfarbe | Farbswatches (8 Farben) | Nein | Default: Cyan. Live-Preview |
| Sarah's Stimme | `sarah-select` + Preview | Nein | Auswahl mit Hörprobe |
| Sprachgeschwindigkeit | Slider | Nein | Langsam ↔ Schnell |

**Navigation:** "Weiter"

---

### Schritt 9: Fertig

**Zweck:** Zusammenfassung und Abschluss.

**Inhalt:**
- Zusammenfassung aller gewählten Einstellungen (gruppiert nach Schritten)
- Übersprungene Schritte als "Nicht konfiguriert — kannst du jederzeit in den Einstellungen nachholen"
- Button "Zurück" um einzelne Schritte zu korrigieren
- Button "S.A.R.A.H. starten" → setzt `setupComplete`-Flag, lädt Persona/Dashboard

---

## 6. Datenfluss

```
Wizard-Formulare
      │
      ▼
  Config-Datei (JSON)          ← userData/config.json
      │
      ▼
  Main Process liest Config
      │
      ▼
  App startet mit Persona      (wenn setupComplete === true)
  App startet mit Wizard       (wenn setupComplete === false)
```

**Config-Struktur:**
```json
{
  "setupComplete": true,
  "system": {
    "os": "Windows 10 Pro",
    "shell": "PowerShell",
    "cpu": "AMD Ryzen 7 5800X",
    "ram": "32GB",
    "language": "de",
    "timezone": "Europe/Berlin",
    "folders": {
      "documents": "C:\\Users\\Martin\\Documents",
      "downloads": "C:\\Users\\Martin\\Downloads",
      "pictures": "C:\\Users\\Martin\\Pictures",
      "desktop": "C:\\Users\\Martin\\Desktop"
    },
    "installedPrograms": ["Chrome", "VS Code", "Word"]
  },
  "profile": {
    "displayName": "Martin",
    "city": "Hamburg",
    "usagePurposes": ["Dateien", "Programmieren", "Organisation"],
    "lastName": "",
    "address": "",
    "hobbies": ["Fitness", "Coding"],
    "profession": "Entwickler",
    "activities": "Rechnungen, Planung",
    "responseStyle": "kurz",
    "tone": "direkt"
  },
  "skills": {
    "programming": "Fortgeschritten",
    "design": null,
    "office": null
  },
  "files": {
    "emails": [],
    "importantPrograms": ["VS Code", "Chrome"],
    "favoriteLinks": ["github.com"],
    "importantFolders": ["D:\\Projekte"],
    "pdfFolder": "D:\\PDF",
    "picturesFolder": "D:\\Bilder",
    "installFolder": "D:\\Apps"
  },
  "trust": {
    "memoryAllowed": true,
    "fileAccess": "specific-folders"
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
| Ordnerauswahl | Electron `dialog.showOpenDialog` via IPC | Native OS-Dialog |

---

## 8. Abgrenzung (Out of Scope)

Folgende Themen sind **nicht** Teil dieses Specs und werden als separate Teilprojekte behandelt:

- 3D Sarah-Persona (Level 4)
- Dashboard mit System-Widgets
- Voice-Steuerung / Wake-Word
- LLM-Integration
- Chat-Interface
- E-Mail / Web-Recherche
- Memory-System (Implementierung — nur die Erlaubnis wird hier abgefragt)
- Settings-Bereich (erweitert)
