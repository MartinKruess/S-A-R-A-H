# Claude-Audit: Probleme im aktuellen Stand

Stand: 2026-04-09

## Kritisch (blockiert Kernfunktionen)

### K1. CSP blockiert getUserMedia und AudioWorklet
- **Datei:** `dashboard.html:5`
- **Problem:** `default-src 'self'` reicht nicht — `media-src` fehlt explizit. In manchen Electron-Versionen wird `getUserMedia` dadurch stillschweigend blockiert.
- **Fix:** CSP erweitern um `media-src 'self'`

### K2. Kein globaler InteractionMode (chat vs. speak)
- **Datei:** `voice-service.ts:109`, `dashboard.ts:55`
- **Problem:** `chatMode` existiert nur als lokale Variable im Renderer. VoiceService kennt ihn nicht → TTS feuert IMMER wenn `voiceMode !== 'off'`, auch im Chatmodus.
- **Fix:** `interactionMode` als IPC-synchronisierten State einführen. VoiceService unterdrückt TTS wenn `interactionMode === 'chat'`.

### K3. PTT ist Toggle statt Hold-to-Talk
- **Datei:** `hotkey-manager.ts`
- **Problem:** Electron `globalShortcut` kann kein keyup erkennen. Aktuell Toggle mit 600ms Debounce — unintuitiv und fehleranfällig.
- **Fix:** `uiohook-napi` für echte keydown/keyup Events, oder Toggle als bewussten Modus akzeptieren und UX anpassen.

### K4. Voice-State nicht vollständig an Renderer propagiert
- **Datei:** `voice-service.ts:51`, `main.ts:372-387`
- **Problem:** `setState()` emittiert kein Bus-Event. Renderer bekommt States nur indirekt über eine Map in main.ts. `processing` fehlt komplett.
- **Folge:** AudioBridge weiß nicht wann `processing` läuft, Mic bleibt ggf. zu lange offen. UI kann keinen "Denke nach..."-Zustand zeigen.
- **Fix:** `setState()` soll direkt `voice:state` emittieren mit dem neuen State.

### K5. Porcupine Wake-Word bekommt keine Audio-Frames
- **Datei:** `voice-service.ts:130`, `porcupine-provider.ts:102`
- **Problem:** `wakeWord.start()` wird aufgerufen, aber `processFrame()` wird nirgends mit Audio-Daten gefüttert. Wake-Word-Erkennung ist komplett nicht funktional.
- **Fix:** Für jetzt: Keyword-Mode deaktivieren/blocken in UI. Später: eigene Audio-Pipeline für Wake-Word.

## Hoch (funktionale Fehler)

### H1. Settings-Änderungen greifen nicht live
- **Datei:** `voice-service.ts:57-60`, `settings.ts:599`
- **Problem:** VoiceService liest Config nur bei `init()`. Wechsel von `off` → `push-to-talk` in Settings hat keinen Effekt bis Neustart.
- **Fix:** IPC-Event `voice:config-changed` einführen, VoiceService re-initialisiert sich.

### H2. Playback-Done Promise kann hängen
- **Datei:** `voice-service.ts:231-239`
- **Problem:** Wartet auf `voice:playback-done` vom Renderer. Wenn Renderer abstürzt oder IPC bricht, hängt die Promise. Fallback-Timeout existiert, aber `unsub()` wird bei Timeout nicht sauber aufgeräumt.
- **Fix:** Cleanup-Flag einführen, unsub idempotent machen.

### H3. Ollama JSON-Parsing ohne try-catch
- **Datei:** `ollama-provider.ts:57-61`
- **Problem:** `JSON.parse(line)` kann bei kaputten Chunks werfen → Chat bricht ab mit generischem "connection" Error.
- **Fix:** try-catch um JSON.parse, kaputte Zeilen skippen.

### H4. AudioBridge wird nie aufgeräumt
- **Datei:** `dashboard.ts:111-114`
- **Problem:** `audioBridge.start()` wird aufgerufen, aber `destroy()` nie — kein `beforeunload`-Handler. MediaStream bleibt offen.
- **Fix:** `window.addEventListener('beforeunload', () => audioBridge.destroy())`

