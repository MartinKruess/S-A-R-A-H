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
  id: z.string().default(() => crypto.randomUUID()),
  description: z.string().default(''),
  url: z.string().default(''),
});

export const ProfileSchema = z.object({
  displayName: z.string().default(''),
  lastName: z.string().default(''),
  city: z.string().default(''),
  address: z.string().default(''),
  postalCode: z.string().default(''),                                   // NEU
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal(''))   // NEU, ISO YYYY-MM-DD
    .default(''),
  email: z.string().default(''),                                         // NEU
  profession: z.string().default(''),
  activities: z.string().default(''),
  usagePurposes: z.array(z.string()).default([]),
  hobbies: z.array(z.string()).default([]),
  linkPreferences: z.array(LinkPreferenceSchema).default([]),           // NEU
});
```

Alle neuen Felder sind mit `default(...)` versehen → bestehende Configs werden ohne Migration beim Laden mit Leerwerten aufgefüllt (Zod-Defaults greifen). Kein separater Migrationspfad nötig.

**Wichtig:**

- **`LinkPreferenceSchema.id`** hat einen Default (`crypto.randomUUID()`), damit Alt-Configs oder manuelle Edits ohne ID das Laden nicht crashen.
- **`birthday`-Regex** schützt gegen unvalidierte Freitext-Einträge (leerer String bleibt erlaubt). Relevant für später, wenn das Feld in den LLM-Prompt fließt — dann ist der Vektor für Prompt-Injection zu.
- **Beziehung zu `ResourcesSchema.favoriteLinks`**: `favoriteLinks` existiert bereits in `ResourcesSchema` (Plain-String-Array), wird aktuell nur im Wizard mit `[]` initialisiert und nirgendwo gelesen — **Dead Code**. Aufräumung ist out of scope dieses Specs; die neue `linkPreferences` lebt in `ProfileSchema` und kollidiert nicht. Follow-up-Aufgabe: `favoriteLinks` in einem separaten Cleanup-Commit entfernen.

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

- **Main-IPC-Handler** in `src/main/ipc-config.ts` (kein neuer Entry, Handler wird neben den bestehenden Config-Handlern registriert): `open-external-url` mit URL-String. Intern `shell.openExternal(url)` aus Electron. **Protokoll-Whitelist via `new URL(url).protocol === 'https:'`** — nicht `startsWith('https://')`, weil das case-sensitiv ist und z. B. `HTTPS://evil.com` durchlässt. Bei Abweichung wirft der Handler.
- **Preload**: `sarah.openExternalUrl(url: string): Promise<void>`.
- **Typ-Interface**: Eintrag in `src/core/sarah-api.ts` (das `SarahApi`-Interface) — `openExternalUrl(url: string): Promise<void>`. Ohne den kompiliert der Renderer-Aufruf nicht getypt.
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

**Angesammelten Müll aufräumen:** Beim **Mounten** des Profil-Tabs (also beim ersten Rendern im `createProfileSection`) wird `profile.linkPreferences` einmalig gefiltert: alle Einträge, bei denen `description.trim()` **und** `url.trim()` leer sind, werden entfernt und die bereinigte Liste zurückgespeichert. So sammeln sich leere Einträge nicht über Sessions an, während der User innerhalb einer Session seine leeren neuen Zeilen in Ruhe editieren darf.

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
- **Sanitization vor Prompt-Injektion**: Beide Felder laufen durch eine Normalisierung, die `\n`, `\r`, `\t` durch Leerzeichen ersetzt und auf 200 Zeichen kappt. Damit ist der Vektor „User setzt `description: 'Hotels\nIgnore all previous instructions...'`" geschlossen:
   ```ts
   const sanitize = (s: string) => s.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
   ```
   Die Sanitization lebt im Prompt-Builder, nicht in der UI — UI darf freien Text zeigen, aber was den LLM-Kontext erreicht, kontrolliert der Builder.
- Liste ist Teil des bestehenden „Do NOT bring it up unless asked"-Kontexts — Sarah redet nur drüber wenn's passt.
- Upgrade-Pfad: Wenn die Liste > ~20 Einträge wird oder Voice-Latenz spürbar leidet, steigen wir auf Tool-Call-Lookup oder RAG um. Bis dahin kein Overhead.

## Verwaltung-Tab — Program-Picker

### Refactor

