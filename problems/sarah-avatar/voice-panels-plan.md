# Voice Panels (IN/OUT) — Plan (v2)

Branch: `feat/dashboard` (weiterführen)
Folgt auf: `cockpit-plan.md` (abgeschlossen)
Revision: 2026-04-19 — überarbeitet nach `voice-panels-lücken.md`-Audit.

## Ziel

Das bisherige Voice-I/O-Panel in **zwei separate Panels** aufsplitten:

- **VOICE IN** — Mic-Eingabe: Mute-Button, Device-Picker, Pegel, Volume- + Gain-Slider
- **VOICE OUT** — TTS-Ausgabe: Device-Picker, Pegel, Volume-Slider (kein Mute-Button, Stummschaltung via Volume = 0 oder zukünftig State-Interrupt)

Beide Panels 2 cols × 1 row, vertikal gestapelt unten-links.

## Grid-Änderung

Aktuell (`feat/dashboard` HEAD):
```
banner  banner  banner  banner  banner  banner
sysload sysload .       .       termine termine
.       .       hero    hero    termine termine
.       .       hero    hero    wetter  media
voiceio voiceio .       .       .       .
```

Neu (voice in rutscht auf die leere Row 4 hoch, voice out übernimmt den alten voiceio-Platz — wetter/media bleiben wo sie sind):
```
banner   banner   banner banner banner  banner
sysload  sysload  .      .      termine termine
.        .        hero   hero   termine termine
voicein  voicein  hero   hero   wetter  media
voiceout voiceout .      .      .       .
```