### H5. voice:transcript wird im Dashboard nicht genutzt
- **Datei:** `preload.ts:42-45`, Dashboard
- **Problem:** Preload exponiert `onTranscript()`, aber Dashboard konsumiert es nicht. Wenn per Voice gesprochen wird, erscheint kein User-Bubble.
- **Fix:** Dashboard soll `onTranscript` nutzen um eine User-Bubble mit dem erkannten Text anzuzeigen.

### H6. System-Prompt wird vom LLM nachgeplappert
- **Datei:** `llm-service.ts:170-302`
- **Problem:** Bei "Hallo" beschreibt Sarah ihre gesamte Config. Instruktion wurde hinzugefügt aber nicht ausreichend getestet.
- **Status:** Teilweise gefixt (Instruktion hinzugefügt), muss getestet werden.

## Mittel (Stabilität / UX)

### M1. State-Machine erlaubt überlappende Async-Ops
- **Datei:** `voice-service.ts:107-213`
- **Problem:** Kein Mutex. Wenn `speakResponse()` läuft und gleichzeitig `onPttDown()` kommt, können beide `setState()` gleichzeitig aufrufen.
- **Fix:** State-Guard: neue Transitions nur wenn vorherige abgeschlossen.

### M2. Timer-Cleanup unvollständig
- **Datei:** `voice-service.ts:317-319`
- **Problem:** `handleEmptyTranscript()` ruft nur `setState('idle')`, aber `clearSilenceTimer()` und `clearConversationTimer()` nicht.
- **Fix:** Timers in `handleEmptyTranscript()` aufräumen.

### M3. Shadow-DOM Zugriff für Hotkey-Input fragil
- **Datei:** `settings.ts:616`
- **Problem:** `hotkeyWrapper.shadowRoot?.querySelector('input')` — bricht wenn Component-Internals sich ändern.
- **Fix:** Public API auf `SarahInput` erweitern (`setReadOnly()`, `onKeydown()`).

### M4. Keyword-Mode crasht ohne Picovoice-Key
- **Datei:** `porcupine-provider.ts:52`, `main.ts:187`
- **Problem:** Leerer `PICOVOICE_ACCESS_KEY` → throw → gesamter VoiceService auf `error`.
- **Fix:** Keyword-Option in Settings nur anzeigen wenn Key konfiguriert, oder graceful degrade.

### M5. better-sqlite3 Node-Version Mismatch
- **Problem:** 15 Tests failen wegen `NODE_MODULE_VERSION 145 vs 137`. 
- **Fix:** `npm rebuild better-sqlite3` oder Electron-Rebuild.

### M6. Default voiceMode ist 'off'
- **Datei:** `wizard.ts:166`, `voice-service.ts:59`
- **Problem:** Wizard setzt `voiceMode: 'off'`. User muss manuell in Settings wechseln.
- **Status:** Bewusste Entscheidung, aber UX-Frage: sollte Wizard Voice-Modus abfragen?

## Niedrig (Cleanup)

### N1. Unused Error-Messages in LLM-Service
- **Datei:** `llm-service.ts:11-16`
- `'no-model'` und `'unavailable'` Keys definiert aber nie emittiert.

### N2. Porcupine silent Fallback auf Built-in Keyword
- **Datei:** `porcupine-provider.ts:43-44`
- Custom `.ppn` nicht gefunden → stiller Fallback ohne Log.

### N3. Debug-Logging noch drin
- **Dateien:** `voice-service.ts`, `hotkey-manager.ts`, `audio-bridge.ts`
- `process.stderr.write` und `console.log` Debug-Ausgaben müssen vor Release raus.

## Test-Lücken

| Bereich | Getestet | Fehlend |
|---------|----------|---------|
| PTT Toggle | Ja (7 Tests) | Hold-to-Talk wenn implementiert |
| Audio-Manager | Ja (7 Tests) | - |
| Voice-Service | Ja (19 Tests) | Silence-Detection, Conversation-Window, alle 4 Abort-Phrases |
| AudioBridge | Nein | Komplett ungetestet |
| AudioWorklet | Nein | Komplett ungetestet |
| Chat→TTS Unterdrückung | Nein | Braucht interactionMode |
| Live-Config-Reload | Nein | Braucht Config-Changed Event |
| State-Propagation | Nein | processing-State zum Renderer |
