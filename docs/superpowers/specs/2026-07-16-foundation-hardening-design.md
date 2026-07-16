# Foundation-Hardening — Design (Spec A)

**Datum:** 2026-07-16 · **Rev. 2** (Copilot-Review F1–F6 eingearbeitet, gegen Code verifiziert)
**Status:** Entwurf, wartet auf Review
**Quelle:** Offene Punkte aus `docs/analyze-fabel.md` §4 + Follow-ups aus PR #18 (Ollama-Docker)

Ziel: Robustheits-Fixes am Bestand, **bevor** neue Features (History & Sessions, Action-Layer) daraufgesetzt werden. Die Spec ist bewusst eine Sammel-Spec; A8 ist die einzige strukturelle Änderung und Vorbedingung für Spec B.

## Nicht-Ziele

- Piper-Server / Temp-WAV (analyze-fabel 4.1/4.2) — wird mit der TTS-Upgrade-Entscheidung behandelt
- VAD-Kalibrierung / Wake-Word (4.6/5.3) — Keyword-Modus ist deaktiviert, eigenes Fass
- Alles aus Spec B (History) und Spec C (Action-Layer)

## Die 8 Fixes

### A1 — `require('electron')` in Callbacks (analyze-fabel 4.3, korrigiert per F1)

Betroffen sind **nur** die Main-Process-UI-Module (verifiziert): `src/main/boot-sequence.ts:152,209` und `src/main/ipc-config.ts:95` (jeweils `const { screen } = require('electron')`). → Top-Level-Imports.

**Ausdrücklich ausgenommen:** `src/core/crypto/key-manager.ts:53,65` — dessen dynamische `safeStorage`-Requires sind **absichtlich** (Fallback außerhalb von Electron, trägt die bestehenden Node-Tests). Bleibt unangetastet; eine injizierbare `safeStorage`-Abstraktion wäre ein eigener Task, kein Hardening-Beifang.

### A2 — VramManager: toter `_load`-Parameter (4.4)

`swapModels(unload, _load)` → Signatur auf `swapModels(unload)` verengen, Aufrufer anpassen, Kommentar (Ollama lädt beim nächsten Request selbst) bleibt an der Methode.

### A3 — IPC-Input-Validierung mit Rückgabevertrag (4.5, erweitert per F2)

Nicht nur der `mode`-Cast in `ipc-voice.ts` — alle Renderer-Eingaben werden gehärtet. Bekannte Kandidaten (der Plan erhebt die vollständige Liste): `chat-message` (String, Längenlimit), `voice-audio-chunk` (echtes Array, endliche Zahlenwerte, Maximalgröße — Guard **vor** der `Float32Array`-Konstruktion), `select-folder` (optionaler String), `open-dialog`.

**Rückgabevertrag statt stillem Return:** `invoke`-basierte Handler liefern bei ungültigem Payload einen strukturierten Fehler (`{ ok: false, error: '…' }` bzw. den kanalüblichen Fehlwert), damit der Renderer nicht kommentarlos `undefined` bekommt. Send-basierte Handler: früher Return + `console.warn`. Guards laufen vor Service-Aufrufen und Dateisystemzugriffen.

### A4 — Retry bei LLM-Timeout, aber nur mit Abbruch (4.7, verschärft per F3)

**Verifizierter Ist-Zustand:** `chatWithTimeout()` nutzt `Promise.race` — nach einem Timeout läuft `provider.chat()` samt Fetch/Stream **weiter** und sendet weiter Chunks (die sogar den Timeout-Timer zurücksetzen). Ein naiver Retry erzeugt zwei parallele Ollama-Streams mit vermischtem Text.

Fix daher zweistufig:

1. `LlmProvider.chat()` bekommt ein `AbortSignal` (durchgereicht bis zum Ollama-Fetch). Bei Timeout: laufenden Request abbrechen, **weitere Chunks des abgebrochenen Versuchs ignorieren** (Guard im onChunk-Wrapper).
2. Danach genau **ein** Retry — nur bei Timeout, nicht bei Verbindungsfehlern, und nicht, wenn vor dem Timeout schon Chunks beim Nutzer ankamen (sonst doppelter Text).

### A5 — VoiceService stirbt lautlos → Fähigkeits-Status (PR-#18-Follow-up a, präzisiert per F4)

**Verifizierter Ist-Zustand:** `stt.init()`, `tts.init()`, `setupMode()`, TtsQueue-Aufbau stehen in **einem** try — ein Piper-Fehler überspringt auch Hotkey-Registrierung und Queue; der Service-Status kann nicht gleichzeitig `error` und teilfunktional sein. Es gibt zudem kein Registry-weites Status-Event, das ein Cockpit abonniert.

Fix:

