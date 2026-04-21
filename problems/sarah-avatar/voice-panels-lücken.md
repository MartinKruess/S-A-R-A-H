# Voice Panels — Plan-Lücken & Korrekturen

**Analyse-Datum:** 2026-04-19  
**Referenz:** `voice-panels-plan.md`  
Copilot: Lies CLAUDE.md. Branch: `feat/dashboard` (weiterführen, kein neuer Branch nötig).

---

## 🔴 Kritisch — Faktische Fehler

### 1. `AudioContext.setSinkId()` existiert nicht

**Plan:** "Output: `playbackCtx.setSinkId(outputDeviceId)` (Chrome 110+, Electron supports)"

**Realität:** `AudioContext` hat **keine** `setSinkId()`-Methode. Die API existiert nur auf `HTMLAudioElement`. Kein Browser/Electron implementiert `AudioContext.setSinkId()`.

**Korrektur:** Der Fallback im Plan ("auf `HTMLAudioElement` umstellen") ist in Wahrheit der **einzig funktionierende Ansatz**. Primär- und Fallback-Strategie sind vertauscht:

```ts
// Korrekt: HTMLAudioElement als Playback-Sink
const audioEl = new Audio();
audioEl.setSinkId(outputDeviceId);
// TTS-Buffer als Blob/ObjectURL → audioEl.src = URL.createObjectURL(blob)
```

→ Das bedeutet: `playbackCtx`-basierter Ansatz für Output-Device-Routing funktioniert nicht. **Phase 6 muss komplett neu gedacht werden.**

---

### 2. `workletLoaded`-Flag bei Device-Wechsel nicht zurückgesetzt

**Problem:** Bei Mic-Device-Wechsel soll `stopCapture()` → neues `captureCtx` → `startCapture()` laufen.

Aktuell wird `captureCtx` in `destroy()` geschlossen, aber bei Device-Wechsel im laufenden Betrieb gibt es keinen Pfad der `captureCtx` schließt und neu erstellt. Wenn doch: `workletLoaded = true` ist eine Instanz-Variable — bei einem neuen `AudioContext`-Objekt braucht es ein erneutes `addModule()`.

**Bug-Pfad:**
1. Device-Wechsel → `stopCapture()` → `captureCtx.close()` → `captureCtx = null`
2. `startCapture()` → `captureCtx = new AudioContext(...)` (neue Instanz!)
3. `if (!this.workletLoaded)` → **false** → Worklet wird nicht geladen
4. `new AudioWorkletNode(...)` → **Runtime-Error**: Processor nicht registriert

**Fix:** `workletLoaded` beim Close auf `false` zurücksetzen, oder `workletLoaded` an den `captureCtx`-Lebenszyklus koppeln.

---

## 🔴 Kritisch — Architektur-Lücken

### 3. AudioBridge-Re-Init bei `audio`-Config-Change nicht verdrahtet

**Plan:** "Re-Init bei Device-Wechsel löst der Renderer selbst (AudioBridge hört auf Config-Change)"

**Problem:** `voice-config-changed` IPC ruft `VoiceService.applyConfig()` im **Main-Prozess** auf — das hat nichts mit `AudioBridge` im Renderer zu tun. `save-config` mit dem neuen `audio`-Key triggert `voice-config-changed` nur wenn der `controls`-Key geändert wird (Zeile 60ff. in `ipc-config.ts`).

**Was fehlt:**
- Entweder: `save-config` muss bei `audio`-Key-Änderung ein Event an den Renderer senden
- Oder: Der Renderer pollt `getConfig()` nach `save-config`
- Oder: Ein neues IPC-Event `audio-config-changed` einführen

Ohne diesen Mechanismus reagiert `AudioBridge` nicht auf gespeicherte Device/Gain/Volume-Änderungen.

---

### 4. `voiceMode: 'off'` → Picker permanent disabled

**Plan:** "Picker disabled bis Capture einmal lief" (wegen leerer Device-Labels vor `getUserMedia()`)

**Problem:** Bei `voiceMode: 'off'` ruft `AudioBridge.handleStateChange()` nie `startCapture()` auf → `getUserMedia()` wird nie getriggert → Device-Labels bleiben für immer leer → Picker bleibt disabled.

