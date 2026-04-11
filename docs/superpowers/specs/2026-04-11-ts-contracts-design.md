# TypeScript Contracts — Design Spec

**Datum:** 2026-04-11
**Branch:** `refactor/ts-contracts` (basiert auf `refactor/voice-performance`)
**Ziel:** Alle `Record<string, unknown>` und `as`-Casts eliminieren durch typisierte Interfaces. Grundlage fuer spaeteres Aufbrechen von main.ts (Composition Root).

---

## Motivation

Die Modularchitektur (Interfaces, Provider-Injection, MessageBus) ist solide, aber die Daten-Contracts sind untypisiert:

- **Config** ist durchgehend `Record<string, unknown>` mit ~40 `as`-Casts
- **Bus Messages** haben `data: Record<string, unknown>`, Topics sind Magic Strings
- **IPC Contract** wird 4x separat deklariert (dashboard, dialog, wizard, audio-bridge)

TypeScript prueft an diesen Stellen nichts — Tippfehler, falsche Payloads und Config-Drift werden erst zur Runtime sichtbar.

---

## Neue Dependency

- `zod` — Runtime-Validierung + TypeScript-Types in einem. Noetig weil Config von Disk gelesen wird (System-Boundary).

---

## Teil 1: Typed Bus Events

### Neue Datei: `src/core/bus-events.ts`

Zentrale Event Map — jedes Topic hat genau einen Payload-Typ:

```typescript
import type { VoiceState } from '../services/voice/voice-types.js';

export type BusEvents = {
  'chat:message':        { text: string };
  'llm:chunk':           { text: string };
  'llm:done':            { fullText: string };
  'llm:error':           { message: string };
  'voice:state':         { state: VoiceState };
  'voice:listening':     Record<string, never>;
  'voice:transcript':    { text: string };
  'voice:speaking':      { text: string };
  'voice:play-audio':    { audio: number[]; sampleRate: number };
  'voice:done':          Record<string, never>;
  'voice:error':         { message: string };
  'voice:interrupted':   Record<string, never>;
  'voice:wake':          Record<string, never>;
  'voice:playback-done': Record<string, never>;
};
```

### Aenderung: `src/core/types.ts`

`BusMessage` wird generisch:

```typescript
export interface TypedBusMessage<T extends keyof BusEvents = keyof BusEvents> {
  source: string;
  topic: T;
  data: BusEvents[T];
  timestamp: string;
}
```

Alter `BusMessage`-Type wird durch `TypedBusMessage` ersetzt.

### Aenderung: `src/core/message-bus.ts`

`emit()` und `on()` werden generisch:

```typescript
emit<T extends keyof BusEvents>(source: string, topic: T, data: BusEvents[T]): void
on<T extends keyof BusEvents>(topic: T, handler: (msg: TypedBusMessage<T>) => void): () => void
```

Wildcard `*` bleibt als Sonderfall mit `TypedBusMessage` (Union aller Payloads).

### Aenderung: `src/core/service.interface.ts`

```typescript
readonly subscriptions: readonly (keyof BusEvents)[];
onMessage(msg: TypedBusMessage): void;
```

### Betroffene Services

- `src/services/llm/llm-service.ts` — `msg.data.text as string` wird `msg.data.text` (direkt typisiert)
- `src/services/voice/voice-service.ts` — alle `as string`-Casts in `onMessage()` fallen weg

---

## Teil 2: Config Schema mit Zod

### Neue Datei: `src/core/config-schema.ts`

Zod-Schema mit einzeln exportierten Sub-Schemas:

- `ProfileSchema` — displayName, lastName, city, profession, usagePurposes, hobbies, responseStyle, tone
- `SkillsSchema` — programming, programmingStack, programmingResources, design, office
- `ProgramEntrySchema` — name, path, type, source, verified, aliases, duplicateGroup?
- `PdfCategorySchema` — tag, folder, pattern, inferFromExisting
- `ResourcesSchema` — emails, programs, favoriteLinks, pdfCategories, Folder-Pfade
- `TrustSchema` — memoryAllowed, fileAccess (mit preprocess fuer Legacy-Wert "full" -> "all"), confirmationLevel, memoryExclusions
- `PersonalizationSchema` — accentColor, voice, speechRate, chatFontSize, chatAlignment, emojisEnabled, responseMode, characterTraits, quirk
- `ControlsSchema` — voiceMode, pushToTalkKey, quietModeDuration, customCommands
- `LlmSchema` — baseUrl, model, options (temperature, num_predict, num_ctx)
- `SystemSchema` — os, platform, arch, cpu, folders etc.
- `SarahConfigSchema` — Root-Schema das alles zusammenfuehrt

Alle Sub-Schemas haben sinnvolle `.default()`-Werte.

Exportiert wird:
- Jedes Sub-Schema einzeln (fuer Wizard-Validierung etc.)
- `SarahConfigSchema` (Root)
- `SarahConfig` Type via `z.infer<typeof SarahConfigSchema>`
- Sub-Types wie `ProgramEntry`, `PdfCategory` etc. via `z.infer<>`

### Legacy-Migration

`fileAccess: "full"` wird per `z.preprocess()` automatisch zu `"all"` gemappt.

### Aenderung: `src/core/bootstrap.ts`

Config wird beim Start validiert:

