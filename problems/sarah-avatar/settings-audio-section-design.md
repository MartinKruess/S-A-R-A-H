# Settings Audio Section — Design

**Datum:** 2026-04-21
**Branch:** `feat/dashboard` (Fortsetzung nach voice-panels Phase 6)
**Bezug:** `voice-panels-plan.md` — Phase 7 („Settings-Gegenstück", bisher als optional markiert)

## Kontext

Phase 7 aus dem voice-panels-Plan ist das Settings-Pendant zu den Cockpit Voice-Panels. Statt kompletter Spiegelung wird eine minimale Variante gebaut: nur die Default-Device-Pickers (Input + Output) erscheinen in Settings. Mute / Volume / Gain bleiben Cockpit-exklusiv.

Design-Treiber: Der HUD-Stil des Cockpits wandert demnächst auf den Rest der App. `hud-select` wird deshalb direkt in Settings eingesetzt statt eine zweite Settings-Variante zu pflegen — der Umbau fällt bei der späteren Style-Migration automatisch weg.

## Ziel

Neue Section „Audio" in der Settings-View, in der der Nutzer Default-Eingabe- und Ausgabegerät wählt. Änderungen werden über das bestehende `AudioSchema` persistiert und über den in Phase 1 verdrahteten IPC-Kanal `audio-config-changed` an die `AudioBridge` im Cockpit weitergereicht.

## Nicht-Ziele

- Kein Mute-Toggle in Settings (bleibt nur im Cockpit).
- Keine Volume-/Gain-Slider in Settings.
- Keine Live-Sync-Subscription zwischen Settings- und Cockpit-View (die sind im SPA nicht gleichzeitig gemountet — jede View liest Config frisch beim Aufbau).
- Kein Refactor an `hud-select`.

## Architektur

**Neue Datei:** `src/renderer/dashboard/views/sections/audio-section.ts`

**Export:** `createAudioSection(config: SarahConfig): HTMLElement`

**Mount-Punkt:** `src/renderer/dashboard/views/settings.ts` — zwischen der bestehenden Controls-Section und dem Wizard-„Einrichtung erneut durchführen"-Button.

## UI

Struktur der Section:

1. Section-Header „Audio" + Save-Feedback-Span (via `createSectionHeader('Audio')`).
2. `<hud-select kind="audioinput">` — zeigt im Trigger „Mikrofon: \<Device\>".
3. Vertikaler Spacer (`createSpacer()`).
4. `<hud-select kind="audiooutput">` — zeigt im Trigger „Ausgabe: \<Device\>".

Die hud-select-internen Prefix-Labels („Mikrofon: …" / „Ausgabe: …") liefern die Control-Beschriftung; ein zusätzliches Outer-Label wäre redundant und wird weggelassen. Section-Header „Audio" gibt den Oberkontext.

## Datenfluss

Initialisierung:

```ts
const audio = { ...(config.audio ?? {}) };

const inputEl = document.createElement('hud-select');
inputEl.setAttribute('kind', 'audioinput');
section.appendChild(inputEl);
inputEl.value = audio.inputDeviceId ?? '';

const outputEl = document.createElement('hud-select');
outputEl.setAttribute('kind', 'audiooutput');
section.appendChild(outputEl);
outputEl.value = audio.outputDeviceId ?? '';
```

Change-Handler:

```ts
inputEl.addEventListener('change', (e) => {
  const value = (e as CustomEvent<{ value: string }>).detail.value;
  audio.inputDeviceId = value || undefined;
  save('audio', audio);
  showSaved(feedback);
});
// analog für outputEl → audio.outputDeviceId
```

Leerer String = „System-Standard" (im Schema `undefined`). `value || undefined` hält das Schema sauber.

`save('audio', audio)` ruft `window.sarah.saveConfig({ audio })`. Der Main-Prozess erkennt den `audio`-Diff, feuert `audio-config-changed` an den Renderer, `AudioBridge.applyAudioConfig` reagiert und das Cockpit-Panel synchronisiert seine eigene Anzeige automatisch.

## Fehlerbehandlung

Keine zusätzliche Logik nötig — `hud-select` deckt bereits ab:
- `enumerateDevices()` schlägt fehl → stille Fallback-Liste (nur „System-Standard").
- Permission beim ersten Open verweigert → Options ohne Labels, System-Standard bleibt wählbar.
- Device-Hotplug → interner `devicechange`-Listener aktualisiert die Liste.

Defensive: `{ ...(config.audio ?? {}) }` falls `config.audio` wider Erwarten fehlt; das AudioSchema füllt Defaults beim Save wieder auf.

## Testing

**Unit:** keine neuen. `hud-select` hat bereits Tests aus Phase 3, `toDeviceOptions` ist pure-function-getestet, `save()` / Renderer-IPC sind abgedeckt.

**Manuell:**
1. Settings öffnen → Audio-Section zeigt beide Pickers mit aktueller Auswahl.
2. Erstes Öffnen des Input-Pickers im `voiceMode='off'` → OS-Mic-Permission-Prompt erscheint (gleiches Verhalten wie im Cockpit).
3. Input-Device wechseln → Settings neu öffnen → Auswahl bleibt bestehen.
4. Output-Device wechseln → Cockpit aufrufen → Voice-Out-Panel zeigt dasselbe Gerät ausgewählt.
5. Im Cockpit Device wechseln → zurück zu Settings → Picker zeigt neuen Wert (frischer Config-Read beim View-Aufbau).

## Dateien

**Neu:**
- `src/renderer/dashboard/views/sections/audio-section.ts`

**Geändert:**
- `src/renderer/dashboard/views/settings.ts` (ein Import, ein `appendChild`)

## Offene Punkte

Keine — der Scope ist eng, alle Interfaces (AudioSchema, `hud-select`, `audio-config-changed` IPC, Settings-Section-Pattern) existieren bereits.
