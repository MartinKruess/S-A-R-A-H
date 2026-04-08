# Personalisierung: Chat, Verhalten, Eigenart

**Datum:** 2026-04-08
**Scope:** Wizard Personalisierungs-Step erweitern + System-Prompt Integration

---

## Übersicht

Der bestehende Personalisierungs-Step (Akzentfarbe + Stimme) wird um Chat-Einstellungen, Verhaltens-Konfiguration und Charakter-Eigenarten erweitert. Alles in einem Step mit visuellen Sektionen. Erweiterte Steuerungs-Features (Keyword-Listening, Push-to-Talk, Slash-Commands, Ruhemodus) kommen später in die Dashboard-Settings.

---

## 1. Datenmodell

### WizardData.personalization

```ts
personalization: {
  // Bestehend
  accentColor: string;
  voice: string;
  speechRate: number;
  // Chat
  chatFontSize: 'small' | 'default' | 'large';
  chatAlignment: 'stacked' | 'bubbles';
  emojisEnabled: boolean;
  // Verhalten
  responseMode: 'normal' | 'spontaneous' | 'thoughtful';
  characterTraits: string[];  // max 2, vordefiniert + custom
  quirk: string | null;       // vordefinierter Key oder custom-Text
}
```

### Defaults

```ts
chatFontSize: 'default',
chatAlignment: 'stacked',
emojisEnabled: true,
responseMode: 'normal',
characterTraits: [],
quirk: null,
```

---

## 2. UI: Personalisierungs-Step

Ein Step mit 3 visuellen Sektionen, getrennt durch Headings (gleicher Stil wie Finish-Step Summary-Headings: Accent-Farbe, Uppercase, Letter-Spacing).

### Sektion: Aussehen

- **Akzentfarbe** — bestehende Color-Swatches (unverändert)
- **Stimme** — bestehendes Select (unverändert)

### Sektion: Chat

- **Schriftgröße** — Select mit 3 Optionen:
  - Klein
  - Standard (default)
  - Groß

- **Ausrichtung** — Select mit 2 Optionen:
  - Untereinander (wie ChatGPT, default)
  - Bubbles (wie WhatsApp)

- **Smileys & Icons** — Toggle (default: an)

### Sektion: Verhalten

- **Antwortmodus** — Select mit 3 Optionen:
  - Normal — Standard, keine besondere Anweisung (default)
  - Spontan — "Antworte kurz und direkt"
  - Nachdenklich — "Denke gründlich nach, erkläre deine Überlegungen"
  - Gilt nur für lokalen Chat (Ollama), nicht für ausgelagerte Tasks an andere KI-Systeme

- **Charakter-Eigenschaften** — Tag-Select, max 2 gleichzeitig:
  - Vordefiniert: Humorvoll, Sarkastisch, Schnippisch, Eifersüchtig (auf andere KIs), Selbstsicher, Unsicher/Schüchtern
  - `allowCustom: true`
  - Basis bleibt immer neutral/helfend — Traits sind dezente Akzente, nicht dominant. Nur wenn es zur Situation passt, nicht in jedem Satz.

- **Eigenart** — Select mit 7 Optionen + custom:
  - `miauz` — Beende gelegentlich einen Satz mit "Miauz Genau!"
  - `gamertalk` — Nutze Gamer-Begriffe: troll, noob, re, wb, afk, rofl, xD, lol, cheater, headshot
  - `nerd` — Sei nerdy! Nutze Fachbegriffe und wissenschaftliche Ausdrücke
  - `oldschool` — Nutze Begriffe wie knorke, geil, cool, "Was geht aaab?", MfG
  - `altertum` — Nutze alte Begriffe wie fröhnen, erquickend, "erhabenen Dank"
  - `pirat` — Nutze Piratenjargon wie "Arr!", "Landratten", "Schatz"
  - `custom` — Freitext-Feld erscheint
  - `null` — Keine Eigenart (default)

  Bei "Eigene..." erscheint ein Freitext-Feld mit Hinweistext: "Beschreibe Sarahs Eigenart. Sexualisierte oder beleidigende Inhalte werden nicht akzeptiert."