```typescript
const raw = await config.get('root') ?? {};
const parsed = SarahConfigSchema.parse(raw);
```

`appContext.config` liefert danach `SarahConfig` statt `Record<string, unknown>`.

### Betroffene Dateien

- `src/main.ts` — alle `get<Record<string, unknown>>('root')` werden `SarahConfig`
- `src/services/voice/voice-service.ts` — `controls?.pushToTalkKey as string` wird `config.controls.pushToTalkKey`
- `src/services/llm/llm-service.ts` — Config-Zugriffe typisiert
- `src/renderer/dashboard/views/settings.ts` — alle ~30 `as string`/`as Record`-Casts fallen weg

---

## Teil 3: Shared IPC Contract

### Neue Datei: `src/core/ipc-contract.ts`

Typisierte Channel-Maps:

**IpcCommands** — Request/Response (ipcMain.handle):

| Channel | Input | Output |
|---------|-------|--------|
| `get-system-info` | void | SystemInfo |
| `get-config` | void | SarahConfig |
| `save-config` | Partial\<SarahConfig\> | SarahConfig |
| `is-first-run` | void | boolean |
| `select-folder` | string \| undefined | string \| null |
| `detect-programs` | void | ProgramEntry[] |
| `scan-folder-exes` | string | ProgramEntry[] |
| `open-dialog` | string | void |
| `chat-message` | string | void |
| `voice-get-state` | void | VoiceState |
| `voice-playback-done` | void | void |
| `voice-audio-chunk` | number[] | void |
| `voice-set-interaction-mode` | 'chat' \| 'voice' | void |
| `voice-config-changed` | void | void |

**IpcEvents** — Main -> Renderer (one-way, forwarded Bus Events):
Referenziert direkt `BusEvents`-Payloads — kein Drift moeglich.

**IpcSendEvents** — Renderer -> Main (one-way):
- `splash-done`: void

**Shared Types:** `SystemInfo`, `ProgramEntry` werden hier zentral definiert (ProgramEntry kommt aus config-schema.ts via re-export).

### Neue Datei: `src/core/sarah-api.ts`

Renderer-seitiges API-Interface:

```typescript
export interface SarahApi {
  version: string;
  splashDone(): void;
  getConfig(): Promise<SarahConfig>;
  saveConfig(config: Partial<SarahConfig>): Promise<SarahConfig>;
  // ... alle weiteren Methoden typisiert
  voice: SarahVoiceApi;
}
```

### Betroffene Dateien

- `src/preload.ts` — importiert Types aus ipc-contract, Callbacks typisiert
- `src/renderer/dashboard/dashboard.ts` — `declare const sarah` wird `declare const sarah: SarahApi`
- `src/renderer/dashboard/dialog.ts` — gleich
- `src/renderer/wizard/wizard.ts` — gleich
- `src/renderer/services/audio-bridge.ts` — gleich

---

## Datei-Uebersicht

### Neue Dateien (4)

| Datei | Inhalt |
|-------|--------|
| `src/core/bus-events.ts` | Typed Event Map |
| `src/core/config-schema.ts` | Zod-Schema + SarahConfig Type |
| `src/core/ipc-contract.ts` | IPC Commands, Events, Shared Types |
| `src/core/sarah-api.ts` | Renderer-API Interface |

### Geaenderte Dateien (13)

| Datei | Aenderung |
|-------|-----------|
| `package.json` | zod Dependency |
| `src/core/types.ts` | BusMessage -> TypedBusMessage\<T\> |
| `src/core/message-bus.ts` | Generische emit/on |
| `src/core/service.interface.ts` | Typisierte subscriptions + onMessage |
| `src/core/bootstrap.ts` | Config-Validierung mit Zod |
| `src/preload.ts` | Types aus ipc-contract |
| `src/main.ts` | Record\<string, unknown\> -> SarahConfig, typisierte Handler |
| `src/services/llm/llm-service.ts` | as-Casts raus |
| `src/services/voice/voice-service.ts` | as-Casts raus, typisierte Config |
| `src/renderer/dashboard/dashboard.ts` | declare const sarah: SarahApi |
| `src/renderer/dashboard/dialog.ts` | declare const sarah: SarahApi |
| `src/renderer/dashboard/views/settings.ts` | as-Casts raus, typisierte Config |
| `src/renderer/wizard/wizard.ts` | declare const sarah: SarahApi |
| `src/renderer/services/audio-bridge.ts` | declare const sarah: SarahApi |

---

## Keine Breaking Changes

Runtime-Verhalten bleibt identisch. Alle Aenderungen sind rein auf Type-Ebene, plus Zod-Validierung beim Start (die bei korrekter Config transparent durchlaeuft).

---

## Reihenfolge der Implementierung

1. `zod` installieren
2. `bus-events.ts` anlegen
3. `types.ts` + `message-bus.ts` + `service.interface.ts` generisch machen
4. `config-schema.ts` anlegen
5. `ipc-contract.ts` + `sarah-api.ts` anlegen
6. `bootstrap.ts` — Config-Validierung einbauen
7. `preload.ts` — Types importieren
8. Services anpassen (llm-service, voice-service)
9. Renderer anpassen (dashboard, dialog, wizard, audio-bridge, settings)
10. `main.ts` — typisierte Config + Handler
11. Tests anpassen / erweitern
12. Build pruefen
