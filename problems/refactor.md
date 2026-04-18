# Refactoring-Empfehlungen

Dateien mit mehr als 400 Zeilen. Empfehlungen nach Prioritat geordnet.
Claude CLI: Lies CLAUDE.md zuerst. Neue Branch pro Refactor: refactor/main-split, refactor/settings-split usw.

**Stand 2026-04-16:** Alle Vorschlaege validiert. Zeilenbereiche und Aufteilungslogik korrekt.
Dead-code-Bereinigung (whisperError, routerError, isFirstRun-Tripel, llm-service.ts etc.) bereits auf refactor/housekeeping erledigt.

---

## 1. src/main.ts (820 Zeilen) — HOECHSTE PRIORITAET

### Aktuelle Verantwortlichkeiten

| Bereich | Inhalt | ca. Zeilen |
|---|---|---|
| Bootstrap & Window | createWindow(), State-Vars | 1-40 |
| Programm-Utilities | KNOWN_ALIASES, generateAliases(), classifyProgramPath(), verifyProgramPath(), markDuplicateGroups(), Regex-Konstanten | 41-165 |
| Boot-Orchestrierung | app.whenReady(): Provider-Wiring, Whisper/Router init, IPC-Handler bis loadDashboardBootMode | 167-340 |
| Config-IPC | get-system-info, get-config, save-config, select-folder, open-dialog | 358-454 |
| Chat & LLM IPC | chat-message, forwardToRenderers, Perf-Timing | 441-510 |
| Voice IPC | voice-get-state, voice-playback-done, voice-audio-chunk, voice-set-interaction-mode, voice-config-changed, forward voice:* topics | 511-590 |
| Programm-Scan IPC | scan-folder-exes (findExes()), detect-programs (PowerShell-Script inline) | 591-760 |
| Boot-done Animation | setBounds()-Interval-Animation | 761-800 |
| App-Lifecycle | activate, window-all-closed | 801-820 |

### Zieldateien nach Refactoring

**`src/main/program-utils.ts`** (~100 Zeilen)
- KNOWN_ALIASES, UPDATER_PATTERNS, LAUNCHER_PATTERNS
- generateAliases(), classifyProgramPath(), verifyProgramPath(), markDuplicateGroups()

**`src/main/ipc-programs.ts`** (~220 Zeilen)
- scan-folder-exes Handler inkl. findExes()
- detect-programs Handler inkl. PowerShell-Script
- Importiert program-utils.ts

**`src/main/ipc-config.ts`** (~110 Zeilen)
- registerConfigHandlers(ipcMain, getContext)
- get-system-info, get-config, save-config, select-folder, open-dialog

**`src/main/ipc-voice.ts`** (~80 Zeilen)
- forwardToRenderers() Helper
- voice-get-state, voice-playback-done, voice-audio-chunk, voice-set-interaction-mode, voice-config-changed
- forwardToRenderers fuer alle voice:* Topics

**`src/main/boot-sequence.ts`** (~160 Zeilen)
- runBootSequence({ mainWindow, appContext, whisperProvider, piperProvider, routerService })
- boot-ready, splash-tts, splash-done, wizard-done, boot-done Handler
- loadDashboardBootMode() bleibt hier
- Perf-Timing Collector, forwardToRenderers fuer llm:* Topics

**`src/main.ts`** (Rest ~150 Zeilen)
- Nur noch: State-Vars, createWindow(), app.whenReady() als duenner Orchestrator
- Ruft register*Handlers() und runBootSequence() auf
- app.on('activate'), app.on('window-all-closed')

---

## 2. src/renderer/dashboard/views/settings.ts (797 Zeilen)

### Aktuelle Verantwortlichkeiten

| Bereich | Inhalt | ca. Zeilen |
|---|---|---|
| Shared Utils | getSarah(), showSaved(), createSectionHeader(), save() | 1-37 |
| Profile-Section | createProfileSection() | 38-75 |
| Files & PDF-Section | PDF_CATEGORY_OPTIONS, PDF_PLACEHOLDERS, createPdfBlock(), createFilesSection() | 76-212 |
| Trust-Section | EXCLUSION_OPTIONS, createTrustSection() | 213-295 |
| Personalization-Section | ACCENT_COLORS, TRAIT_OPTIONS, QUIRK_OPTIONS, createPersonalizationSection() | 296-490 |
| Controls-Section | BUILTIN_COMMANDS, createCommandRow(), createControlsSection() | 491-755 |
| Assembler | createSettingsView() | 756-797 |

ACHTUNG: PDF_CATEGORY_OPTIONS und PDF_PLACEHOLDERS sind identisch in step-files.ts kopiert (Duplikat!).

### Zieldateien nach Refactoring

**`src/renderer/shared/settings-utils.ts`** (~30 Zeilen)
- getSarah(), showSaved(), createSectionHeader(), save()

**`src/renderer/shared/pdf-constants.ts`** (~25 Zeilen) — loest das Duplikat
- PDF_CATEGORY_OPTIONS, PDF_PLACEHOLDERS
- Wird von settings.ts UND step-files.ts importiert

**`src/renderer/shared/pdf-block.ts`** (~55 Zeilen) — loest das Duplikat
- createPdfBlock(tag, cat, onChange) mit onChange-Callback statt hartcodierter save()-Logik
- Wird von settings.ts UND step-files.ts importiert

**`src/renderer/dashboard/views/sections/profile-section.ts`** (~40 Zeilen)
- createProfileSection(config)

