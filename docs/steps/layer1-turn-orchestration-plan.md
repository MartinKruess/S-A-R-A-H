# Sarah – Layer 1: Turn-, IPC- und Ereignis-Orchestrierung

**Stand:** 26.08.2026
**Branch:** `codex/layer1-turn-orchestration`
**Ziel:** Jede Eingabe, Modellantwort, Aktion und Sprachausgabe gehört eindeutig zu genau einem Turn; Parallelität, verspätete Ergebnisse und Unterbrechungen können keine neue Unterhaltung verunreinigen.

## Abgrenzung

Layer 1 baut die gemeinsame operative Pipeline zwischen Chat, Voice, Router, Worker, Actions, TTS und Renderer. Nicht Bestandteil sind die spätere Memory-/Inkognito-Policy (Layer 2), eine vollständige Berechtigungs- und Risikoklassenarchitektur sowie neue Browser-, Spotify- oder Office-Features.

## Ergebnis des ersten vollständigen Audits

| Nr. | Priorität | Befund | Auswirkung |
|---:|:---:|---|---|
| 1 | P0 | Turn-bezogene Bus-Ereignisse besitzen keine Turn-ID. | Alte Chunks, Fehler oder Toolantworten können nicht sicher verworfen werden. |
| 2 | P0 | `turnInFlight` serialisiert nicht den ganzen Turn; ein neuer Turn überschreibt den Besitzer. | History, Routing und Ausgabe können sich bei schnellen Eingaben vermischen. |
| 3 | P0 | Es gibt keinen zentralen Queue-/Cancel-/Interrupt-Vertrag. | Chat, PTT und Actions behandeln Konkurrenz unterschiedlich. |
| 4 | P0 | Router-, Worker- und Action-Arbeit erhalten kein gemeinsames Turn-AbortSignal. | F9 stoppt Audio, aber nicht zuverlässig die eigentliche Verarbeitung. |
| 5 | P0 | Action-Requests besitzen nur eine Request-ID, aber keine Turn-Zuordnung. | Verspätete Ergebnisse können beim falschen Gespräch landen. |
| 6 | P0 | ActionService verhindert doppelte Request-IDs nicht und kann nur beim Shutdown alles abbrechen. | Ein dupliziertes Ereignis kann denselben Seiteneffekt mehrfach ausführen. |
| 7 | P0 | Custom-Command-Expansion ersetzt den Rohbefehl vor History und Persistenz. | Herkunft, Argumente und tatsächlich ausgeführter Text sind nicht unterscheidbar. |
| 8 | P0 | Dashboard verwendet genau eine globale Assistant-Bubble. | Zwei schnelle Turns können dieselbe Bubble beschreiben oder schließen. |
| 9 | P0 | Voice-Transkript, Füller, TTS-Audio und Playback-Done sind unkorreliert. | Audio eines alten Turns kann nach einer Unterbrechung wieder auftauchen. |
| 10 | P0 | TTS-Queue und Piper besitzen keinen gemeinsamen Generation-/Abort-Vertrag. | Bereits laufende Synthese kann nach `stop()` noch erfolgreich zurückkehren. |
| 11 | P0 | STT-Transkription besitzt weder Turn-Abbruch noch harte Request-Grenze. | Ein hängender Whisper-Aufruf kann den Voice-State dauerhaft blockieren. |
| 12 | P0 | PTT-Audio besitzt keine Capture-ID und keine harte Gesamtgröße/-dauer. | Verlorenes Key-up kann RAM wachsen lassen; späte Chunks sind nicht zuordenbar. |
| 13 | P0 | `llm:done/error` ist zugleich Output- und Turnabschluss. | Mehrteilige Action-Antworten haben keinen eindeutigen terminalen Turnstatus. |
| 14 | P0 | MessageBus isoliert fehlerhafte Listener nicht. | Ein UI-/Servicefehler kann weitere Empfänger desselben Events blockieren. |
| 15 | P0 | IPC-Vertrag, Preload und reale Handler sind gedriftet. | Buildzeit-Typen behaupten andere Kanäle oder Payloads als die Laufzeit. |
| 16 | P1 | Renderer-Forwarding verwirft Source und Zeitstempel; Voice-Abos werden nicht sauber freigegeben. | Diagnose und Reload-Verhalten sind unnötig fragil. |
| 17 | P1 | Performance-Messung besitzt nur einen globalen Turn-Slot. | Überlappende Turns erzeugen falsche Latenzdaten. |
| 18 | P1 | Tests prüfen isolierte Pfade, aber keine Konkurrenz-, Stale-Output-, IPC-Paritäts- oder End-to-End-Abbrüche. | Die wichtigsten Layer-1-Garantien können unbemerkt regressieren. |

