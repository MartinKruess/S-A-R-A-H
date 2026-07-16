# Foundation-Hardening — Design (Spec A)

**Datum:** 2026-07-16
**Status:** Entwurf, wartet auf Review
**Quelle:** Offene Punkte aus `docs/analyze-fabel.md` §4 + Follow-ups aus PR #18 (Ollama-Docker)

Ziel: Robustheits-Fixes am Bestand, **bevor** neue Features (History & Sessions, Action-Layer) daraufgesetzt werden. Alle Punkte sind klein und unabhängig voneinander; die Spec ist bewusst eine Sammel-Spec.

## Nicht-Ziele

- Piper-Server / Temp-WAV (analyze-fabel 4.1/4.2) — wird mit der TTS-Upgrade-Entscheidung behandelt, kein Invest in den Platzhalter
- VAD-Kalibrierung / Wake-Word (4.6/5.3) — Keyword-Modus ist deaktiviert, eigenes Fass
- Alles aus Spec B (History) und Spec C (Action-Layer)

## Die 7 Fixes

### A1 — `require('electron')` in Callbacks (analyze-fabel 4.3)

`const { screen } = require('electron')` innerhalb von `setInterval`/`ipcMain.once`-Callbacks (`src/main/boot-sequence.ts`, `src/main.ts` — exakte Zeilen verifiziert der Plan, die Analyse-Zeilennummern sind von vor dem Merge). → Top-Level-Imports. Reiner Stil-Fix, kein Verhaltensänderung.

### A2 — VramManager: toter `_load`-Parameter (4.4)

`swapModels(unload, _load)` → Signatur auf `swapModels(unload)` verengen, Aufrufer anpassen, Kommentar (Ollama lädt beim nächsten Request selbst) bleibt an der Methode.

### A3 — IPC-Input-Validierung (4.5)

`mode as 'chat' | 'voice'` in `src/main/ipc-voice.ts` → Runtime-Check mit frühem Return bei ungültigem Wert. Gleichzeitig alle anderen IPC-Handler mit ungeprüften Renderer-Parametern sichten (der Plan listet sie auf) und mit demselben Muster härten: validieren, bei Fehler still returnen + `console.warn`. Kein Zod nötig — einfache Guards reichen bei den kleinen Payloads.

### A4 — Retry bei LLM-Timeout (4.7)

`chat-with-timeout.ts`: Nach einem Timeout **ein** automatischer Retry, danach die bestehende Fehlermeldung. Der Retry gilt nur für Timeout, nicht für Verbindungsfehler (Ollama weg → sofort ehrlich melden). Kein Retry mitten im Stream: Kamen schon Chunks beim Nutzer an, wird nicht wiederholt (sonst doppelter Text) — dann bleibt es beim Fehler.

### A5 — VoiceService stirbt lautlos (PR-#18-Follow-up a)

`VoiceService.init` bricht bei einem Piper-Fehler komplett ab — der Voice-Pfad ist tot, ohne UI-Meldung. Fix in zwei Teilen:

1. **Teilausfall statt Totalausfall:** Piper-Fehler deaktiviert nur TTS (Sarah antwortet dann eben stumm/als Text), STT/Push-to-Talk bleiben funktionsfähig — sofern technisch unabhängig (der Plan verifiziert die Init-Abhängigkeiten).
2. **Sichtbarer Status:** Fehlerzustand landet als Service-Status (`error`) im Registry und als Bus-Event, das im Cockpit sichtbar ist (bestehender Status-Mechanismus, keine neue UI).

### A6 — Boot-Fehler sehen aus wie Ladeanimationen (PR-#18-Follow-up b)

Fehlermeldungen in der Boot-Sequenz nutzen denselben animierten Lade-Stil wie Fortschrittsmeldungen — der Nutzer erkennt nicht, dass etwas schiefging. Fix: `boot-status`-IPC bekommt ein `severity: 'info' | 'error'`-Feld; der Renderer stellt `error` unanimiert und in der Error-Farbe (`--cockpit-accent-red`, frozen Token) dar. Bestehende 3s-Dwell-Logik bleibt.

### A7 — Router-Fehler trotz laufendem Container wird verschluckt (PR-#18-Follow-up c)

In `boot-sequence.ts` setzt der `catch` um `containerManager.ensureRunning().then(() => routerService.init())` nur bei **geworfenen** Fehlern `containerError`. `routerService.init()` wirft aber nicht, wenn Ollama nicht erreichbar ist — es setzt `status = 'error'` und resolved normal. Ergebnis: Container läuft, Router ist tot, Boot zeigt nichts. Fix: Nach `await routerReady` zusätzlich `routerService.status === 'error'` prüfen → Boot-Warnung über den A6-Fehlerpfad (severity error), Orb-Reveal läuft trotzdem weiter (App bleibt bedienbar, nur LLM-Funktionen melden sich als gestört).

## Tests

- A2: bestehende VramManager-Tests anpassen
- A3: Unit-Tests je gehärtetem Handler (gültig / ungültig / fehlend)
- A4: Timeout → ein Retry → Erfolg; Timeout → Retry → Timeout → Fehler; Chunks bereits gestreamt → kein Retry; Verbindungsfehler → kein Retry
- A5: Piper-Init-Fehler → Status `error`, STT-Init läuft weiter, Bus-Event emittiert
- A6/A7: Unit-Test für die Status-Ableitung (`router error` + Container ok → severity error); Optik manuell (Martin)

## Reihenfolge

Ein Branch `fix/foundation-hardening`, ein PR, Commits pro Fix (A1–A7 sind unabhängig). Umsetzung **vor** Spec B und Spec C.