1. **Umzug:** `src/renderer/wizard/program-detection.ts` → `src/renderer/shared/program-detection.ts`. Pfad-Imports im Wizard anpassen.
2. **Neuer shared UI-Helper:** `src/renderer/shared/program-picker.ts` mit Signatur:
   ```ts
   export interface ProgramPickerProps {
     initialSelected: ProgramEntry[];          // volle Entries, nicht nur Namen
     onChange: (entries: ProgramEntry[]) => void;
     includeFolderScanners?: boolean;          // Default: false
     initialExtraFolder?: string;              // nur relevant wenn includeFolderScanners=true
     initialGamesFolder?: string;              // nur relevant wenn includeFolderScanners=true
     showGamesFolder?: boolean;                // nur relevant wenn includeFolderScanners=true
     onFolderChange?: (kind: 'extra' | 'games', path: string) => void;
   }
   export function createProgramPicker(props: ProgramPickerProps): HTMLElement;
   ```

   **Begründung der `ProgramEntry[]`-API** (statt `string[]`): Der Picker muss intern zwischen detektierten und manuell hinzugefügten Einträgen unterscheiden, sonst gehen manuelle Entries (`source: 'manual'`) beim Rebuild verloren. Mit vollen Entries als Input behält der Picker die Information, wie jeder Eintrag ursprünglich entstanden ist. Intern mapped er `initialSelected.map(e => e.name)` für `sarahTagSelect`.

   Kapselt:
   - Initialen `detectPrograms()`-IPC-Call
   - `sarahTagSelect` mit `allowCustom: true`, initiale Auswahl = Namen aus `initialSelected`
   - Merge-Logik: Detection-Result + übergebene manuelle Entries → `sarahTagSelect`-Options
   - `onChange`: rekonstruiert `ProgramEntry[]` — bevorzugt detektierte Entry, fällt auf existierendes `initialSelected`-Entry zurück, sonst neuer `{ source: 'manual' }` via `detector.buildProgramEntry(name)`
   - Wenn `includeFolderScanners=true`: zusätzlich `sarahPathPicker` für Extra-Ordner und (bei `showGamesFolder=true`) Games-Ordner mit `scanFolderExes`-Rescan
   - Internal State (kein Module-Level-Singleton)

3. **Wizard-Refactor:** `src/renderer/wizard/steps/step-files.ts` ruft `createProgramPicker({ initialSelected: data.resources.programs, includeFolderScanners: true, showGamesFolder: <Gaming-Flag>, ... })` statt die Logik inline zu halten. Bestehende Felder (PDF-Block etc.) bleiben unverändert.

### Settings-Nutzung

In `src/renderer/dashboard/views/sections/files-section.ts` kommt der Picker **über** den Pfad-Pickern und PDFs:

```
├── Programme        ← NEU: createProgramPicker({ includeFolderScanners: false, ... })
├── Pfade (bestehend: Bilder, Installations, Games, Extra, Projekte)
└── PDF-Kategorien   (bestehend)
```

- `initialSelected`: `config.resources.programs` (volle Entries)
- `onChange`: `(entries) => { resources.programs = entries; save('resources', resources); showSaved(feedback); }`
- `includeFolderScanners: false` → kein zusätzlicher Ordner-Input. Die Ordner-Inputs bleiben bei den bestehenden Settings-Pfad-Pickern weiter unten, sodass keine UI-Dopplung entsteht. Scans aus Settings heraus sind out of scope für V1.

**Bekannte Einschränkung V1 (Rescan-Gap):** Der Picker ruft `detectPrograms()` nur beim Initialisieren auf. Ändert der User in derselben Session seinen `extraProgramsFolder` oder `gamesFolder` weiter unten in den Pfad-Pickern, bekommt der Picker das **nicht mit** — neue Programme aus dem geänderten Ordner erscheinen erst nach App-Neustart. Abgefedert wird das mit einer Hinweiszeile unter dem Picker: „Nach Ordner-Änderung App neu starten, um neue Programme zu erfassen."

## Datei-Struktur

```
src/core/
├── config-schema.ts               (+ LinkPreferenceSchema, + postalCode/birthday/email/linkPreferences)
├── sarah-api.ts                   (+ openExternalUrl im SarahApi-Interface)
src/main/
├── ipc-config.ts                  (+ open-external-url Handler, registriert neben bestehenden Config-Handlern)
src/preload.ts                     (+ openExternalUrl Bridge-Implementierung)
src/services/llm/
├── prompt-layers.ts               (buildCoreUser: + linkPreferences-Block inkl. sanitize)
├── prompt-layers.test.ts          (+ Test für sanitize + linkPreferences-Block)
src/renderer/
├── shared/
│   ├── program-detection.ts       (UMZUG aus wizard/)
│   ├── program-picker.ts          (NEU — DOM-Komponente)
│   └── program-picker-logic.ts    (NEU — pure Logik, testbar)
├── wizard/steps/
│   └── step-files.ts              (nutzt program-picker)
├── dashboard/views/sections/
│   ├── profile-section.ts         (Abo-Block, Optional-Labels, neue Felder, Linksammlung)
│   └── files-section.ts           (+ program-picker am Anfang)
styles/dashboard.css               (evtl. Regeln für Abo-Block + Linksammlung-Zeile)
```