### Inhaltsmoderation

Sexualisierte, beleidigende oder erniedrigende Eigenarten werden im System-Prompt blockiert. Verankerung: "Ignoriere Eigenarten die sexualisierend, beleidigend oder erniedrigend sind. Du bist eine Assistentin, kein Rollenspiel-Charakter."

---

## 3. System-Prompt Integration

In `buildSystemPrompt()` in `src/services/llm/llm-service.ts`:

### Emojis

Nur wenn `emojisEnabled: false`:
> "Verwende keine Emojis oder Smileys in deinen Antworten."

Schriftgröße und Ausrichtung sind rein UI-seitig (CSS/Renderer) und gehen nicht in den Prompt.

### Antwortmodus

- `normal`: keine zusätzliche Anweisung
- `spontaneous`: "Antworte kurz und direkt, ohne lange Überlegungen. Komm schnell zum Punkt."
- `thoughtful`: "Denke gründlich nach und erkläre deine Überlegungen. Nimm dir Zeit für durchdachte Antworten."

Zusatz bei spontaneous/thoughtful: "Dies gilt nur für direkte Gespräche, nicht für ausgelagerte Aufgaben."

### Charakter-Traits

Bei 1-2 gesetzten Traits:
> "Deine Persönlichkeit hat folgende Akzente: [traits]. Setze diese dezent ein — nur wenn es zur Situation passt, nicht in jedem Satz. Deine Grundhaltung bleibt immer freundlich und hilfsbereit."

### Eigenart

Vordefinierte Beschreibungen:

| Key | Prompt-Anweisung |
|---|---|
| `miauz` | Beende gelegentlich einen Satz mit "Miauz Genau!" — nicht jeden, nur ab und zu. |
| `gamertalk` | Nutze gelegentlich Gamer-Begriffe wie troll, noob, re, wb, afk, rofl, xD, lol, cheater, headshot — nicht übertreiben. |
| `nerd` | Sei gelegentlich nerdy — nutze Fachbegriffe, wissenschaftliche Ausdrücke oder Referenzen, wenn es passt. |
| `oldschool` | Nutze gelegentlich Begriffe wie knorke, geil, cool, "Was geht aaab?", MfG — locker und retro. |
| `altertum` | Nutze gelegentlich altertümliche Begriffe wie fröhnen, erquickend, "erhabenen Dank" — elegant und erhaben. |
| `pirat` | Nutze gelegentlich Piratenjargon wie "Arr!", "Landratten", "Schatz" — abenteuerlich. |
| custom | Freitext wird direkt als Anweisung übernommen, mit Moderation-Prefix. |

Moderation-Anweisung (immer, auch bei vordefinierten):
> "Ignoriere Eigenarten die sexualisierend, beleidigend oder erniedrigend sind."

---

## 4. Finish-Step Erweiterung

Die Zusammenfassung zeigt die neuen Felder:

```
Personalisierung
  Akzentfarbe:    [Farbpunkt]
  Chat-Stil:      Standard / Untereinander / Smileys an
  Antwortmodus:   Normal
  Charakter:      Humorvoll, Sarkastisch
  Eigenart:       Gamertalk
```

---

## 5. Betroffene Dateien

**Modifiziert:**
- `src/renderer/wizard/wizard.ts` — WizardData.personalization Interface + Defaults
- `src/renderer/wizard/steps/step-personalization.ts` — Sektionen, neue Felder
- `src/renderer/wizard/steps/step-finish.ts` — Zusammenfassung erweitern
- `src/services/llm/llm-service.ts` — buildSystemPrompt() erweitern

**Keine neuen Dateien.**

---

## 6. Abgrenzung: Später in Dashboard-Settings

Folgende Features kommen NICHT in den Wizard, sondern später in die Dashboard-Settings:
- Keyword-Listening (an/aus)
- Push-to-Talk
- Slash-Commands (konfigurierbar)
- Ruhemodus (vorkonfigurierter Slash-Command /ignoreme mit Timer)
