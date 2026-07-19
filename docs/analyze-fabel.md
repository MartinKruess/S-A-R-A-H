# S.A.R.A.H. — Projektanalyse
_Erstellt 2026-07-15 mit Claude Fabel 5_

> **Update 2026-07-19 — vieles davon ist inzwischen umgesetzt.** Seit dieser Analyse gebaut & auf `dev`: **Action-Execution-Layer** (Programme öffnen, Lautstärke, Timer, Websuche, Bildschirm sperren — behebt §5.1, „die wichtigste Lücke"), **History/Sessions** (Persistenz + Start-Kontext — §3.3/§3.4/§5.2), **appx-Start** für Store-Apps (§6), **STT-Qualität** (Pegel/VAD/`large-v3-turbo`/Warm-Mic), **Füllsätze** und **Integrationen/OAuth** (Spotify-Lautstärke). ✅-Marker unten ergänzt. **Aktuelle Plan-/Bug-Liste: [`features.md`](../problems/features.md)**, nicht mehr dieses Dokument.

---

## 1. Projektüberblick

S.A.R.A.H. (Smart Assistant for Resource and Administration Handling) ist eine Electron-Desktop-App für Windows, aufgebaut auf TypeScript, mit lokalen LLMs via Ollama und einer vollständig selbst entwickelten Komponentenbibliothek.

**Aktueller Stack:**
- Electron 41 + TypeScript + esbuild (Renderer)
- Voice: faster-whisper (GPU, Python-Server) → Routing-LLM (phi4-mini 3.8B) → Worker-LLM (qwen3:8b) → Piper TTS
- Storage: SQLite (verschlüsselt, better-sqlite3) + JSON (verschlüsselt, AES-256-GCM)
- Hardware-Ziel: RTX 3050 8GB VRAM

**Was funktioniert (Stand Analyse):**
- Push-to-Talk (F9) → Sprache → Text → Routing → LLM-Antwort → Sprache zurück
- Dual-LLM-Routing: 2B-Router entscheidet, 9B-Worker übernimmt bei Bedarf
- VRAM-Management: Modelle werden per Ollama-API gewechselt
- Satzweises TTS-Streaming (SentenceBuffer + TtsQueue mit Pre-Buffering)
- Boot-Sequenz mit stufenweisem Fortschritts-Feedback
- Setup-Wizard, verschlüsselte Einstellungen, Custom HUD-Komponenten

---

## 2. Performance-Baseline (gemessen 2026-04-13)

| Zustand | Gesamt | Whisper | Router | Worker | TTS |
|---------|--------|---------|--------|--------|-----|
| Kaltstart | ~14s | ~978ms | ~4.7s | ~6.8s | ~1.8s |
| Warmstart | ~5.4s | ~485ms | — | ~2.9s | ~2.0s |

**Bewertung:** 5.4s Warmstart-Latenz (erstes Wort hörbar) ist für lokale Hardware auf einer RTX 3050 objektiv gut. Zum Vergleich: Cloud-APIs liegen oft bei 800–2000ms, dafür aber ohne VRAM-Limits und Datenschutzbedenken.

**Aktuelle Bottlenecks:**
1. TTS (Piper): ~1.8s — Piper startet für jeden Satz einen neuen Prozess. Ein persistenter Piper-Server würde pro Satz ca. 80–150ms einsparen.
2. Router-Kaltstart (~4.7s): Nur beim allerersten Aufruf. Warmup beim Boot löst das bereits.
3. Worker-Kaltstart (wenn 9B geladen werden muss): ~6.8s. Unvermeidbar bei VRAM-Swap.

---

## 3. Kritische Bugs — sofortige Priorität

### ✅ ERLEDIGT (9c705a5) — 3.1 `boot-done` IPC-Handler doppelt registriert
**Dateien:** `src/main.ts:144` und `src/main/boot-sequence.ts:176`

Beide registrieren `ipcMain.once('boot-done', ...)` mit identischem Fenster-Animations-Code. `once` stellt sicher, dass nur der erste Handler feuert — der zweite ist totes Code und wird nie aufgerufen. Das ist kein sichtbarer Bug heute, wird aber zum Problem, sobald jemand einen der Blöcke anpasst. Einer der beiden Blöcke muss entfernt werden.

### ✅ ERLEDIGT (9c705a5) — 3.2 `spawn('python', ...)` — keine Garantie dass Python verfügbar ist
**Datei:** `src/services/voice/providers/faster-whisper-provider.ts:38`

Der Code ruft `spawn('python', [...])` auf und geht davon aus, dass `python` im PATH liegt. Auf Windows ist das oft `python3`, oder es ist eine Windows-Store-Stub-App, oder gar nicht vorhanden. Wenn Python nicht gefunden wird, schlägt der Spawn lautlos fehl (der `on('error')` Handler loggt es nur) — aber der `waitForServer()` dreht 5 Minuten lang (`STARTUP_TIMEOUT_MS = 300_000`) im 500ms-Poll-Takt, bevor ein Fehler geworfen wird. Das hängt die App bei nicht vorhandenem Python für 5 Minuten.

**Fix:** `STARTUP_TIMEOUT_MS` auf 30s reduzieren; Spawn-Error sollte sofort das Init abbrechen.

### ✅ ERLEDIGT (History/Sessions, PR #22) — 3.3 Gesprächshistorie geht bei jedem Neustart verloren
**Datei:** `src/services/llm/router-service.ts:29`

`this.history: ChatMessage[]` lebt nur im Speicher. Nachrichten werden zwar in SQLite gespeichert (`conversation_id: 1` — immer dieselbe Konversation), aber beim Start werden sie nie zurückgelesen. S.A.R.A.H. hat nach jedem Neustart Amnesie — kein Kontext aus früheren Sessions.

### ✅ ERLEDIGT (History/Sessions, PR #22) — 3.4 `conversation_id: 1` hartcodiert
**Datei:** `src/services/llm/router-service.ts:79,107,141`

Alle Nachrichten gehen in dieselbe Konversation. Kein Multi-Session-Support möglich. Muss gelöst werden, bevor History-Recovery implementiert wird.

### ✅ ERLEDIGT (9c705a5, Test in cd58c15) — 3.5 Unbekannte Route fällt auf `[ROUTE:self]` zurück
**Datei:** `src/services/llm/route-parser.ts:19`

Gibt das Routing-Modell eine unbekannte Route (`[ROUTE:xyz]`) zurück, wird sie silently auf `self` gemappt — das heißt, der 2B-Router antwortet selbst, anstatt zur 9B-Instanz zu eskalieren. Bei schlecht geformten Antworten des 4B-Modells können so komplexe Aufgaben falsch behandelt werden.

**Fix:** Fallback auf `'9b'` statt `'self'` ist sicherer. "Im Zweifel eskalieren."

---

## 4. Code-Qualität — mittlere Priorität

### 4.1 Piper spawnt pro Satz einen neuen Prozess
**Datei:** `src/services/voice/providers/piper-provider.ts:37`

Für jeden Satz wird ein neues `piper.exe` gestartet. Prozessstart-Overhead auf Windows: 50–150ms. Bei einer 5-Satz-Antwort summiert sich das auf 250–750ms extra Latenz. Ein persistenter Piper-HTTP-Server (wie faster-whisper) würde das auf <10ms reduzieren.

### 4.2 Temp-WAV-Datei statt In-Memory-Transfer
**Datei:** `src/services/voice/providers/faster-whisper-provider.ts:63-68`

Für jede Transkription wird eine WAV-Datei auf Disk geschrieben (`%TEMP%/sarah-stt-{timestamp}.wav`). Das ist funktional, aber unnötig I/O-intensiv. Der faster-whisper-Server könnte auch multipart/form-data direkt im Speicher empfangen. Für die aktuelle Nutzungsfrequenz kein kritisches Problem, aber bei häufigen Kurznachrichten könnte das SSD-Verschleiß verursachen.

### 4.3 `require('electron')` innerhalb von Callbacks
**Dateien:** `src/main/boot-sequence.ts:123`, `src/main.ts:148`

`const { screen } = require('electron')` innerhalb von `setInterval`/`ipcMain.once` Callbacks. CommonJS erlaubt das, aber es ist schlechter Stil. Als Top-Level-Import sollte das stehen.

### 4.4 VramManager `_load`-Parameter ist toter Code
**Datei:** `src/services/llm/vram-manager.ts:41`

`swapModels(unload: string, _load: string)` — der `_load` Parameter ist ungenutzt. Kommentar erklärt das (Ollama lädt das Modell beim nächsten Request selbst), aber die Methode sollte dann nur `unload` akzeptieren, um die Absicht zu verdeutlichen.

### 4.5 Kein Input-Validation auf IPC-Handlern
**Datei:** `src/main/ipc-voice.ts:30`

`_event, mode: string` wird direkt zu einem Typ gecastet: `mode as 'chat' | 'voice'`. Durch `contextIsolation: true` und `sandbox: true` ist das in der Praxis sicher, aber ein Runtime-Check (`if (mode !== 'chat' && mode !== 'voice') return;`) macht den Code robuster.

### 4.6 Silence-VAD mit fixen Schwellenwert
**Datei:** `src/services/voice/voice-service.ts:23`

`SILENCE_RMS_THRESHOLD = 0.01` ist unkalibriert. In lauten Umgebungen (Hintergrundlärm, Lüfter) wird Stille nie erkannt → der Silence-Timer löst nie aus. Das betrifft nur den Keyword-Modus (der aktuell deaktiviert ist), aber für künftige Keyword/Always-on-Modi muss eine adaptive VAD her.

### 4.7 Kein Retry bei LLM-Timeout
**Datei:** `src/services/llm/chat-with-timeout.ts:4`

`STREAM_TIMEOUT_MS = 120_000` (2 Minuten). Wenn Ollama hängt oder der Worker gerade geladen wird, bekommt der Nutzer nach 2 Minuten eine Fehlermeldung — kein Retry, kein "Ich versuche es nochmal". Ein einmaliger Retry nach Timeout wäre UX-freundlicher.

---

## 5. Architekturelle Lücken — hohe strategische Priorität

### ✅ ERLEDIGT (Action-Layer V1, PR #23) — 5.1 Router-Routing ist unvollständig — kein Action-Execution-Layer
**War die wichtigste Lücke — jetzt gebaut:** `[ACTION:name:param]`-Tags; der `ActionService` führt open_program / web_search / show_browser / set_volume / set_timer / lock_screen (+ Spotify) real aus. Statt reinem Feedback-Text emittiert der Router jetzt echte Aktionen.

Der Router sagt `[ROUTE:self]` für "Öffne Chrome" — der RouterService emittiert dann den Feedback-Text als LLM-Antwort. S.A.R.A.H. sagt also "Natürlich, ich öffne Chrome!" aber Chrome öffnet sich nicht. Die `ipc-programs.ts` und der Programm-Scan existieren, sind aber nicht mit der Voice/Chat-Pipeline verbunden.

Es fehlt eine **Intent-Execution-Schicht**: Wenn der Router `[ROUTE:self]` + eine Aktion erkennt (Programm öffnen, Lautstärke ändern, etc.), muss eine strukturierte Intent-Extraktion folgen, die dann echte Aktionen auslöst.

**Vorschlag:** Router gibt statt reinem Feedback-Text ein JSON aus:
```json
{ "route": "self", "intent": "open_program", "target": "Chrome", "feedback": "Natürlich!" }
```

### ✅ ERLEDIGT (History/Sessions, PR #22) — 5.2 History-Recovery fehlt komplett
SQLite-DB speichert alle Nachrichten, aber nach Neustart wird nie geladen. Das macht S.A.R.A.H. als "persönlichen Assistenten" eingeschränkt — sie erinnert sich nicht an Dinge von gestern.

### 5.3 Keyword/Wake-Word-Modus ist nicht funktionsfähig
**Datei:** `src/services/voice/voice-service.ts:92`

```typescript
this.voiceMode = rawMode === 'keyword' ? 'off' : rawMode;
```

Keyword-Modus wird beim Init silently deaktiviert. Porcupine benötigt einen API-Key (Picovoice, kostenpflichtig ab gewissem Volumen). Der Key kommt aus `process.env.PICOVOICE_ACCESS_KEY ?? ''` — kein Setup im Wizard, kein UI-Hinweis. Für "always-on Sarah" ist das ein wichtiges Feature, das noch ganz am Anfang steht.

### 5.4 Keine persistente Kontext-Strategie für lange Sessions
`MAX_CONTEXT_TOKENS = 120_000` — der Context-Window-Trimmer schneidet ältere Nachrichten raus. Für kurze Sessions ist das fine. Für echte Langzeit-Sessions (ganzer Arbeitstag) braucht es eine smarte Zusammenfassung statt hartem Trim.

### 5.5 Keine Tool-Calls / Structured Output
Das LLM antwortet nur in Freitext. Für Aktionen wie "E-Mail verfassen", "Kalender-Eintrag erstellen", "Datei umbenennen" braucht es strukturierte Ausgaben. Ohne das ist S.A.R.A.H. ein gesprächiger Assistent, aber kein Assistent der Dinge _tut_.

---

## 6. Bekannte offene Bugs (aus Notizen)

- **Discord**: Pfad zeigt auf `Update.exe` statt die eigentliche App
- **PDF-Launcher**: `PDFLauncher.exe` ist ein Launcher, nicht das Hauptprogramm
- ✅ **Windows Store Apps** (appx): eigene Launch-Logik gebaut — `explorer.exe shell:AppsFolder\<AUMID>` + `tasklist`-Verifikation (PR #23).
- **OpenOffice**: Mehrere Aliase (`soffice.exe`, `scalc.exe`, `swriter.exe`) überschneiden sich (Matcher fragt bei Mehrdeutigkeit nach; Überschneidung selbst bleibt)
- **RocketLeague**: Direktstart möglicherweise instabil (Anti-Cheat)

---

## 7. Weg zu "Jarvis" — Was noch fehlt

Das Ziel: S.A.R.A.H. soll alles können was man möchte — Programme steuern, E-Mails bearbeiten, Browser bedienen, Informationen abrufen — bei hoher Sicherheit.

### Kurzfristig erreichbar (nächste 2–4 Wochen)
| Feature | Aufwand | Risiko |
|---------|---------|--------|
| ✅ History-Recovery beim Start | — | erledigt (PR #22) |
| ✅ Action-Execution für Programm-Start | — | erledigt (PR #23) |
| Piper als persistenter Server | M | Niedrig |
| Mic-Auswahl in Settings | S | Niedrig |
| ✅ Boot-done Doppel-Handler fixen | — | erledigt |
| ✅ Python-Startup-Timeout (Spawn-Abort) | — | Spawn-Abort erledigt; Timeout bleibt (Modell-Download) |

### Mittelfristig (1–3 Monate)
| Feature | Aufwand | Abhängigkeit |
|---------|---------|-------------|
| ✅ Intent-Extraktion (Action-Layer, `[ACTION:]`-Tags) | — | erledigt (PR #23) |
| ✅ Windows AppX Launch-Logik | — | erledigt (PR #23) |
| E-Mail-Integration (IMAP/OAuth) | L | OAuth-Layer existiert jetzt (Integrationen) |
| TTS-Upgrade (Coqui → ElevenLabs) | M | Budget |
| Keyword/Wake-Word (Porcupine oder Open-Source-Alternative) | M | API-Key oder lokales Modell |
| Claude Code API Anbindung | M | API-Key, Routing-Erweiterung |
| Backend-Route (Cloud/Server) | L | Infrastruktur |

### Langfristig / schwierig
| Feature | Aufwand | Herausforderung |
|---------|---------|----------------|
| Browser-Steuerung | XL | CDP-Integration in Electron BrowserView |
| UI-Automation (Programme bedienen) | XL | WinAPI UIAutomation / Accessibility APIs |
| Vision/Multi-Modal | XL | RTX 3050 8GB zu klein für Omni-Modelle; Cloud nötig |
| Immer-an (ohne Push-to-Talk) | L | VAD, Datenschutz, Energieverbrauch |

---

## 8. Gesamtbewertung

**Stärken:**
- Architektur ist sauber getrennt (Bus, Services, IPC, Provider)
- Interfaces für STT/TTS/WakeWord existieren → Provider austauschbar
- Performance für lokale Hardware ist respektabel (5.4s warm)
- Dual-LLM Routing funktioniert und ist durchdacht
- Code-Qualität im Kern (bus-events, message-bus, service-registry) ist gut

**Schwächen (Stand 2026-07-19):**
- ✅ ~~Kein Action-Execution-Layer~~ → gebaut (Action-Layer V1)
- ✅ ~~Session-Persistenz fehlt~~ → History/Sessions gebaut
- Python-Dependency: Spawn bricht bei fehlendem Python jetzt sofort ab; STT-Startup-Timeout bleibt hoch (Modell-Download) — teilweise
- TTS (Piper) ist Platzhalter-Qualität, Prozess-Overhead akkumuliert — offen
- Keyword-Modus komplett nicht funktionsfähig (deaktiviert) — offen

**Fazit (Stand 2026-07-19):** Das Fundament ist solide, die Voice-Pipeline funktioniert — und der damals fehlende **Action-Execution-Layer ist gebaut**: S.A.R.A.H. _handelt_ jetzt (öffnet Programme, steuert Lautstärke/Spotify, sucht, stellt Timer, sperrt den Bildschirm) und _erinnert sich_ über Neustarts (History/Sessions). Aus „sprechend, nicht handelnd" ist „sprechend **und** handelnd" geworden. Nächste Schritte laufen über [`features.md`](../problems/features.md): Spotify-Transport (V2), weitere Integrationen, TTS-Upgrade, Wake-Word.