Das ist der Default-Zustand für neue Nutzer, die Sprache noch nicht konfiguriert haben — genau die Situation, in der der Picker am wichtigsten wäre.

**Lösung:** Beim Öffnen des Pickers ein einmaliges `getUserMedia({ audio: true })` triggern (Permission-Request), direkt danach `enumerateDevices()`. Die Permission-Anfrage erscheint nur beim ersten Mal.

---

## 🟡 Mittel — Unklare Definitionen

### 5. `audio:output-level` CustomEvent nicht spezifiziert

**Plan:** "Nicht über IPC — rein im Renderer emittieren (neues Event `audio:output-level`)"

**Fehlende Details:**
- EventTarget: `window`? Ein shared `EventEmitter`? Ein singleton `AudioBridge`-Objekt?
- Event-Payload-Typ: `{ rms: number; bars: number[] }` (wie `VoiceLevel`) oder anders?
- Wer lauscht: `voice-out.ts` müsste auf das Event subscriben — und auch wieder unsubscriben (`dispose()`-Pattern wie in `voice-io.ts`)

Ohne diese Spec ist `voice-out.ts` nicht implementierbar.

---

### 6. Bars frieren nach Playback-Ende ein (kein Decay)

**Plan:** "Via `requestAnimationFrame` bei `currentPlaybackSource !== null` pollen"

**Problem:** Wenn Playback endet, stoppt der RAF-Loop. Die Bars bleiben auf dem letzten Wert stehen — typischerweise irgendwo bei 30–80% Amplitude.

Es fehlt ein **Decay-Mechanismus**: Nach Playback-Ende sollten Bars in ~300–500ms auf 0 fallen. Das ist in keiner Phase erwähnt.

---

### 7. `inputGain > 1` ohne Clip-Schutz

**Schema:** `inputGain: z.number().min(0).max(2).default(1.0)`

Gain > 1 amplifiziert das Mic-Signal. Das `AudioWorkletNode` schickt die Samples ohne Clipping-Schutz als `Float32Array` an den STT-Service. Übersteuerung → STT-Qualität sinkt drastisch.

**Empfehlung:** Entweder `max(1.5)` im Schema, oder einen `DynamicsCompressorNode` nach dem GainNode einbauen, oder zumindest im Plan vermerken dass Clipping-Artefakte bei Gain > 1 bekannt sind.

---

### 8. AnalyserNode zeigt post-gain Signal

**Plan:** `BufferSource → GainNode (outputVolume) → AnalyserNode → destination`

Wenn `outputVolume = 0` (Mute per Volume), zeigen die Bars 0 — obwohl TTS spricht. Das könnte ein Nutzungsproblem sein: User sieht keine Bars und denkt SARAH spricht nicht.

**Entscheidung treffen:** AnalyserNode **vor** dem GainNode (zeigt immer Signal) oder **nach** (zeigt was man hört)?

---

### 9. Zwei vertikale Slider in "flachem" Panel — visueller Widerspruch

**Plan:** Panels sind "2 cols × 1 row (flach)". VOICE IN hat aber VOL + GAIN als zwei vertikale Slider.

Ein vertikaler Slider braucht Höhe. Zwei davon nebeneinander in einem "flachen" Panel (Höhe vermutlich 100–140px) ist nur sinnvoll wenn die Slider sehr kurz sind (< 80px) — dann aber kaum bedienbar.

**Klärung nötig:** Was ist die Panel-Mindesthöhe? Sind Slider wirklich vertikal oder können sie horizontal sein?

---

### 10. `hud-vslider` vertikale CSS-Umsetzung

**Problem:** Vertikale Range-Inputs in WebKit/Electron benötigen entweder:
- `writing-mode: vertical-lr` + `direction: rtl` (funktioniert in Chromium)
- Oder custom-gebauten Track+Thumb via Pointer-Events (mehr Aufwand)

`-webkit-appearance: slider-vertical` ist **seit Chrome 120 deprecated** und in Electron 30+ (Chromium 130+) entfernt.

Der Plan erwähnt "native Chrome weg" — aber die Alternative (writing-mode) ist nicht spezifiziert und hat eigenständige Quirks bei Größenberechnung.

---

