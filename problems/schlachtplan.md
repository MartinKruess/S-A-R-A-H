# Schlachtplan: S.A.R.A.H. Stabilisierung

Stand: 2026-04-09

## Strategie

Von innen nach außen fixen — erst die Grundlagen reparieren, dann die Integration,
dann die UX. Jeder Schritt muss verifizierbar sein bevor der nächste beginnt.

---

## Phase 1: Grundlagen (Main-Process stabilisieren)

Ziel: VoiceService-Kern funktioniert korrekt, States sind sauber.

### 1.1 Voice-State vollständig propagieren
- **Problem:** K4 — `setState()` emittiert kein Event, `processing` fehlt im Renderer
- **Dateien:** `voice-service.ts`, `main.ts`
- **Fix:** `setState()` emittiert `voice:state` direkt über den Bus. `voiceStateMap` in main.ts entfernen — wird nicht mehr gebraucht.
- **Verify:** Log im Renderer zeigt alle States: idle → listening → processing → speaking → idle

### 1.2 Timer-Cleanup fixen
- **Problem:** M2 — `handleEmptyTranscript()` räumt Timer nicht auf
- **Datei:** `voice-service.ts`
- **Fix:** `clearSilenceTimer()` und `clearConversationTimer()` in `handleEmptyTranscript()` aufrufen
- **Verify:** Bestehende Tests laufen, kein Timer-Leak

### 1.3 Playback-Done Promise absichern
- **Problem:** H2 — Promise kann hängen, unsub nicht idempotent
- **Datei:** `voice-service.ts`
- **Fix:** Cleanup-Flag, unsub wird nur einmal aufgerufen
- **Verify:** TTS-Playback endet sauber, kein Hänger

### 1.4 Ollama JSON-Parsing absichern
- **Problem:** H3 — `JSON.parse` ohne try-catch
- **Datei:** `ollama-provider.ts`
- **Fix:** try-catch, kaputte Zeilen skippen mit console.warn
- **Verify:** Chat funktioniert auch bei Ollama-Glitches

---

## Phase 2: Renderer-Grundlagen (Audio-Pipeline zum Laufen bringen)

Ziel: Mic-Aufnahme funktioniert, Audio kommt im Main-Process an.

### 2.1 CSP fixen
- **Problem:** K1 — `getUserMedia` und AudioWorklet werden möglicherweise blockiert
- **Datei:** `dashboard.html`
- **Fix:** CSP erweitern: `media-src 'self'`
- **Verify:** DevTools Console zeigt keine CSP-Errors, `getUserMedia` resolved

### 2.2 AudioBridge Lifecycle fixen
- **Problem:** H4 — kein Cleanup bei Window-Close
- **Datei:** `dashboard.ts`
- **Fix:** `beforeunload`-Handler, `audioBridge.destroy()` aufrufen
- **Verify:** Kein Media-Stream-Leak nach Window-Reload

### 2.3 Audio-Capture Ende-zu-Ende testen
- **Dateien:** `audio-bridge.ts`, `audio-worklet-processor.ts`
- **Verify:**
  1. F9 drücken (Toggle-Start)
  2. DevTools: `[AudioBridge] state → listening`, `Capture active`
  3. Terminal: Audio-Chunks kommen an (Log in feedAudioChunk)
  4. F9 nochmal drücken (Toggle-Stop)
  5. Terminal: Whisper transkribiert, Transcript erscheint

---

## Phase 3: Integration (Chat und Voice verbinden)

Ziel: Chat-Modus und Voice-Modus arbeiten korrekt zusammen.

### 3.1 InteractionMode einführen
- **Problem:** K2 — VoiceService weiß nicht ob Chat oder Voice aktiv ist
- **Dateien:** `preload.ts`, `main.ts`, `voice-service.ts`, `dashboard.ts`
- **Design:**
  - Neuer IPC-Channel: `voice-set-interaction-mode` (chat | voice)
  - VoiceService bekommt `interactionMode` Property
  - Bei `interactionMode === 'chat'`: TTS wird unterdrückt
  - Dashboard sendet Mode-Wechsel wenn Chat-Button getoggelt wird