## Verbindlicher Turn-Vertrag

### Turn-Envelope

Jede akzeptierte Eingabe erhält vor Router oder STT-Verarbeitung eine UUID. Der Envelope hält getrennt:

- `turnId`, Quelle (`chat`/`voice`) und Interaktionsmodus,
- ursprünglichen und normalisierten Text,
- bei Voice das zugehörige Capture-/Transkript,
- Slash-Command-Art, Commandname, Argumente und Expansion,
- den tatsächlich an Router beziehungsweise Worker übergebenen Text,
- Erstellungszeit und terminalen Status.

### Konkurrenzregeln

- **Queue:** Normale neue Chat- und Voice-Eingaben werden in Annahmereihenfolge seriell ausgeführt. Die Queue ist begrenzt; Überlast wird sichtbar abgelehnt.
- **Cancel:** Ein konkreter Turn kann vor oder während seiner Ausführung abgebrochen werden. Danach darf er keine Chunks, History-, DB-, Action- oder TTS-Ausgabe mehr erzeugen.
- **Interrupt:** F9 während `processing` oder `speaking` bricht den aktiven Turn samt kooperativ abbrechbaren Unterarbeiten ab und öffnet anschließend die neue Aufnahme.
- **Replace:** Ist eine explizite Kombination aus Cancel und neuer Annahme. Layer 1 verwendet sie nicht stillschweigend für normale Chatnachrichten.
- **Terminal:** Jeder Turn endet genau einmal als `done`, `error` oder `canceled`. Einzelne Assistant-Ausgaben innerhalb eines Turns erhalten zusätzlich eine eigene `outputId`.

Bereits abgeschlossene, externe Seiteneffekte können technisch nicht rückgängig gemacht werden. Ein Abbruch verhindert deshalb nur noch nicht gestartete beziehungsweise kooperativ abbrechbare Arbeit und verspätete Erfolgsausgaben.

## Umsetzung

### Paket 1 – Autoritative Verträge und Bus-Schutz

1. Zentrale Turn-/Output-/Command-Typen und sichere UUID-Erzeugung einführen.
2. Alle turn-bezogenen Bus-Events um `turnId`, Output-Events zusätzlich um `outputId` ergänzen.
3. Separate `turn:terminal`- und `turn:cancel`-Ereignisse einführen.
4. MessageBus-Listener einzeln abfangen, protokollieren und nachfolgende Listener weiter ausführen.
5. IPC-Contract an reale Commands, Send-Events und Renderer-Events angleichen; Preload-Typen daraus ableiten.
6. Runtime-Guards für Chat-, Audio-, Playback- und Turn-Payloads ergänzen.

### Paket 2 – Zentrale Turn-Steuerung und Router

1. Einen `TurnCoordinator` mit begrenzter FIFO-Queue, genau einem aktiven Turn und per-Turn-AbortController bauen.
2. Chat-IPC und Voice erzeugen Turn-IDs vor der Weitergabe.
3. Router verarbeitet nur vorbereitete Turn-Envelopes und reicht das Signal an `ModelRuntime.route` und `streamWorker` weiter.
4. Slash-Herkunft getrennt halten; unbekannte/bewusst nicht verfügbare Commands deterministisch beenden.
5. History und Persistenz erst am gültigen Turnabschluss übernehmen; abgebrochene Teilantworten nicht als vollständige Antwort speichern.
6. Geordnete terminale Events erzeugen und operative Fehler nicht in Queue-Logs verschlucken.

### Paket 3 – Actions und Tool-Ergebnisse

1. `action:request/result` um Turn-ID ergänzen, Request-ID-Deduplizierung im ActionService erzwingen.
2. AbortController nach Turn und Request verwalten; `turn:cancel` beendet passende kooperative Aktionen.
3. Router akzeptiert Ergebnisse nur für exakt passenden Turn und Request.
4. Timer-/Systembenachrichtigungen als eigenständige Systemausgabe mit eigener Output-ID behandeln.
5. Search-Ergebnisse mindestens an Request/Turn binden, damit `show_browser` keinen fremden Ergebnissatz öffnet.

