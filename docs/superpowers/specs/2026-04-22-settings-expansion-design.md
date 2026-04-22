# Settings-Erweiterung — Design

## Kontext

Die Settings-Ansicht ist nach dem Tab-Refactor (2026-04-22) auf 5 Tabs aufgeteilt. Profil und Verwaltung brauchen jetzt inhaltliche Erweiterungen:

- **Profil:** Optional-Kennzeichnung bestehender Felder, neue optionale Felder (PLZ, Geburtsdatum, E-Mail), Abo-Block und eine Linksammlung („bevorzugte Quellen" für Sarah).
- **Verwaltung:** Program-Picker aus dem Wizard wiederverwenden, damit der User seine Programm-Auswahl auch außerhalb des Wizards pflegen kann.

Bedienung und Sicherheit bleiben ausgeklammert — dafür folgen separate Specs.

## Ziele

- Profil-Felder erkennbar als Pflicht / Optional.
- Neue optionale Profil-Felder im Schema + UI: `postalCode`, `birthday`, `email`.
- Abo-Block im Profil: Statusanzeige + Button zu externer URL (Platzhalter `https://sarah.ai/pricing`).
- Linksammlung im Profil: beliebig viele Einträge `{ description, url }`, wird vom LLM als semantischer Präferenz-Hinweis genutzt.
- Program-Picker in Verwaltung: gleiche UI wie im Wizard, geshared aus `src/renderer/shared/`.

## Nicht-Ziele

- Kein Ausbau der Sicherheit-Tab (eigener Spec).
- Kein QR-Code-Device-Pairing in Bedienung (später, Platz ist reserviert).
- Kein serverseitiger Abo-Status (V1 hardcoded „Free Tier").
- Kein Tool-Call-Lookup oder RAG/Embedding-Suche für die Linksammlung (V1 bleibt im System-Prompt; Upgrade-Pfad dokumentiert).
- Kein visueller Styling-Angleich an Cockpit (folgt danach in einem eigenen Schritt).

## Schema-Änderungen

`ProfileSchema` in `src/core/config-schema.ts` wird erweitert:

```ts
export const LinkPreferenceSchema = z.object({
  id: z.string(),
  description: z.string().default(''),
  url: z.string().default(''),
});

export const ProfileSchema = z.object({
  displayName: z.string().default(''),
  lastName: z.string().default(''),
  city: z.string().default(''),
  address: z.string().default(''),
  postalCode: z.string().default(''),      // NEU
  birthday: z.string().default(''),         // NEU, ISO YYYY-MM-DD
  email: z.string().default(''),            // NEU
  profession: z.string().default(''),
  activities: z.string().default(''),
  usagePurposes: z.array(z.string()).default([]),
  hobbies: z.array(z.string()).default([]),
  linkPreferences: z.array(LinkPreferenceSchema).default([]),  // NEU
});
```

Alle neuen Felder sind `string().default('')` → bestehende Configs werden ohne Migration beim Laden mit Leerwerten aufgefüllt (Zod-Defaults greifen). Kein separater Migrationspfad nötig.

## Profil-Tab — UI-Aufbau

Reihenfolge von oben nach unten:

1. **Abo-Block** (neu)
2. **Felder-Grid** (Pflicht- + Optional-Felder)
3. **Linksammlung** (neu)

### Abo-Block

Eigener Block über dem Grid. Wiederverwendet `createSectionHeader` für die Überschrift:

```
┌───────────────────────────────────┐
│  Abonnement                       │
│                                   │
│  Free Tier      [Auf Pro upgraden]│
└───────────────────────────────────┘
```

- Titel: „Abonnement"
- Statuszeile links: Textkonstante `'Free Tier'` (V1 hardcoded).
- Button rechts: `sarahButton` (existiert in `src/renderer/components/sarah-button.ts`) mit Label „Auf Pro upgraden".
- Klick → öffnet externe URL via Main-Prozess. Platzhalter `https://sarah.ai/pricing`.

**Neue IPC-Brücke:** `shell.openExternal` gibt's noch nicht im Projekt. Wir ergänzen:

- **Main-IPC-Handler** in `src/main/ipc-config.ts` (oder eigenem `ipc-shell.ts`, je nach Passung): `open-external-url` mit URL-String. Intern `shell.openExternal(url)` aus Electron. Whitelist auf `https:`-Prefix gegen Missbrauch.
- **Preload**: `sarah.openExternalUrl(url: string): Promise<void>`.
- **Renderer-Nutzung** im Abo-Button-Handler.

URL als Konstante in `src/renderer/dashboard/views/sections/profile-section.ts` (oder gemeinsame `constants.ts` wenn mehrere externe URLs dazukommen).

### Felder-Grid

Bestehend:
- Anzeigename (Pflicht, kein Suffix)

Bestehend, Labels erweitert um „(optional)"-Suffix:
- Nachname (optional)
- Stadt (optional)
- Adresse (optional)
- Beruf (optional)

Neu, alle optional:
- PLZ (optional) — `type="text"`, Placeholder ausreichend
- Geburtsdatum (optional) — `type="date"`, Browser liefert Kalender-Widget
- E-Mail (optional) — `type="email"`, Browser validiert Format beim Submit (hier irrelevant da auto-save)

Hobbys bleibt wie gehabt, volle Breite, Label: „Hobbys (optional)".

Kein Refactor von `sarah-input` nötig. Optional-Kennzeichnung erfolgt rein über Label-Text.

### Linksammlung

Block unterhalb des Felder-Grids. Eigener Section-Header („Linksammlung") plus Beschreibungszeile:

> „Hinterlege Webseiten, die Sarah bei passenden Anfragen bevorzugen soll. Beispiel: ‚Hotels buchen' → booking.com."

Pro Eintrag eine Zeile:

```
[Beschreibung-Input───────────] [URL-Input────────] [✕]
```

- Beschreibung: `sarahInput` mit `placeholder="z.B. Hotels und Reisen buchen"`
- URL: `sarahInput` `type="url"` mit `placeholder="https://..."`
- Remove-Button: klein, rechts

Unter der Liste ein `+ Eintrag hinzufügen`-Button, der einen neuen leeren Eintrag mit neuer `id` (crypto.randomUUID()) anhängt.

Speichern bei jedem Change (wie im Rest der Settings): `save('profile', profile)` mit anschließendem `showSaved(feedback)`. Leere Einträge (beide Felder leer) werden beim Save nicht rausgefiltert — User kann sie in Ruhe editieren. Beim Entfernen per ✕ wird der Eintrag hart aus dem Array gelöscht.

## LLM-Integration (V1)

`buildCoreUser` in `src/services/llm/prompt-layers.ts` bekommt einen neuen Absatz, wenn `profile.linkPreferences` nicht leer ist:

```
The user has defined these preferred sources:
- Hotels und Reisen buchen → https://booking.com
- Taxi und Fahrten → https://uber.com
When a query matches one of these descriptions, prefer the corresponding URL.
```

Implementierungsregeln:
- Nur Einträge mit **beiden** Feldern befüllt (`description.trim()` und `url.trim()`) werden ausgegeben. Halbausgefüllte Einträge werden übersprungen.
- Liste ist Teil des bestehenden „Do NOT bring it up unless asked"-Kontexts — Sarah redet nur drüber wenn's passt.
- Upgrade-Pfad: Wenn die Liste > ~20 Einträge wird oder Voice-Latenz spürbar leidet, steigen wir auf Tool-Call-Lookup oder RAG um. Bis dahin kein Overhead.

## Verwaltung-Tab — Program-Picker

### Refactor

1. **Umzug:** `src/renderer/wizard/program-detection.ts` → `src/renderer/shared/program-detection.ts`. Pfad-Imports im Wizard anpassen.
2. **Neuer shared UI-Helper:** `src/renderer/shared/program-picker.ts` mit Signatur:
   ```ts
   export interface ProgramPickerProps {
     initialSelected: string[];
     onChange: (entries: ProgramEntry[]) => void;
     includeFolderScanners?: boolean;          // Default: false
     initialExtraFolder?: string;              // nur relevant wenn includeFolderScanners=true
     initialGamesFolder?: string;              // nur relevant wenn includeFolderScanners=true
     showGamesFolder?: boolean;                // nur relevant wenn includeFolderScanners=true
     onFolderChange?: (kind: 'extra' | 'games', path: string) => void;
   }
   export function createProgramPicker(props: ProgramPickerProps): HTMLElement;
   ```
   Kapselt:
   - Initialen `detectPrograms()`-IPC-Call
   - `sarahTagSelect` mit `allowCustom: true`
   - Wenn `includeFolderScanners=true`: zusätzlich `sarahPathPicker` für Extra-Ordner und (bei `showGamesFolder=true`) Games-Ordner mit `scanFolderExes`-Rescan
   - Internal State (kein Module-Level-Singleton)

3. **Wizard-Refactor:** `src/renderer/wizard/steps/step-files.ts` ruft `createProgramPicker({ includeFolderScanners: true, showGamesFolder: <Gaming-Flag>, ... })` statt die Logik inline zu halten. Bestehende Felder (PDF-Block etc.) bleiben unverändert.

### Settings-Nutzung

In `src/renderer/dashboard/views/sections/files-section.ts` kommt der Picker **über** den Pfad-Pickern und PDFs:

```
├── Programme        ← NEU: createProgramPicker({ includeFolderScanners: false, ... })
├── Pfade (bestehend: Bilder, Installations, Games, Extra, Projekte)
└── PDF-Kategorien   (bestehend)
```

- `initialSelected`: `config.resources.programs.map(p => p.name)`
- `onChange`: `(entries) => { resources.programs = entries; save('resources', resources); showSaved(feedback); }`
- `includeFolderScanners: false` → kein zusätzlicher Ordner-Input. Die Ordner-Inputs bleiben bei den bestehenden Settings-Pfad-Pickern weiter unten, sodass keine UI-Dopplung entsteht. Scans aus Settings heraus sind out of scope für V1.

## Datei-Struktur

```
src/core/
├── config-schema.ts               (+ LinkPreferenceSchema, + postalCode/birthday/email/linkPreferences)
src/main/
├── ipc-config.ts                  (+ open-external-url Handler, oder eigene ipc-shell.ts)
src/preload.ts                     (+ openExternalUrl)
src/services/llm/
├── prompt-layers.ts               (buildCoreUser: + linkPreferences-Block)
src/renderer/
├── shared/
│   ├── program-detection.ts       (UMZUG aus wizard/)
│   └── program-picker.ts          (NEU)
├── wizard/steps/
│   └── step-files.ts              (nutzt program-picker)
├── dashboard/views/sections/
│   ├── profile-section.ts         (Abo-Block, Optional-Labels, neue Felder, Linksammlung)
│   └── files-section.ts           (+ program-picker am Anfang)
styles/dashboard.css               (evtl. Regeln für Abo-Block + Linksammlung-Zeile)
```

## Tests

- **`config-schema.test.ts`** (falls bestehend; sonst neu angelegt): LinkPreferenceSchema lädt leere und befüllte Einträge korrekt, Defaults greifen.
- **`program-picker.test.ts`** (neu): rendert `sarahTagSelect`, feuert `onChange` mit Namen + ProgramEntries, initial-selected wird übernommen.
- **`prompt-layers.test.ts`** (falls vorhanden, sonst Unit-Test im Prompt-Builder-Umfeld): `buildCoreUser` hängt Linkpräferenzen an wenn vorhanden, lässt weg wenn leer, überspringt halbausgefüllte Einträge.

Bestehende Tests (`sarah-tabs-logic.test.ts` etc.) bleiben unberührt.

## Sicherheits- und Validierungsaspekte

- **`openExternalUrl`-IPC-Handler** validiert die URL strikt: muss mit `https://` beginnen (kein `file://`, `javascript:`, `chrome://`). Alternativ `new URL(url)` + Whitelist-Protokoll-Check. Andere Aufrufe werfen.
- **Linksammlung-URL-Feld** validiert nicht (beliebiger Text wird akzeptiert und gespeichert). Der LLM-Prompt-Builder gibt leere/kaputte URLs trotzdem an Sarah weiter — das LLM ignoriert Unsinn von selbst. Wenn sich später Missbrauch zeigt, URL-Validierung im Save-Pfad nachrüsten.
- **E-Mail-Feld** validiert clientseitig nicht hart. `type="email"` gibt Browser-Hint, aber Auto-Save umgeht Submit-Validierung. Für V1 ausreichend, da das Feld nur lokal in der Config landet.

## Offene Fragen

Keine. Alle offenen Punkte aus dem Brainstorming sind entweder entschieden (Matching-Strategie V1, Abo-URL, Picker-Reuse) oder explizit ausgeklammert (Security-Tab, QR-Code, Server-Abo).