- **Verify:** Chat-Modus = nur Text, Voice-Modus = Text + Sprache

### 3.2 Voice-Transcript als Chat-Bubble anzeigen
- **Problem:** H5 — `onTranscript` exponiert aber nicht genutzt
- **Datei:** `dashboard.ts`
- **Fix:** `sarah.voice.onTranscript` nutzen, User-Bubble erstellen
- **Verify:** Spracheingabe erscheint als User-Bubble im Chat

### 3.3 Settings live anwenden
- **Problem:** H1 — Config-Änderungen erst nach Neustart aktiv
- **Dateien:** `main.ts`, `voice-service.ts`, `settings.ts`
- **Fix:**
  - IPC-Event `voice-config-changed` wenn Settings gespeichert werden
  - VoiceService: `applyConfig()` Methode die Hotkey/Mode neu verdrahtet
- **Verify:** Voice-Mode in Settings ändern → sofort aktiv ohne Neustart

---

## Phase 4: UX-Fixes

Ziel: Bedienung fühlt sich richtig an.

### 4.1 PTT Hold-to-Talk mit uiohook-napi
- **Problem:** K3 — Electron globalShortcut kann kein keyup
- **Dateien:** `hotkey-manager.ts`, `package.json`
- **Fix:**
  - `uiohook-napi` installieren
  - HotkeyManager auf echtes keydown/keyup umbauen
  - Debounce entfernen
  - Fallback: Toggle-Modus als Option behalten
- **Verify:** F9 halten = aufnehmen, F9 loslassen = verarbeiten

### 4.2 Keyword-Mode in UI blocken
- **Problem:** K5, M4 — Wake-Word ist nicht funktional
- **Datei:** `settings.ts`
- **Fix:** Keyword-Option ausgrauen/entfernen bis Wake-Word implementiert ist
- **Verify:** Nur "Aus" und "Push-to-Talk" wählbar

### 4.3 System-Prompt Verhalten testen
- **Problem:** H6 — Sarah plappert Config nach
- **Datei:** `llm-service.ts`
- **Fix:** Instruktion testen, ggf. verstärken
- **Verify:** "Hallo" → kurze natürliche Begrüßung ohne Config-Dump

---

## Phase 5: Cleanup

### 5.1 Debug-Logging entfernen
- `process.stderr.write` und Debug-`console.log` aus allen Dateien

### 5.2 Tests aktualisieren
- HotkeyManager-Tests auf neues Verhalten anpassen
- AudioBridge-Tests schreiben
- State-Propagation testen
- InteractionMode testen
- `npm rebuild better-sqlite3` für DB-Tests

### 5.3 Spec aktualisieren
- Spec an tatsächliche Implementierung angleichen
- Toggle vs Hold dokumentieren
- InteractionMode dokumentieren

---

## Reihenfolge und Abhängigkeiten

```
Phase 1 (Main-Process)     → kann sofort starten
  1.1 State-Propagation
  1.2 Timer-Cleanup
  1.3 Playback-Promise
  1.4 JSON-Parsing

Phase 2 (Renderer)          → nach Phase 1
  2.1 CSP Fix
  2.2 AudioBridge Lifecycle
  2.3 E2E Audio-Test

Phase 3 (Integration)       → nach Phase 2
  3.1 InteractionMode
  3.2 Transcript-Bubble
  3.3 Live-Settings

Phase 4 (UX)                → nach Phase 3
  4.1 Hold-to-Talk
  4.2 Keyword blocken
  4.3 Prompt-Test

Phase 5 (Cleanup)           → nach Phase 4
  5.1 Debug-Logs raus
  5.2 Tests
  5.3 Spec
```

## Geschätzter Aufwand pro Phase

- Phase 1: klein (4 gezielte Fixes in bekannten Dateien)
- Phase 2: klein (CSP + Lifecycle + Verify)
- Phase 3: mittel (neues Konzept interactionMode + IPC)
- Phase 4: mittel (neues npm-Paket uiohook-napi + Umbau)
- Phase 5: klein-mittel (Tests + Cleanup)