### Paket 4 – Voice, STT, TTS und Barge-in

1. Pro Aufnahme eine Capture-ID und Turn-ID von PTT-Down bis Transkript führen.
2. Aufnahmezeit und Sampleanzahl hart begrenzen; verlorenes Key-up kontrolliert beenden.
3. STT-Interface und Faster-Whisper-Request um AbortSignal und Timeout ergänzen.
4. TTS-Interface, Queue und Piper um AbortSignal beziehungsweise Generation erweitern.
5. `voice:play-audio`/`playback-done` mit Playback- und Turn-ID korrelieren; alte Bestätigungen verwerfen.
6. F9 unterbricht sowohl `processing` als auch `speaking` und propagiert denselben Turn-Abbruch.

### Paket 5 – Renderer, Diagnose und Cleanup

1. Assistant-Bubbles nach `turnId` und `outputId` statt über einen globalen Pointer verwalten.
2. Späte Events terminaler/abgebrochener Turns ignorieren.
3. Performance-Daten pro Turn sammeln und am terminalen Event abschließen.
4. Alle Forwarder-Abonnements mit dem Fenster-/Handler-Lifecycle bereinigen.

### Paket 6 – Automatisierte Abnahme

Mindestens folgende Regressionstests werden ergänzt:

- zwei schnelle Turns bleiben in Reihenfolge und vermischen weder History noch Chunks,
- Abbruch während Router, Worker, Action, STT und TTS verhindert verspätete Ausgabe,
- ein Turn erhält genau einen terminalen Status,
- alte Output-/Playback-IDs werden verworfen,
- doppelter Action-Request führt nur einmal zum Seiteneffekt,
- unbekannter und eigener Slash-Command bewahren Herkunft und Sicherheitsweg,
- verlorenes PTT-Key-up überschreitet weder Dauer noch Puffergrenze,
- ein werfender Bus-Listener blockiert keinen weiteren Listener,
- IPC-Vertrag, Preload-Kanäle und registrierte Handler bleiben deckungsgleich,
- Renderer hält parallele Output-Bubbles getrennt.

## Praktische Windows-Abnahme nach den Code-Audits

1. Normaler Text- und F9-Turn mit derselben Turn-ID von Eingang bis Ausgabe.
2. Zwei schnelle Eingaben; keine vermischte oder doppelte Antwort.
3. Unterbrechung während Worker-Wartezeit und während TTS; kein spätes Audio/kein später Chattext.
4. Built-in-, eigener und unbekannter Slash-Command; genau ein kontrollierter Pfad je Eingabe.

## Qualitäts-Gates

- Betroffene Unit-/Integrationstests, Main- und Renderer-Typecheck.
- Vollständige Testsuite und produktiver Build.
- `git diff --check` und Kontrolle, dass die neun fremden lokalen Änderungen nicht staged werden.
- Zweites vollständiges Layer-1-Audit nach der Umsetzung, nicht nur Planvergleich.
- Vor weiteren Korrekturen erhält Martin die vollständige zweite Befundliste mit Priorität und Größe; danach Entscheidung über ein drittes Audit.

## Ergebnis des zweiten vollständigen Audits

Der erste Umsetzungsdurchgang erfüllt seine automatisierten Gates, besitzt an den Übergängen zwischen Voice, Playback, Search und Systemausgaben aber noch folgende relevante Lücken:

