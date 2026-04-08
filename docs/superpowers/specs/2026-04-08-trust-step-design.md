# Trust-Step: Datenschutz, Gedächtnis, Kontrolle, Befehle

**Datum:** 2026-04-08
**Scope:** Wizard Trust-Step erweitern + System-Prompt Integration

---

## Übersicht

Der bestehende Trust-Step (Memory-Toggle + Dateizugriff) wird erweitert um:
1. Korrigierten Datenschutz-Hinweis (ehrlich bzgl. externer Dienste)
2. Gedächtnis-Ausnahmen (was Sarah sich nicht merken soll)
3. Bestätigungslevel (wie oft Sarah nachfragen soll)
4. Slash-Commands `/showcontext` und `/anonymous`

---

## 1. Datenmodell

### WizardData.trust

```ts
trust: {
  memoryAllowed: boolean;                                   // bestehend
  fileAccess: string;                                       // bestehend: 'all' | 'specific-folders' | 'none'
  confirmationLevel: 'minimal' | 'standard' | 'maximal';   // NEU
  memoryExclusions: string[];                               // NEU
  anonymousEnabled: boolean;                                // NEU
  showContextEnabled: boolean;                              // NEU
};
```

### Defaults

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

---

## 2. UI: Trust-Step mit Sektionen

Der Step bekommt visuelle Sektionen mit Headings (gleicher Stil wie Personalisierung).

### Sektion: Datenschutz

Info-Box (kein Eingabefeld) mit korrigiertem Text:

> "Deine Daten werden lokal auf deinem Computer gespeichert. Wenn du externe KI-Dienste nutzt (z.B. Cloud-Modelle), werden Gesprächsinhalte zur Verarbeitung an diese Anbieter gesendet — aber nicht dort gespeichert. Bei rein lokalem Betrieb (Ollama) verlassen keine Daten deinen Computer."

### Sektion: Gedächtnis

- **Toggle "Darf ich mir Dinge merken?"** (bestehend, `memoryAllowed`)

- **Hinweistext** (immer sichtbar): "Sarah merkt sich dein Verhalten und Muster, aber niemals Passwörter, Bank- oder Versicherungsdaten."

- **Tag-Select "Was soll Sarah sich nicht merken?"** (nur sichtbar wenn `memoryAllowed: true`)
  - Vordefinierte Tags:
    - Browser-Daten — keine Browsing-History, Lesezeichen etc.
    - Namen Dritter — erwähnte Personen nicht speichern
    - Gesundheit — keine gesundheitsbezogenen Infos
    - Finanzen — keine Kontostände, Gehalt etc.
  - `allowCustom: true`
  - Schreibt in `trust.memoryExclusions`

### Sektion: Zugriff

- **Select "Darf ich Dateien analysieren?"** (bestehend, `fileAccess`)
  - Optionen: Ja, alle Dateien / Nur bestimmte Ordner / Nein, keinen Zugriff
  - Bei "Nur bestimmte Ordner": Hinweistext darunter: "Sarah nutzt die Ordner die du unter Dateien & Apps angegeben hast (Bilder, PDFs, Projekte etc.)."

### Sektion: Kontrolle

- **Select "Bestätigungen"** (`confirmationLevel`)
  - Minimal — "Nur bei kritischen Aktionen (bezahlen, löschen, buchen)"
  - Standard — "Sarah fragt nach wenn es sinnvoll erscheint" (default)
  - Maximal — "Bei jeder Aktion die etwas verändert"

### Sektion: Befehle

- **Toggle `/showcontext`** (`showContextEnabled`, default: an)
  - Label: "Kontext einsehen"
  - Description: "Mit /showcontext zeigt Sarah dir alles was sie über dich weiß"

- **Toggle `/anonymous`** (`anonymousEnabled`, default: an)
  - Label: "Vertrauliche Nachrichten"
  - Description: "Mit /anonymous wird eine Nachricht nach der Session vergessen — Sarah reagiert darauf, merkt es sich aber nicht langfristig"

---

## 3. System-Prompt Integration

In `buildSystemPrompt()` in `src/services/llm/llm-service.ts`:

### Bestätigungslevel

```
minimal: "Frage nur bei kritischen Aktionen nach Bestätigung: Bezahlen, Löschen, Buchen. Alles andere darfst du eigenständig ausführen."
standard: "Frage nach Bestätigung wenn du dir unsicher bist oder eine Aktion Konsequenzen hat die schwer rückgängig zu machen sind. Bei harmlosen Aktionen handle eigenständig."
maximal: "Frage bei jeder Aktion die etwas verändert nach Bestätigung, bevor du sie ausführst. Der User möchte volle Kontrolle."
```

### Gedächtnis-Ausnahmen

Bei gesetzten `memoryExclusions`:
> "Merke dir nichts zu folgenden Themen: [exclusions]. Informationen dazu darfst du im Gespräch verwenden, aber nicht langfristig speichern."

### /anonymous Handling

Logik (nicht im Prompt, sondern im Chat-System):
- Nachricht mit `/anonymous` Prefix wird normal an das LLM gesendet (ohne den Prefix)
- Sarah antwortet ganz normal darauf im Gesprächskontext
- Beim Session-Ende werden `/anonymous`-Nachrichten und ihre Antworten aus der DB gelöscht
- Sie fließen nicht ins Nutzerprofil oder Lernverhalten ein

Im System-Prompt nur der Hinweis (wenn `anonymousEnabled`):
> "Der User kann /anonymous vor eine Nachricht setzen. Reagiere normal darauf, aber die Nachricht wird nach der Session vergessen."

### /showcontext Handling

Logik (im Chat-System, nicht im Prompt):
- Wenn User `/showcontext` eingibt, gibt Sarah den aktuell gebauten System-Prompt + gespeicherte Nutzerdaten aus
- Kein LLM-Call nötig — reine Datenausgabe

---

## 4. Finish-Step Erweiterung

Die Trust-Zusammenfassung zeigt:

```
Vertrauen
  Memory:           Erlaubt
  Ausnahmen:        Browser-Daten, Namen Dritter
  Dateizugriff:     Nur bestimmte Ordner
  Bestätigungen:    Standard
  /showcontext:     Aktiv
  /anonymous:       Aktiv
```

---

## 5. Betroffene Dateien

**Modifiziert:**
- `src/renderer/wizard/wizard.ts` — WizardData.trust Interface + Defaults
- `src/renderer/wizard/steps/step-trust.ts` — Sektionen, neue Felder
- `src/renderer/wizard/steps/step-finish.ts` — Trust-Zusammenfassung erweitern
- `src/services/llm/llm-service.ts` — buildSystemPrompt() erweitern

**Keine neuen Dateien.** Die /anonymous und /showcontext Logik im Chat-System kommt in einem späteren Task — hier wird nur die Config gesetzt.