**`src/renderer/dashboard/views/sections/files-section.ts`** (~100 Zeilen)
- createFilesSection(config) — importiert pdf-constants, pdf-block

**`src/renderer/dashboard/views/sections/trust-section.ts`** (~80 Zeilen)
- EXCLUSION_OPTIONS, createTrustSection(config)

**`src/renderer/dashboard/views/sections/personalization-section.ts`** (~195 Zeilen)
- ACCENT_COLORS, TRAIT_OPTIONS, QUIRK_OPTIONS, createPersonalizationSection(config)

**`src/renderer/dashboard/views/sections/controls-section.ts`** (~200 Zeilen)
- BUILTIN_COMMANDS, createCommandRow(), createControlsSection(config)

**`src/renderer/dashboard/views/settings.ts`** (Rest ~30 Zeilen)
- Nur noch: createSettingsView() als duenner Assembler der Section-Files

---

## 3. src/renderer/wizard/steps/step-files.ts (404 Zeilen)

### Aktuelle Verantwortlichkeiten

| Bereich | Inhalt | ca. Zeilen |
|---|---|---|
| Imports | Komponenten, Typen | 1-10 |
| Programm-Icon-Map | KNOWN_ICONS, getIcon() | 11-60 |
| Programm-Detection State | detectedProgramMap, tagSelectEl, currentOptions, currentSelected, syncTagSelect(), addScannedPrograms(), buildProgramEntry() | 61-105 |
| PDF-Konstanten | PDF_CATEGORY_OPTIONS, PDF_PLACEHOLDERS, GRID_CSS | 106-155 |
| PDF-Block Builder | findCategory(), createPdfBlock() | 156-205 |
| Step Builder | createFilesStep() | 206-404 |

PROBLEM: tagSelectEl, currentOptions, currentSelected sind mutable module-level Singletons.
Wenn createFilesStep() je zweimal instanziiert wird, bricht das lautlos.

### Zieldateien nach Refactoring

**`src/renderer/shared/pdf-constants.ts`** — siehe oben (gemeinsam mit settings-Refactor)

**`src/renderer/shared/pdf-block.ts`** — siehe oben (gemeinsam mit settings-Refactor)

**`src/renderer/wizard/program-detection.ts`** (~100 Zeilen)
- DetectedProgram Interface
- KNOWN_ICONS, getIcon()
- addScannedPrograms(), buildProgramEntry(), syncTagSelect()
- KEIN module-level State — stattdessen erhaelt createFilesStep() die State-Vars als lokale lets und uebergibt sie per Parameter

**`src/renderer/wizard/steps/step-files.ts`** (Rest ~170 Zeilen)
- GRID_CSS, findCategory() (beides lokaler Nutzung)
- createFilesStep() als einziger Export
- tagSelectEl, currentOptions, currentSelected werden lokale Vars innerhalb von createFilesStep()

---

## 4. src/services/voice/voice-service.ts (445 Zeilen)

Gut strukturierte Klasse, niedrigste Prioritaet. Nur zwei kleinere Extraktionen empfohlen.

### Zieldateien nach Refactoring

**`src/services/voice/vad.ts`** (~50 Zeilen)
- SILENCE_RMS_THRESHOLD Konstante
- computeRms(chunk: Float32Array): number
- createVad(onSilence: () => void): { feed(chunk): void; clear(): void }
- VoiceService ruft nur noch vad.feed(chunk) und vad.clear()

**`src/services/voice/conversation-manager.ts`** (~75 Zeilen)
- class ConversationManager
- reset(), resetTimer(onTimeout), end(onEnd), isActive getter
- Absorbiert resetConversationTimer(), endConversation(), clearConversationTimer()

**`src/services/voice/voice-service.ts`** (Rest ~330 Zeilen)
- Importiert Vad-Factory und ConversationManager
- Deutlich kuerzere animate-Methoden durch Delegation

---

## 5. src/sarahHexOrb.ts (489 Zeilen) — NIEDRIGSTE PRIORITAET

Sehr kohaesive Klasse, kaum aufspaltbar. Nur zwei pure-function Extraktionen sinnvoll.

### Zieldateien nach Refactoring

**`src/renderer/orb/orb-geometry.ts`** (~65 Zeilen)
- createHexShape(r: number): THREE.Shape
- generateFibonacciSphere(count: number, radius: number): THREE.Vector3[]
- Beide sind pure Math-Funktionen ohne this-Abhaengigkeit

**`src/renderer/orb/orb-types.ts`** (~20 Zeilen)
- SegmentData Typ
- SarahHexOrbOptions Typ

**`src/sarahHexOrb.ts`** (Rest ~410 Zeilen)
- Klasse unveraendert, importiert aus orb-geometry.ts und orb-types.ts
- Optional: updateInnerSphere() und updateSegments() als private Methoden aus animate() extrahieren

---

## Reihenfolge-Empfehlung fuer Claude CLI

1. shared/pdf-constants.ts + shared/pdf-block.ts — loest das Duplikat in zwei Dateien gleichzeitig
2. main.ts aufsplitten — groesster Gewinn, eigener Branch refactor/main-split
3. settings.ts Sections — direkt danach, nutzt shared/ bereits
4. step-files.ts — nutzt shared/ ebenfalls, loest Singleton-Problem
5. voice-service.ts — niedrige Prioritaet, eigener Branch wenn gewuenscht
6. sarahHexOrb.ts — optional, nur wenn Geometrie-Code wiederverwendet werden soll