| Nr. | Priorität | Größe | Befund |
|---:|:---:|:---:|---|
| 19 | P0 | M | Router, Voice und Runtime können Turns unabhängig voneinander terminal beenden; eine zentrale Exactly-once-Instanz fehlt. |
| 20 | P0 | M | Voice akzeptiert verspätete LLM-Ausgaben ohne autoritative Prüfung des aktuellen Turn-Besitzers. |
| 21 | P0 | M | Getippte Sprachantworten (`chatspeak`) durchlaufen keinen vollständigen Processing-/Speaking-Zustand und sind dadurch nicht zuverlässig unterbrechbar. |
| 22 | P0 | M | Der Renderer besitzt während des asynchronen Audiostarts keine Playback-Generation; abgebrochenes Audio kann verspätet starten. |
| 23 | P0 | M | Der Voice-Übergangsschutz ist nicht generationsfest; alte STT-Abläufe können den Zustand eines neuen Turns verändern. |
| 24 | P0 | M | Piper verwaltet den laufenden Prozess global; alte Close-/Timeout-Callbacks können eine neuere Synthese beeinflussen. |
| 25 | P1 | M | Eine Search-Session wird vor erfolgreicher Zusammenfassung veröffentlicht und bei Abbruch nicht zuverlässig verworfen. |
| 26 | P1 | M | `showResult()` erhält Korrelation, verwendet aber weiterhin pauschal die zuletzt gespeicherte Suche. |
| 27 | P1 | M | Timer-/Systemmeldungen umgehen den TurnCoordinator und erzeugen ungebundene Assistant-Einträge in der Gesprächshistorie. |
| 28 | P1 | M | Bei Chunk-Sequenzlücken gibt es weder im Renderer noch in Voice eine definierte Wiederherstellung über `fullText`. |
| 29 | P1 | M | Voice-Konfigurationswechsel brechen laufendes STT, Router-Arbeit und TTS nicht als gemeinsame Operation ab. |
| 30 | P1 | S | TTS-Fehler verlieren Turn- und Output-Korrelation. |
| 31 | P1 | S | TTS-Timings können nach dem Turnabschluss eintreffen und einen nie abgeschlossenen Performance-Eintrag erzeugen. |
| 32 | P1 | M | Voice-/Renderer-Tests verwenden teilweise Legacy-Payloads und sichern an einer Stelle verspätete alte Ausgabe als gewünschtes Verhalten ab. |
| 33 | P2 | S–M | `forwardToRenderers()` verwirft weiterhin Bus-Quelle und Zeitstempel. |

## Umsetzung der zweiten Befundrunde

### Paket 7 – Autoritativer Turn-Lebenszyklus

1. Eine zentrale Turn-Abschlussinstanz für Exactly-once-Terminals einführen.
2. Besitzwechsel zwischen Capture, STT, Router, Output und Playback explizit führen.
3. Voice-Vorrouter-Fälle wie leere Aufnahme, Abbruchphrase, fehlendes STT und Barge-in terminal abschließen.
4. Async-Voice-Übergänge über eine Generation statt über einen einzelnen Boolean absichern.

### Paket 8 – Voice-, TTS- und Playback-Generationen

1. Voice nimmt Chunks, Done, Fehler und Füller nur für den aktuell erlaubten Turn/Output an.
2. `chatspeak` erhält einen vollständigen und unterbrechbaren Zustandsablauf.
3. AudioBridge verwirft verspätete Starts und End-Callbacks älterer Playback-Generationen.
4. Piper bindet alle Callback-, Abort- und Timeout-Pfade an den jeweils gestarteten Prozess.
5. TTS-Fehler behalten Turn- und Output-ID bis zur Oberfläche.

### Paket 9 – Search- und Systemausgaben

1. Search-Ergebnisse erst nach erfolgreicher Zusammenfassung veröffentlichen.
2. Abgebrochene oder fehlgeschlagene Sessions vollständig entfernen.
3. `showResult` mit einer expliziten Quell-Session statt mit einer dekorativen Request-Korrelation verbinden.
4. Systemmeldungen als echte, koordinierte System-Turns behandeln und nicht als ungebundene Assistant-History speichern.

### Paket 10 – Wiederherstellung, Diagnose und Regressionstests

1. Renderer und Voice können einen Sequenzfehler über das autoritative `fullText` definiert abschließen.
2. Voice-Konfigurationswechsel beenden oder übernehmen laufende Arbeit kontrolliert.
3. Performance-Messungen besitzen eine begrenzte Nachlaufphase und können keine verwaisten Einträge erzeugen.
4. Renderer-Forwarding bewahrt Diagnosemetadaten ohne den fachlichen Payload-Vertrag zu verwässern.
5. Alle Legacy-Testpayloads entfernen und die praktischen Konkurrenzfälle mit echten UUIDs abdecken.
6. Nach Umsetzung und Vollsuite folgt verbindlich ein drittes, erneut uneingeschränktes Layer-1-Audit.

## Fertigkriterium

Layer 1 ist erst abgeschlossen, wenn automatisiert und praktisch belegt ist: Jede operative Eingabe besitzt einen eindeutigen Besitzer, Konkurrenz ist seriell definiert, Unterbrechung wirkt durch die gesamte noch abbrechbare Pipeline, verspätete Ereignisse werden verworfen und jeder Turn endet genau einmal nachvollziehbar. Nach der zweiten Befundrunde ist ein drittes vollständiges Audit verpflichtend.
