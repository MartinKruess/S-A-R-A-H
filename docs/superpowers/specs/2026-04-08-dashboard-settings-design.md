# Dashboard Settings — Design Spec

## Goal

Rewrite the Settings view to reflect all current wizard data fields, add a new "Steuerung" section with voice control, quiet mode, and slash-command management.

## Architecture

The Settings view is a separate Electron dialog window (`dialog.html?view=settings`) rendered by `src/renderer/dashboard/views/settings.ts`. It reads config via `sarah.getConfig()` and saves per-field via `sarah.saveConfig()`. Each section is a self-contained factory function returning an HTMLElement.

No new files needed — this is a rewrite of `settings.ts` plus a config model extension for the new `controls` block.

## Sections

### 1. Profil (no changes)

Existing fields, already working:
- Anzeigename (input)
- Stadt (input)
- Beruf (input)
- Antwort-Stil (select: kurz/mittel/ausführlich)
- Tonfall (select: freundlich/professionell/locker)

### 2. Dateien & Ordner (update)

**Remove:** `pdfFolder`, `importantFolders` (legacy fields)

**Replace with:**
- PDF-Kategorien: tag-select with dynamic blocks per tag. Each block has:
  - Ordner (path-picker)
  - Benennungsschema (input, placeholder from category)
  - Checkbox: "An bestehenden Dateien orientieren"
  - Adding/removing tags creates/removes blocks (same pattern as wizard step-files)
- Bilder-Ordner (path-picker)
- Install-Ordner (path-picker)
- Games-Ordner (path-picker)
- Extra-Programm-Ordner (path-picker)
- Projekte-Ordner (path-picker, shown only if programming skill set)

Layout: 2-column grid at >= 600px for folder pickers, PDF blocks full-width.

### 3. Vertrauen (update)

**Keep:** Memory toggle, Dateizugriff select

**Add:**
- Memory-Exclusions: tag-select (Browser-Daten, Namen Dritter, Gesundheit, Finanzen) with custom tags, shown only when memory enabled
- Bestätigungslevel: select (minimal/standard/maximal)
- Memory hint text: "Sarah merkt sich dein Verhalten und Muster, aber niemals Passwörter, Bank- oder Versicherungsdaten."

### 4. Personalisierung (update)

**Keep:** Akzentfarbe swatches, Stimme select, Sprechgeschwindigkeit select

**Add:**
- Chat-Schriftgröße: select (Klein/Standard/Groß)
- Chat-Ausrichtung: select (Untereinander/Bubbles)
- Emojis: toggle
- Antwortmodus: select (Normal/Spontan/Nachdenklich)
- Charakter-Traits: tag-select, max 2 (Humorvoll, Sarkastisch, Schnippisch, Eifersüchtig, Selbstsicher, Unsicher)
- Quirk: select (Miauz Genau!, Gamertalk, Prof. Dr. Dr., Oldschool, Altertum, Pirat, Eigene) + custom input when "Eigene" selected

### 5. Steuerung (new)

**Voice control:**
- Select with 3 options: "Keyword-Listening (Hey Sarah)" / "Push-to-Talk" / "Aus"
- Default: "Aus"

**Quiet Mode:**
- Dauer: select or input (default 60 Minuten)
- Info text: "Mit /quietmode aktivierst du den Ruhemodus. Sarah hört nicht zu und reagiert nicht, bis die Zeit abläuft oder du erneut /quietmode eingibst."

**Slash-Commands:**
- Built-in commands (read-only, not deletable):
  - `/anonymous` — "Nachricht wird nach der Session vergessen"
  - `/showcontext` — "Zeigt alles was Sarah über dich weiß"
  - `/quietmode` — "Ruhemodus ein/aus"
- Custom commands section:
  - List of user-defined commands, each showing: command name, prompt text, delete button
  - "Hinzufügen" button → two inputs: Command (prefixed with /), Prompt
  - Validation: command must start with /, must not conflict with built-in commands
  - Stored in config as `controls.customCommands: { command: string; prompt: string }[]`

## Data Model Extension

New config block:

```ts
controls: {
  voiceMode: 'keyword' | 'push-to-talk' | 'off';
  quietModeDuration: number; // minutes, default 60
  customCommands: { command: string; prompt: string }[];
}
```

Defaults: `{ voiceMode: 'off', quietModeDuration: 60, customCommands: [] }`

Built-in slash commands are NOT stored in config — they are hardcoded in the UI and in the LLM system prompt.

## System Prompt Integration

Add to `buildSystemPrompt()`:

- Voice mode instruction (if keyword or push-to-talk active)
- Quiet mode info (duration setting)
- Custom slash commands: "Der User hat folgende Shortcuts definiert: /wetter = 'Wie wird das Wetter heute und morgen?', ..."

## Save Behavior

Each field saves immediately on change via `sarah.saveConfig()` with "Gespeichert!" feedback (existing pattern). No explicit save button needed.

## Future Considerations (not in scope)

- Tab-based layout (3 tabs: Profil+Personalisierung, Dateien+Vertrauen, Steuerung) — when slash commands grow
- Abo-Status display in Profil section
- Actual voice recognition / push-to-talk implementation (this spec only adds the config UI)
- Actual quiet mode timer implementation (this spec only adds the config + system prompt)