### 11. `hud-select` — Accessibility nicht erwähnt

**Plan:** "Keyboard-navigierbar (↑↓ Enter Esc)" — das ist ein guter Start.

**Fehlende ARIA-Spec:**
- `role="combobox"` oder `role="button"` auf dem Trigger
- `role="listbox"` + `role="option"` auf der Dropdown-Liste
- `aria-expanded`, `aria-activedescendant`, `aria-selected`

Ohne ARIA ist das Dropdown für Screen-Reader unsichtbar. In Electron vielleicht weniger kritisch, aber fehlende ARIA-Attribute können auch Electron-DevTools-Warnungen erzeugen.

---

### 12. Grid erhält 6. Row — visuelle Balance?

**Plan:** Neues Grid hat `voicein` + `voiceout` als zwei separate Rows unten-links.

Aktuell: `grid-template-rows: 5rem repeat(4, minmax(0, 1fr))` → 5 Rows.  
Neu: 6 Rows nötig. Aber `sysload`, `hero`, `termine`, `wetter`, `media` belegen nur Rows 2–5. Row 6 rechts bleibt leer (`.`).

Das erzeugt optisch eine unbalancierte rechte Seite: links zwei gefüllte Panel-Rows (voicein/voiceout), rechts unten leerer Raum. War das so gewollt oder sollen `wetter`/`media` auf Row 5–6 verschoben werden?

---

### 13. Mute + Voice-State-Koordination

**Wenn Mute aktiv und State = 'listening':**  
`AudioBridge` sendet weiterhin Samples — nur Stille (GainNode = 0). Whisper/STT bekommt Stille-Frames und kann ggf. in eine Timeout-Schleife gehen oder falsche Ergebnisse produzieren.

**Nicht adressiert:** Soll beim Muten automatisch in 'idle' gegangen werden? Oder Whisper-seitig ignoriert? Needs Decision.

---

## 🟢 Niedrig — Kleinere Punkte

### 14. VOICE OUT: kein Mute-Button — Absicht?

Der Plan hat explizit "kein Mute" für VOICE OUT. Das ist ungewöhnlich — ein User möchte ggf. SARAH zum Schweigen bringen ohne die Lautstärke auf 0 zu setzen. Ist das eine bewusste Entscheidung oder vergessen?

### 15. `home.ts` Grid-Area-Refactoring nicht explizit beschrieben

Der Plan nennt "`buildVoiceIoPanel` → `buildVoiceInPanel` + `buildVoiceOutPanel`" aber beschreibt nicht die Dispose-Orchestrierung in `home.ts`. Das aktuelle Muster in `voice-io.ts` gibt ein `{ el, dispose }` zurück. Die `home.ts` muss beide `dispose()`-Funktionen aufrufen. Ist das geplant?

---

## Priorität-Übersicht

| # | Thema | Priorität | Blockiert Phase |
|---|---|---|---|
| 1 | `AudioContext.setSinkId()` falsch | 🔴 Kritisch | 6 |
| 2 | `workletLoaded` bei Device-Wechsel | 🔴 Kritisch | 4 |
| 3 | AudioBridge-Re-Init nicht verdrahtet | 🔴 Kritisch | 4 |
| 4 | `voiceMode: 'off'` → Picker disabled | 🔴 Kritisch | 3 |
| 5 | `audio:output-level` Event unspezifiziert | 🟡 Mittel | 6 |
| 6 | Bar-Decay fehlt | 🟡 Mittel | 6 |
| 7 | Gain > 1 Clipping | 🟡 Mittel | 4 |
| 8 | AnalyserNode Signalpfad | 🟡 Mittel | 6 |
| 9 | Slider-Höhe vs. "flach" | 🟡 Mittel | 5 |
| 10 | `hud-vslider` CSS-Technik | 🟡 Mittel | 5 |
| 11 | ARIA für `hud-select` | 🟡 Mittel | 3 |
| 12 | Grid Row 6 Balance | 🟢 Niedrig | 2 |
| 13 | Mute + STT-Koordination | 🟡 Mittel | 4 |
| 14 | VOICE OUT kein Mute | 🟢 Niedrig | Design-Decision |
| 15 | `home.ts` Dispose-Pattern | 🟢 Niedrig | 2 |