1. **Getrennte Fähigkeiten:** Init in unabhängige Schritte teilen (STT / TTS / Hotkeys+Mode). TTS-Fehler → TTS deaktiviert, STT/Push-to-Talk laufen; `setupMode()` und Hotkeys werden trotzdem ausgeführt.
2. **Neues Bus-Event `voice:capability`** `{ stt: boolean, tts: boolean }` — an Renderer geforwardet, Cockpit zeigt den Teilausfall (konkrete Anzeige: bestehende Status-Zeile des Voice-Panels).
3. **Kein Hängen ohne TTS:** Der Antwortzyklus (inkl. `llm:done`) kehrt sauber nach `idle` zurück, ohne auf eine nie existierende TTS-Queue zu warten.

### A6 — Boot-Fehler sehen aus wie Ladeanimationen (PR-#18-Follow-up b, präzisiert per F5)

**Verifizierter Übertragungsweg:** Boot-Meldungen laufen **nicht** über den MessageBus, sondern direkt `webContents.send('boot-status', …)` → `preload.ts` → Boot-Renderer; der Typ `BootStatus` liegt in `src/core/sarah-api.ts`, der Renderer hält zusätzlich ein **eigenes lokales** `BootStatus`-Interface (`renderer/dashboard/boot-sequence.ts:18`).

Fix als ein zusammenhängender Slice: `severity: 'info' | 'warning' | 'error'` am `BootStatus`-Typ in `sarah-api.ts` **und** am lokalen Renderer-Interface ergänzen, Sender in `main/boot-sequence.ts` setzen severity, Renderer stellt `warning` gelb-unanimiert, `error` in `--cockpit-accent-red` unanimiert dar. Einstufung: Container-/Router-Fehler = `error`, CPU-Modus-Warnung = `warning`, Rest = `info`. Das bestehende 3s-Dwell gilt je Meldung genau einmal und darf die nachfolgende `router-ready`-Sequenz nur verzögern, nie verschlucken.

### A7 — Router-Fehler trotz laufendem Container wird verschluckt (PR-#18-Follow-up c)

`routerService.init()` wirft bei nicht erreichbarem Ollama nicht — es setzt `status = 'error'` und resolved; der `catch` im Boot greift nur bei geworfenen Fehlern. Fix: Nach `await routerReady` zusätzlich `routerService.status === 'error'` prüfen → Boot-Meldung mit `severity: 'error'` (A6-Pfad); Orb-Reveal läuft weiter, LLM-Funktionen melden sich als gestört. **Voraussetzung: der eine Init-Pfad aus A8** — der Status-Check muss nach dem tatsächlich letzten Init erfolgen.

### A8 — Doppelte Service-Initialisierung beenden (neu per F6)

**Verifizierter Ist-Zustand:** Der Boot ruft `routerService.init()` (und `whisperProvider.init()`) eager auf und später `registry.initAll()`, das registrierte Services **erneut** initialisiert — der Code verlässt sich auf Idempotenz per Kommentar („double-calling is safe"). Mit Sessions (Spec B: eine Conversation pro Start!), Subscriptions und Fehlerstatus ist das nicht mehr harmlos.

Fix: `init()` der betroffenen Services wird **einmalig** — beim ersten Aufruf entsteht ein Ready-Promise, jeder weitere Aufruf gibt dasselbe Promise zurück (kein zweiter Durchlauf). Test weist nach: genau **ein** Router-Init pro App-Start, egal wie oft init() gerufen wird. Das ist die harte Vorbedingung für Spec B (H3).

## Tests

- A2: bestehende VramManager-Tests anpassen
- A3: je Kanal gültig / ungültiger Typ / Überlänge / Riesen-Array; Rückgabevertrag (strukturierter Fehler statt `undefined`)
- A4: Timeout → Abort → ein Retry → Erfolg; Timeout → Retry → Timeout → Fehler; **verspäteter Chunk des abgebrochenen ersten Versuchs wird ignoriert**; Chunks vor Timeout gestreamt → kein Retry; Verbindungsfehler → kein Retry
- A5: TTS-Init-Fehler → `voice:capability { stt: true, tts: false }`, Hotkeys aktiv, kompletter Anfragezyklus (PTT → STT → LLM → `llm:done`) endet in `idle`
- A6/A7: Severity-Ableitung (Router error + Container ok → `error`; CPU-Modus → `warning`); Optik manuell (Martin)
- A8: `init()` doppelt gerufen → ein Durchlauf, ein Warmup, dasselbe Ready-Promise

## Reihenfolge

Ein Branch `fix/foundation-hardening`, ein PR, Commits pro Fix. A8 vor A7 umsetzen (Abhängigkeit). Umsetzung **vor** Spec B und Spec C.