Die leere Row unten-rechts ist gewollt (Lücke #12 geklärt): kein Umbau an wetter/media.

`cockpit.css`: grid-area-Klassen `cockpit-voicein`, `cockpit-voiceout` ersetzen `cockpit-voiceio`.

## Panel-Innenlayout

Beide Panels intern 2-spaltig (Main + Slider-Bereich rechts):

**VOICE IN** (`sarah-panel title="VOICE IN" accent="mint"`):
```
┌──────────────────────────┬────┐
│ [🎤 Mute] [Mic Device ▼] │ ║ ║│   ← row 1: Controls
├──────────────────────────┤    │
│ ▐▐▐▐▐▐▐▐▐▐▐  LISTENING   │ ║ ║│   ← row 2: Pegel + State
└──────────────────────────┴────┘
                        VOL  GAIN
```

**VOICE OUT** (`sarah-panel title="VOICE OUT" accent="cyan"`):
```
┌──────────────────────────┬────┐
│ [Output Device       ▼]  │ ║  │   ← row 1: Controls
├──────────────────────────┤    │
│ ▐▐▐▐▐▐▐▐▐▐▐  IDLE        │ ║  │   ← row 2: Pegel + State
└──────────────────────────┴────┘
                        VOL
```

Implementierung: CSS Grid `grid-template-columns: 1fr auto; grid-template-rows: auto 1fr;`, Slider-Container `grid-row: 1 / 3`.

**Panel-Dimensionen (Lücke #9):**
- Min-Höhe Panel-Content ≈ **140px** (davon ~40px Header, ~30px Controls, ~70px Pegel).
- Vertikale Slider-Track-Länge ≈ **100px** (Controls+Pegel gestapelt), Thumb 14×6px, Track 4px breit. Bedienbar mit Maus und Tastatur.
- Bei kleineren Höhen (responsive) fallen Slider auf horizontal zurück (siehe `hud-vslider` unten).

## Config-Schema

Neu in `src/core/config-schema.ts`:

```ts
export const AudioSchema = z.object({
  inputDeviceId:  z.string().optional(),          // undefined = system default
  outputDeviceId: z.string().optional(),
  inputMuted:     z.boolean().default(false),
  inputGain:      z.number().min(0).max(1.5).default(1.0),  // ↑ Lücke #7: clip-safe cap
  inputVolume:    z.number().min(0).max(1).default(1.0),    // user-facing linear 0..1
  outputVolume:   z.number().min(0).max(1).default(1.0),
});
```

`max(1.5)` statt `max(2)` um Clipping-Artefakte bei starkem Mic-Boost zu vermeiden. UI-Slider ebenfalls auf 0–1.5 mappen (Default-Marker bei 1.0).

Migration: keine — Defaults decken Bestandswerte ab, Schema ist additiv.

## IPC — Neuer Kanal `audio-config-changed`

**Problem (Lücke #3):** `save-config` im Main-Prozess feuert `voice-config-changed` nur bei Änderungen am `controls`-Key. Audio-Änderungen erreichen den Renderer nicht.

**Lösung:** Neuer IPC-Event-Flow:

1. `ipc-config.ts` → bei jedem `save-config` prüfen ob der `audio`-Diff sich geändert hat
2. Wenn ja → `mainWindow.webContents.send('audio-config-changed', newAudio)`
3. Renderer-Preload: `onAudioConfigChanged(cb)` im `window.sarah`-Namespace
4. `AudioBridge.applyAudioConfig(audio)` reagiert auf das Event (Gain/Mute/Device/Volume updaten, ggf. Re-Init)

So bleibt der existierende `voice-config-changed`-Pfad für Controls unverändert, Audio bekommt einen eigenen, semantisch klaren Kanal.

## Audio-Bridge-Umbau (`src/renderer/services/audio-bridge.ts`)

**Capture-Chain erweitern:**
```
MediaStreamSource → GainNode(inputGain * !inputMuted) → AudioWorkletNode → IPC
                     ↑ smooth ramp via setTargetAtTime
```

- Gain-Änderungen über `gainNode.gain.setTargetAtTime(target, now, 0.015)` (Lücke: 15ms-Zeitkonstante vermeidet Klicks).
- Mute = `setTargetAtTime(0, now, 0.015)`, Unmute = rampt zurück auf `inputGain * inputVolume`.

**Mute + STT-Koordination (Lücke #13):**
- Beim Muten zusätzlich **IPC-Stream pausieren**: Worklet-Node `port.postMessage({ type: 'pause' })` oder Worklet kappt selbst `captureSamples`-Posts wenn `muted=true`.
- Dadurch empfängt der STT-Service keine Stille-Frames mehr, Timeout-Schleifen werden vermieden.
- Voice-State wechselt beim Muten nicht automatisch zu `'idle'` — der sichtbare State-Indikator bleibt für UX-Klarheit an der letzten Aktivität, aber downstream passiert nichts.

**Device-Wechsel (Lücken #2 + #3):**
- `applyAudioConfig(audio)` vergleicht `inputDeviceId` mit letzter Anwendung
- Bei Änderung: `stopCapture()` → **`this.workletLoaded = false` zurücksetzen** → `startCapture({ audio: { deviceId: { exact: id } } })`
- Ohne diesen Reset führt das `new AudioContext()` in `startCapture` zum Runtime-Error (`Processor not registered`)
- Alternative wäre: `workletLoaded` an den `captureCtx`-Lebenszyklus koppeln (z. B. WeakMap<AudioContext, boolean>) — aber der simple Reset reicht

**Playback-Chain erweitern:**
```
BufferSource → AnalyserNode → GainNode(outputVolume) → destination
                ↑ pre-gain — Bars zeigen Signal auch bei Volume=0
```

Entscheidung (Lücke #8): **AnalyserNode pre-gain**. Begründung: Nutzer sieht immer dass SARAH spricht, auch wenn er die Ausgabe stumm geschaltet hat. Volume-Mute ist eine bewusste Nutzeraktion — die Bars sollen trotzdem visualisieren dass TTS läuft.

**Output-Device-Routing (Lücke #1):**

Zwei Pfade, Feature-Detection zur Laufzeit:

```ts
// Primär (falls verfügbar): AudioContext.setSinkId
if (typeof playbackCtx.setSinkId === 'function') {
  await playbackCtx.setSinkId(outputDeviceId);
} else {
  // Fallback: HTMLAudioElement-basiertes Playback
  // - Buffer → WAV-Blob → audioEl.src = URL.createObjectURL(blob)
  // - audioEl.setSinkId(outputDeviceId)
  // - MediaElementAudioSourceNode(audioEl) → AnalyserNode  (nur für Pegel-Tap)
  // - WICHTIG: MediaElementAudioSourceNode NICHT an destination hängen,
  //   sonst spielt es doppelt (HTMLAudioElement spielt bereits an den SinkId).
}
```

`AudioContext.setSinkId()` ist in Chromium seit Version 110 verfügbar, aber MDN listet es als "Limited availability" (experimentell). Electron nutzt aktuell Chromium 130+ → in der Praxis verfügbar, Feature-Detection ist aber Pflicht.

**Output-Pegel (RMS):**
- AnalyserNode mit `fftSize: 256` → `getFloatTimeDomainData()`
- RMS pro Frame, auf 16 Bars downsampled
- Via `requestAnimationFrame` während Playback aktiv

**Bar-Decay nach Playback-Ende (Lücke #6):**
- Nach Playback-Ende läuft der RAF-Loop noch für ~400ms weiter
- In dieser Zeit werden Bars linear gegen 0 gedämpft: `value *= 0.85` pro Frame (~60fps → ~25 Frames → ~0 in 400ms)
- Erst dann Loop stoppen und Bars auf 0 setzen

**Output-Level Event (Lücke #5):**

- **Target:** `window` (kein eigenes EventTarget nötig — Renderer-global scope reicht)
- **Event-Name:** `audio:output-level`
- **Payload-Typ:**
  ```ts
  interface AudioOutputLevelEventDetail {
    rms: number;          // 0..1, Gesamtpegel (pre-gain)
    bars: Float32Array;   // 16 Werte 0..1, fürs UI
  }
  ```
- **Dispatcher:** `AudioBridge` ruft `window.dispatchEvent(new CustomEvent('audio:output-level', { detail }))` im RAF-Loop
- **Subscriber:** `voice-out.ts` hängt per `window.addEventListener('audio:output-level', handler)` rein, speichert den handler und entfernt ihn in seinem `dispose()`

## UI-Komponenten

**Neu:**

1. **`voice-in.ts`** (`src/renderer/dashboard/views/voice-in.ts`)
   - 16 Input-Bars (wie aktuell `voice-io.ts`)
   - Mute-Button (`hud-toggle`, aria-pressed)
   - Device-Picker (`hud-select` — Custom-Dropdown, nicht native)
   - Volume + Gain Slider (`hud-vslider`)

2. **`voice-out.ts`** (`src/renderer/dashboard/views/voice-out.ts`)
   - 16 Output-Bars (AnalyserNode-gespeist, über `audio:output-level`-Event)
   - Device-Picker
   - Volume Slider

3. **Komponenten/Stile:**

   **`hud-toggle`** — 3D-Button:
   - Unmuted (raised): `box-shadow: -2px -2px 4px rgba(216,241,255,0.1), 2px 2px 6px rgba(0,0,0,0.6);`
   - Muted (pressed): `box-shadow: inset -2px -2px 4px rgba(216,241,255,0.08), inset 2px 2px 6px rgba(0,0,0,0.5);` + Text leicht gedimmt
   - Transition 180ms
   - `aria-pressed="true|false"`, `aria-label="Mikrofon stummschalten"`

   **`hud-select`** — Custom-Dropdown:
   - Button mit Chevron-Icon, klappt Liste absolut unter den Trigger
   - Items mit Monospace-Font, Hover-Glow in Panel-Accent-Farbe
   - Keyboard-navigierbar (↑↓ Enter Esc)
   - **ARIA-Spec (Lücke #11):**
     - Trigger: `role="combobox"`, `aria-haspopup="listbox"`, `aria-expanded="true|false"`, `aria-controls="<listbox-id>"`, `aria-activedescendant="<option-id>"`
     - Listbox: `role="listbox"`, ID
     - Option: `role="option"`, `aria-selected="true|false"`, ID
   - **Permission-Prompt on open (Lücke #4):**
     - Beim ersten Öffnen des Dropdowns in `voiceMode='off'` triggert ein einmaliges `navigator.mediaDevices.getUserMedia({ audio: true })`
     - Stream wird direkt wieder gestoppt (`stream.getTracks().forEach(t => t.stop())`)
     - Danach `enumerateDevices()` → Labels sind verfügbar
     - Flag `hasRequestedPermission` auf der Komponente, damit es nicht bei jedem Open feuert

   **`hud-vslider`** — vertikaler Slider:
   - Track 4px breit, Thumb 14px × 6px, currentColor-Glow
   - **CSS-Technik (Lücke #10):** `writing-mode: vertical-lr; direction: rtl` auf dem nativen `<input type="range">` + custom Track/Thumb via `::-webkit-slider-runnable-track` / `::-webkit-slider-thumb`
   - Kein `-webkit-appearance: slider-vertical` (seit Chrome 120 nicht mehr vorgesehen, MDN empfiehlt writing-mode)
   - Label unterhalb (VOL / GAIN, Orbitron 0.6rem)
   - Wert-Indikator als `aria-valuetext`

**Gelöscht:**
- `voice-io.ts` (ersetzt durch voice-in.ts + voice-out.ts)
- `.cockpit-voiceio` Klasse in `home.ts` + CSS

## Phasen

### Phase 1: Schema + IPC-Pfad
- `AudioSchema` in `config-schema.ts`, in `SarahConfigSchema` einhängen (`max(1.5)` bei inputGain)
- `ipc-config.ts`: `audio`-Diff erkennen → `mainWindow.webContents.send('audio-config-changed', newAudio)`
- Preload-Bridge: `onAudioConfigChanged(cb: (audio) => void)` ergänzen
- Wizard braucht nichts — Defaults reichen

### Phase 2: Grid + UI-Stubs + Dispose-Pattern
- `home.ts`: `buildVoiceIoPanel` → `buildVoiceInPanel` + `buildVoiceOutPanel`
- Beide Builder liefern `{ el, dispose }`; `home.ts` stashed beide `dispose`-Fns in `(el as any).__dispose` analog zu System Load — die bestehende Cockpit-Cleanup-Logik ruft sie beim View-Teardown auf (Lücke #15).
- `cockpit.css`: grid-area-Klassen + Areas umbenennen, voicein auf Row 4 (col 1-2) neben Hero, voiceout auf Row 5 (col 1-2) wie bisheriges voiceio
- Panels haben vorerst Bars + State + statische Picker-Buttons

### Phase 3: Device-Enumeration + Picker
- `enumerateDevices()` im Renderer, gefiltert auf `audioinput` / `audiooutput`
- `hud-select` bauen inkl. ARIA-Attribute
- Permission-Prompt beim ersten Open (Lücke #4)
- Auswahl in Config speichern → triggert `audio-config-changed`
- Label "System-Standard" wenn kein Device gewählt

### Phase 4: Audio-Bridge Gain/Mute/Device
- Capture-Chain GainNode einbauen, Smooth-Ramp via `setTargetAtTime`
- `applyAudioConfig(audio)` auf `onAudioConfigChanged` registrieren
- `inputDeviceId`-Wechsel → stopCapture + `workletLoaded=false` + startCapture (Lücke #2)
- Mute pausiert zusätzlich IPC-Push (Lücke #13)

### Phase 5: 3D-Buttons + Slider
- `hud-toggle` CSS + Komponente, Mute-Integration
- `hud-vslider` für Volume/Gain mit writing-mode-Technik, an Config gebunden
- Sliders visuell rechts am Panel-Rand, Mindesthöhe 100px Track

### Phase 6: Output-Pegel + Volume + Sink-Routing
- AnalyserNode pre-gain in Playback-Chain
- RMS → 16 Bars per `requestAnimationFrame` während Playback
- Bar-Decay-Phase nach Playback-Ende (~400ms)
- `audio:output-level` CustomEvent dispatchen, `voice-out.ts` subscribed
- `outputVolume` via GainNode
- Output-Device: `playbackCtx.setSinkId()` mit Feature-Detection, Fallback HTMLAudioElement

### Phase 7: Settings-Gegenstück (optional, später)
- Dieselben Audio-Felder auch in Settings sichtbar/editierbar
- Vermutlich im neuen Voice-Tab (siehe `project_settings_tabs.md`)

## Offene Punkte / Risiken

- **`AudioContext.setSinkId` experimentell**: MDN listet als "Limited availability". In Electron (Chromium 130+) funktional, Feature-Detection bleibt Pflicht. Fallback auf HTMLAudioElement bei negativem Detect.
- **Permission-UX**: Der erste Open des Pickers im `voiceMode='off'` löst einen OS-Permission-Dialog aus. Das ist vertretbar, weil genau diese Stelle auch konzeptuell "Mic einrichten" bedeutet.
- **Echo-Risiko** wenn Mic-Device wechselt während TTS spricht — Capture muss mid-speech korrekt re-initialisieren können.
- **Gain-Ramp**: 15ms-Zeitkonstante muss getestet werden — zu kurz = Klick, zu lang = sichtbare Verzögerung beim Mute.

## Testing

- Unit: `computeRms` (neue variant für AnalyserNode-Float32Array, 16 Bars); Bar-Decay-Funktion isoliert
- Integration: `audio-config-changed` IPC löst `applyAudioConfig` aus; Device-Wechsel re-initialisiert Worklet
- Manuell:
  - Device-Wechsel Mic während Aufnahme (kein Runtime-Error, kein Dropout)
  - Output-Wechsel während TTS-Playback (spielt weiter am neuen Device)
  - Mute toggelt sofort, STT bekommt keine Stille-Frames
  - Picker beim ersten Öffnen im `voiceMode='off'` zeigt Device-Labels nach Permission-Grant
  - `inputGain=1.5` + lautes Signal produziert keine hörbaren Clipping-Artefakte
  - Bars fallen nach Playback-Ende sanft auf 0

## Dateien

**Neu:**
- `src/renderer/dashboard/views/voice-in.ts`
- `src/renderer/dashboard/views/voice-out.ts`
- `src/renderer/components/hud-toggle.ts` (oder nur CSS-Klasse)
- `src/renderer/components/hud-select.ts`
- `src/renderer/components/hud-vslider.ts`

**Geändert:**
- `src/core/config-schema.ts` — AudioSchema
- `src/core/ipc-config.ts` (oder wo `save-config` lebt) — audio-Diff → `audio-config-changed`
- `src/main/preload.ts` — `onAudioConfigChanged`
- `src/renderer/services/audio-bridge.ts` — Gain/Mute/Analyser/setSinkId/workletLoaded-Reset
- `src/renderer/dashboard/views/home.ts` — Panel-Split + Dispose
- `styles/cockpit.css` — Grid-Areas + Panel-interne Styles
- `src/renderer/components/index.ts` — neue Komponenten registrieren

**Gelöscht:**
- `src/renderer/dashboard/views/voice-io.ts`

## Abgearbeitete Lücken-Referenz

| # | Thema | Status |
|---|---|---|
| 1 | `AudioContext.setSinkId()` | Feature-Detection + HTMLAudioElement-Fallback spezifiziert |
| 2 | `workletLoaded` Reset | In Phase 4 beim Device-Wechsel explizit zurückgesetzt |
| 3 | AudioBridge-Re-Init wiring | Neuer IPC-Kanal `audio-config-changed` |
| 4 | Picker disabled bei `voiceMode: 'off'` | One-time `getUserMedia` on first open in `hud-select` |
| 5 | `audio:output-level` Event | Target `window`, Payload `{ rms, bars }`, Dispose in voice-out.ts |
| 6 | Bar-Decay | ~400ms Ramp-down nach Playback-Ende |
| 7 | Gain-Clipping | `inputGain.max(1.5)` im Schema |
| 8 | AnalyserNode-Platzierung | Pre-Gain (Bars zeigen Signal auch bei Volume=0) |
| 9 | Panel-Höhe | Min 140px Content, Slider-Track 100px spezifiziert |
| 10 | `hud-vslider` CSS | `writing-mode: vertical-lr; direction: rtl` |
| 11 | ARIA für `hud-select` | combobox/listbox/option Rollen + aria-* Attribute |
| 12 | Grid Row 5 rechts leer | Bewusst — voicein rutscht hoch auf Row 4, wetter/media bleiben, Row 5 rechts bleibt leer |
| 13 | Mute + STT | Mute pausiert IPC-Push im Worklet |
| 14 | VOICE OUT kein Mute | Bewusst — Stummschaltung via Volume-Slider |
| 15 | `home.ts` Dispose | Beide Panels liefern `{ el, dispose }`, analog zu System Load |