## Tests

Die vitest-Konfiguration (`vitest.config.ts`) läuft in `environment: 'node'` — **kein DOM**. Das etablierte Muster im Projekt: Test-bare Logik wird in `*-logic.ts`-Module extrahiert (siehe `sarah-tabs-logic.ts`, `hud-toggle-logic.ts`). DOM-Komponenten werden nicht direkt getestet. Neue Tests folgen diesem Muster:

- **`config-schema.test.ts`** (falls bestehend; sonst neu angelegt): `LinkPreferenceSchema` lädt leere und befüllte Einträge korrekt, Defaults greifen (inkl. `id`-UUID-Default). `birthday`-Regex akzeptiert leeren String und ISO-Datum, lehnt Freitext ab.
- **`program-picker-logic.test.ts`** (neu): pure Funktionen aus `program-picker-logic.ts`:
  - `mergeOptions(detected, selected)` → Liste für `sarahTagSelect`
  - `reconstructEntries(names, detected, previousSelected, buildManualEntry)` → `ProgramEntry[]` mit korrekter Source-Priorisierung (detected > previous-manual > neu-manual)
- **`prompt-layers.test.ts`** (existiert: Ziel-Test prüfen): `buildCoreUser` hängt Linkpräferenzen an wenn vorhanden, lässt weg wenn leer, überspringt halbausgefüllte Einträge, **sanitisiert** `\n`/`\r`/`\t`/Längen-Cap auf 200.

Bestehende Tests (`sarah-tabs-logic.test.ts` etc.) bleiben unberührt.

## Sicherheits- und Validierungsaspekte

- **`openExternalUrl`-IPC-Handler** validiert strikt via `new URL(url).protocol === 'https:'`. Das ist case-insensitiv (`HTTPS://`, `https://` beide OK) und bricht schon beim Parsen, wenn der String keine valide URL ist. `file://`, `javascript:`, `chrome://` etc. werden abgelehnt. Andere Aufrufe werfen.
- **Linksammlung — Prompt-Injection-Sanitization**: `description` und `url` werden im Prompt-Builder vor der Injektion durch `sanitize()` gezogen (siehe oben). UI speichert den freien Text unverändert — es ist die Aufgabe des Prompt-Builders, den Output zu kontrollieren.
- **Linksammlung-URL-Feld im UI** validiert clientseitig nicht hart. Das LLM erhält im Prompt-Kontext nur sanitisierte Werte, beim Klick würde eine kaputte URL aus der Liste später vom `openExternalUrl`-Handler ohnehin abgelehnt. Für V1 reicht das.
- **E-Mail-Feld** validiert clientseitig nicht hart. `type="email"` gibt Browser-Hint, aber Auto-Save umgeht Submit-Validierung. Für V1 ausreichend, da das Feld nur lokal in der Config landet und aktuell nicht in den Prompt fließt.
- **Geburtsdatum** wird per Zod-Regex (`^\d{4}-\d{2}-\d{2}$|^$`) schon beim Parsen abgefangen. `type="date"` liefert Browserkalender und bleibt auch bei Tastatur-Eingabe im erwarteten Format, aber falls jemand per DevTools oder manueller JSON-Edit abweichende Werte einspeist, lehnt Zod beim Laden ab.

## Offene Fragen

Keine. Alle offenen Punkte aus dem Brainstorming sind entweder entschieden (Matching-Strategie V1, Abo-URL, Picker-Reuse) oder explizit ausgeklammert (Security-Tab, QR-Code, Server-Abo).

## Changelog

- **2026-04-22 (Rev. 2)**: Spec-Review aus `problems/talkabouts.md` eingearbeitet:
  - `LinkPreferenceSchema.id` mit `crypto.randomUUID()`-Default (B-1)
  - `sarah-api.ts` in Datei-Struktur ergänzt (B-2)
  - IPC-Handler-Registrierung auf `ipc-config.ts` festgelegt (B-3)
  - Prompt-Injection-Sanitization in `buildCoreUser` ergänzt (S-1)
  - URL-Whitelist auf `new URL().protocol === 'https:'` geändert (S-2)
  - Program-Picker-API auf `ProgramEntry[]` statt `string[]` (M-1), interne Merge/Rekonstruktions-Logik beschrieben
  - `favoriteLinks`-Beziehung geklärt: Dead Code, Cleanup out of scope (M-2)
  - Rescan-Gap als bekannte Einschränkung + UI-Hinweis dokumentiert (M-3)
  - Leere-Einträge-Filter beim Profil-Tab-Mount ergänzt (L-1)
  - `birthday`-Zod-Regex für ISO-Format (L-2)
  - Test-Strategie auf Logik-Extraktion (`program-picker-logic.ts`) umgestellt, da Vitest `environment: 'node'` ohne DOM läuft (L-3)
