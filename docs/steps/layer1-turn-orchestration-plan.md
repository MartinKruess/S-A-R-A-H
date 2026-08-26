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

## Ergebnis des dritten vollständigen Audits

Das dritte Audit wurde erneut vom realen IPC-Eingang bis zu Action, Router, Voice und Playback durchgeführt. Es fand acht weitere relevante Übergangslücken; alle acht wurden im selben Durchgang behoben und mit Regressionstests abgesichert.

| Nr. | Priorität | Befund | Korrektur |
|---:|:---:|---|---|
| 34 | P0 | Der reale Chat-IPC setzte `chatspeak` vor `chat:message`; Voice übersprang dadurch während der Wartezeit den Processing-Zustand. | Der Bus-Eingang übernimmt den Moduswechsel atomar zusammen mit dem Turn-Besitz. |
| 35 | P0 | Ein bereits veröffentlichter Chat-Turn konnte mit derselben Turn-ID erneut verteilt werden; unbekannte Turns konnten terminalisiert werden. | Der zentrale Ledger trennt Annahme und einmalige Request-Veröffentlichung und verweigert unbekannte Terminals. |
| 36 | P0 | Ein extern terminalisierter Turn stoppte Router- und Action-Arbeit nicht zwingend. | Router und ActionService abonnieren den autoritativen Terminalstatus und brechen passende Arbeit ab. |
| 37 | P1 | Nach einer fehlgeschlagenen neuen Suche konnte `show_browser` noch auf den letzten erfolgreichen Ergebnissatz zeigen. | Jede neue Suche löscht zuerst den sichtbaren Session-Zeiger und setzt ihn nur nach Erfolg neu. |
| 38 | P1 | Eine Action konnte nach zwischenzeitlichem Turn-Abschluss noch ein verspätetes Resultat veröffentlichen. | Ergebnis- und Fehlerpfad prüfen den zentralen Terminalstatus unmittelbar vor der Ausgabe. |
| 39 | P1 | `PiperProvider.stop()` beendete Prozesse, ließ zugehörige Synthese-Promises aber vom Prozess-Callback abhängig. | Jeder Prozess besitzt einen eigenen Reject-Pfad; Stop und Abort schließen ihn sofort und genau einmal. |
| 40 | P1 | Mehrere schnell aufeinanderfolgende Sprachausgaben erzeugten nur für den zuletzt aktiven Turn `voice:done`. | TTS führt Turn-Besitz bis zum letzten Playback und meldet jeden gesprochenen Turn separat fertig. |
| 41 | P1 | Der Chat-IPC konnte eine bereits bekannte Turn-ID erneut annehmen und damit einen fremden offenen Turn beeinflussen. | Bekannte IDs werden an der IPC-Grenze vor Annahme oder Ablehnung konsequent verweigert. |

Der anschließende Abschluss-Scan fand keine weitere grundlegende P0-/P1-Lücke. Ein vierter vollständiger Code-Audit-Durchgang ist deshalb vor der praktischen Windows-Matrix nicht erforderlich. Die praktische Abnahme bleibt das letzte Layer-1-Gate und kann neue Laufzeitbefunde erzeugen.

## Ergebnis des vierten vollständigen Audits

Der vierte Durchgang prüfte erneut nur konkret erreichbare Laufzeitfehler. Reine Stilfragen, zusätzliche Defense-in-Depth ohne aktuellen Auslöser und nicht belegbare hypothetische Abläufe wurden verworfen. Es verbleiben neun Layer-1-P1-Befunde sowie eine relevante P1-Grenzlücke zwischen Dashboard-Boot und AudioBridge:

| Nr. | Priorität | Befund |
|---:|:---:|---|
| 42 | P1 | Ein `canceled`-Terminal eines parallelen Voice-Turns kann globale Voice-Zustände und Textpuffer eines anderen aktuellen Turns zurücksetzen. |
| 43 | P1 | Während Turn A noch hörbar ist, kann Turn B bereits Output erzeugen; F9 stoppt dann A, terminalisiert wegen des globalen Output-Besitzers aber fälschlich B. |
| 44 | P1 | Ein verlorenes Renderer-Playback-ACK besitzt keinen Timeout; TTS-Queue, `voice:done` und Speaking-State können dauerhaft hängen. |
| 45 | P1 | Scheitert STT nach dem automatischen Aufnahmegrenzwert, erzeugt der spezielle Limit-Pfad keinen terminalen Turnabschluss und kann in `processing` verbleiben. |
| 46 | P1 | Ein asynchron gestarteter Capture-Aufbau kann nach Gerätewechsel oder `destroy()` weiterlaufen und verwaiste beziehungsweise falsche Mikrofonressourcen installieren. |
| 47 | P1 | Beim Anschluss an einen bereits laufenden Listening-State erhält der Renderer keine echte Capture-ID und sendet Audio unter einer erfundenen, von Main verworfenen ID. |
| 48 | P1 | Fehler beim Renderer-Mikrofon-/Worklet-Aufbau bleiben in der Konsole; Main beendet die leere Aufnahme ohne verständliche Nutzermeldung. |
| 49 | P1 | Der Pre-Roll-Puffer übernimmt auch bereits live gesendete Chunks und kann das Ende einer schnellen vorherigen Aufnahme erneut an den nächsten Turn senden. |
| 50 | P1 | Piper behandelt eine Prozessbeendigung mit `code === null` auch ohne eigenen Abort als erfolgreichen Syntheselauf und kann partielles Audio weiterreichen. |
| 51 | P1 | Ein abgelehntes `getConfig()` kann durch den asynchronen Promise-Executor das Dashboard-Boot-Promise und damit den AudioBridge-Start dauerhaft offen lassen. |

### Umsetzung der vierten Befundrunde

1. Voice-State, Streaming-Puffer, Processing-Besitz und tatsächlichen Playback-Besitz turnbezogen trennen; fremde Terminals dürfen keinen aktuellen Turn verändern.
2. F9 gegen den hörbaren und den verarbeiteten Besitzer eindeutig definieren und den realen Überlappungsfall A hörbar/B in Verarbeitung absichern.
3. STT-Limit, allgemeine STT-Fehler und Timeouts über denselben genau einmal terminalen Abschluss führen.
4. Playback-ACK begrenzen und bei Renderer-Ausfall kontrolliert weiterlaufen beziehungsweise abschließen; verspätete ACKs idempotent verwerfen.
5. Capture-Aufbau mit Generation und Lifecycle korrelieren, die echte Capture-ID über den Zustandsabruf liefern und Capture-Fehler sichtbar an Main zurückmelden.
6. Pre-Roll nur aus noch nicht bereits dem aktuellen Turn zugestellten Samples bilden.
7. Piper-Signalbeendigung als Fehler behandeln und den Dashboard-Boot ohne asynchronen Promise-Executor definiert fehlschlagen lassen.
8. Für jeden Befund einen Regressionstest ergänzen; danach vollständige Suite, Build und ein fünftes uneingeschränktes Audit ausführen.

## Ergebnis und Umsetzung des fünften vollständigen Audits

Das fünfte Audit fand 15 produktiv erreichbare P1-Lücken. Alle 15 wurden umgesetzt und durch zusätzliche Regressionstests abgesichert:

| Nr. | Priorität | Befund | Korrektur |
|---:|:---:|---|---|
| 52 | P1 | Ein Fehler beim ersten `getConfig()` ließ Dashboard-Boot und AudioBridge stillstehen. | Boot degradiert kontrolliert und startet die Oberfläche sowie AudioBridge weiter. |
| 53 | P1 | Verspätet synthetisiertes Splash-TTS konnte nach dem Renderer-Fallback im Normalbetrieb starten. | Splash-Synthese erhielt einen ablaufenden Boot-Besitz und wird bei Bootabschluss abgebrochen beziehungsweise verworfen. |
| 54 | P1 | Ein verlorenes laufendes Mikrofon hinterließ einen scheinbar aktiven, aber stummen Capture-Pfad. | Track-Ende und Gerätewechsel lösen korrelierte Fehlermeldung und Capture-Recovery aus. |
| 55 | P1 | `setSinkId`-Fehler behaupteten einen Fallback, ohne den Graph tatsächlich auf den Standardausgang umzulegen. | Der defekte Sink-Pfad wird getrennt und der Live-Graph auf den OS-Standardausgang verbunden. |
| 56 | P1 | Ein früher Piper-Absturz konnte über unbehandeltes `stdin`-`EPIPE` den Main-Prozess gefährden. | Streamfehler und synchrone Schreibfehler lehnen nur die betroffene Synthese kontrolliert ab. |
| 57 | P1 | Turn-spezifischer TTS-Abbruch stoppte das physisch laufende Renderer-Audio nicht. | Main und Renderer besitzen ein korreliertes Stop-Playback-Ereignis; fremde Queue-Inhalte bleiben erhalten. |
| 58 | P1 | Eine Action-Zwischenantwort beendete den Processing-Besitz, obwohl die Action weiterlief. | Processing bleibt bis zum terminalen Turnabschluss erhalten. |
| 59 | P1 | Routerfehler erschienen doppelt im Chat, wurden im Sprachpfad aber nicht gesprochen. | Fehler werden pro Turn dedupliziert, einmal angezeigt und im Voice-Kontext einmal gesprochen. |
| 60 | P1 | Ein LLM-Fehler nach begonnenem Stream konnte Voice dauerhaft auf `speaking` halten. | Output-Lifecycle wird bei Fehler vollständig und queue-sicher abgeschlossen. |
| 61 | P1 | Ein Moduswechsel während laufender Ausgabe konnte deren Abschluss verwerfen. | Die Sprechentscheidung bleibt pro begonnenem Output stabil und der Abschluss wird weiterhin verarbeitet. |
| 62 | P1 | Turn B konnte während Playback A nach seinem Abschluss dauerhaft auf `processing` bleiben. | Processing-, Output- und Playback-Besitz werden unabhängig pro Turn beziehungsweise Output geführt. |
| 63 | P1 | Mehrere schnelle Chat-Turns überschrieben einen einzelnen Processing-Besitzer. | Offene Processing- und Voice-relevante Turns werden in Sets/Maps gehalten; F9 beendet alle passenden offenen Turns. |
| 64 | P1 | Renderer-Playbackfehler wurden als erfolgreicher ACK behandelt. | Fehler werden mit Turn- und Playback-ID an Main gemeldet und die Queue läuft kontrolliert weiter. |
| 65 | P1 | Ein Whisper-Absturz nach erfolgreichem Start ließ STT bis zum Neustart scheinbar bereit, aber funktionslos. | Provider-Crash stuft Capability ab und plant einen kontrollierten Wiederanlauf. |
| 66 | P1 | Der STT-Timeout beendete nur den HTTP-Client, nicht die blockierende native Whisper-Arbeit. | Timeout recycelt den Python-Prozess, bevor weitere STT-Anfragen zugelassen werden. |

Der integrierte Stand bestand danach 79 Testdateien mit 813 Tests, Main- und Renderer-Typecheck, den vollständigen Build und `git diff --check`. Die native SQLite-Bindung wurde anschließend wieder auf Electron 41.1.1 gestellt.

## Ergebnis des sechsten vollständigen Audits

Audit 6 wurde erneut uneingeschränkt und mit vertauschten Prüfbereichen durchgeführt. Überschneidungen zwischen den Prüfern wurden nur einmal gezählt. Es verbleiben 16 produktiv erreichbare P1-Lücken und keine P0-Lücke:

| Nr. | Priorität | Befund |
|---:|:---:|---|
| 67 | P1 | Die Sprech-/Still-Entscheidung wird erst beim ersten Output statt bei Annahme des Turns eingefroren; ein im Chat gestarteter Turn kann nach einem UI-Moduswechsel unerwartet gesprochen werden. |
| 68 | P1 | Getippte Eingaben im Voice-Modus werden IPC-seitig trotzdem als `mode: chat` geroutet; Router-Prompt und Filler entsprechen nicht der tatsächlich gesprochenen Interaktion. |
| 69 | P1 | Die gesprochene STT-unavailable-Meldung besitzt keinen Voice-/Output-Besitz; F9 kann sie nicht unterbrechen und reiht weitere identische Ansagen ein. |
| 70 | P1 | Ein F9-Turn bei nicht verfügbarem Router erhält vor `llm:error` keinen Voice-Besitz und bleibt trotz verfügbarer TTS stumm. |
| 71 | P1 | Startet Splash-Audio kurz vor Ablauf des Acht-Sekunden-Fallbacks, beendet der Watchdog trotzdem den Boot; die nicht stoppbare Quelle läuft in den Normalbetrieb weiter. |
| 72 | P1 | Ein erwarteter F9-Abbruch während STT wird als Whisper-Crash recycelt; die sofort gestartete Folgeaufnahme kann anschließend bis zum 60-Sekunden-Timeout im Modellstart hängen. |
| 73 | P1 | Mehrere Boot-, Ollama- und Whisper-HTTP-Probes besitzen keine harte Einzel-/Gesamtdeadline und können den Boot ohne kontrollierte Degradation blockieren. |
| 74 | P1 | Der verspätete Exit eines alten Whisper-Childs kann einen bereits gesunden Ersatz fälschlich wieder auf unavailable setzen. |
| 75 | P1 | Persistente Whisper-HTTP-500-/CUDA-/Inferenzfehler lösen keine Recovery aus; Capability und F9 bleiben fälschlich bereit. |
| 76 | P1 | VoiceMode- und STT-Capability-Änderungen erreichen AudioBridge nicht zuverlässig; das Mikro bleibt bei `off`/unavailable offen oder ist beim Wechsel auf PTT zunächst kalt. |
| 77 | P1 | Persistente Piper-Laufzeitfehler stufen die TTS-Capability nicht ab; jeder weitere Sprachoutput läuft erneut in denselben Fehler. |
| 78 | P1 | Capture-Initialisierung besitzt weder Readiness-Gate noch Setup-Timeout; der erste Turn kann leer/angeschnitten enden und ein hängender Gerätezugriff alle weiteren F9-Turns blockieren. |
| 79 | P1 | Der PTT-Pre-Roll sendet etwa 384 ms Audio von vor dem Tastendruck unter der neuen Capture-ID und kann fremde beziehungsweise Sarahs eigene Audioanteile in den Befehl übernehmen. |
| 80 | P1 | Mikrofon-Fallback verwechselt die konfigurierte fehlende ID mit dem tatsächlich laufenden Track; Devicechanges können unnötig abbrechen und Replug heilt nicht auf das gewünschte Gerät zurück. |
| 81 | P1 | Nach Sink-Fallback bleibt die ungültige Geräte-ID aktiv; jedes weitere TTS-Segment kann erneut bis zu zwei Sekunden warten und den defekten Pfad neu aufbauen. |
| 82 | P1 | Ein hängender Renderer-Playback-Start wird vom Main-ACK-Timeout fachlich beendet, seine Promise blockiert aber weiterhin die serielle Renderer-Playback-Kette. |

Layer 1 bleibt damit offen. Vor der praktischen Windows-Matrix müssen die Befunde 67 bis 82 behoben und erneut uneingeschränkt auditiert werden.

## Umsetzung der sechsten Befundrunde

Die Befunde 67 bis 82 wurden umgesetzt und mit zusätzlichen Regressionstests abgesichert. Dabei wurden insbesondere die Sprechentscheidung bereits bei Turn-Annahme eingefroren, getippte Eingaben im Voice-Modus korrekt gekennzeichnet, nicht verfügbare Voice-Dienste als eigene unterbrechbare Ausgaben geführt, Splash- und Provider-Deadlines ergänzt sowie Capture-, Geräte- und Playback-Besitz bis in den Renderer korreliert.

Der integrierte Stand bestand danach 79 Testdateien mit 845 Tests, Main- und Renderer-Typecheck, den vollständigen Build und `git diff --check`. Die native SQLite-Bindung wurde anschließend wieder auf Electron 41.1.1 gestellt.

## Ergebnis des siebten vollständigen Audits

Audit 7 wurde mit maximaler Prüftiefe, vertauschten und überlappenden Prüfbereichen sowie ohne Beschränkung auf die zuletzt geänderten Dateien durchgeführt. Gleiche Ursachen wurden nur einmal gezählt; eigenständige Fehlerursachen mit ähnlicher Wirkung bleiben getrennt. Es verbleiben 17 produktiv erreichbare P1-Lücken und keine P0-Lücke:

| Nr. | Priorität | Befund |
|---:|:---:|---|
| 83 | P1 | `memoryAllowed`, Memory-Ausschlüsse und `/anonymous` werden nicht an der Persistenzgrenze durchgesetzt; ausdrücklich flüchtige oder ausgeschlossene Inhalte können trotzdem in SQLite und späteren Startkontext gelangen. |
| 84 | P1 | `confirmationLevel` ist lediglich Prompttext; selbst bei maximaler Bestätigung veröffentlicht der Router verändernde Actions ohne technisch erzwungene, turn- und aktionsgebundene Zustimmung. |
| 85 | P1 | Hängende Model-Transitions wie Unload, Warmup und VRAM-Abfrage besitzen keine harte Deadline und blockieren über `operationTail` sämtliche späteren Turns; F9 kann einen dahinter wartenden Turn nicht aus der Queue lösen. |
| 86 | P1 | Der Ollama-Provider akzeptiert Stream-EOF ohne terminalen `done`-Frame als Erfolg, verwirft einen Restbuffer ohne Zeilenumbruch und kann dadurch Teilantworten als vollständig terminalisieren und persistieren. |
| 87 | P1 | Der Sandbox-Browser begrenzt nur `loadURL`; hängende Storage-/Cache-Vorbereitung oder HTML-Extraktion überlebt den Action-Abbruch und kann den Search-Lock für die gesamte Sitzung halten. |
| 88 | P1 | Ein beim Shutdown laufender oder wartender Router-Turn wird nicht zu Beginn des Stoppings abgebrochen und kann nach Entfernung der Renderer-Forwarder unsichtbar erfolgreich abschließen und persistiert werden. |
| 89 | P1 | Das Splash-Fenster kann `splash-done` senden, bevor Main den Handler registriert; das einmalige Ereignis geht insbesondere bei einem länger offenen Konfigurationsdialog verloren und der Splash hängt bis zum Neustart. |
| 90 | P1 | „Mit Defaults fortfahren“ verwendet Defaults nur im Arbeitsspeicher, repariert aber die ungültige gespeicherte Konfiguration nicht; spätere unabhängige Settings- oder Wizard-Saves können deshalb weiter scheitern. |
| 91 | P1 | Nach erfolgreicher Splash-Synthese besitzt die eigentliche Audio-Wiedergabe weder Resume-Pfad noch Watchdog; ein suspendierter AudioContext oder verlorener Ausgang kann den Boot unbegrenzt in `boot-piper-wait` halten. |
| 92 | P1 | Ollama-/Docker-Laufzeitfehler aktualisieren die Runtime-Capability nicht zuverlässig und besitzen keinen kontrollierten Recheck; Oberfläche und Router können trotz defekter oder später wieder gesunder Runtime dauerhaft einen falschen Zustand melden. |
| 93 | P1 | Ein erwarteter F9-Abbruch beendet nur den Node-Fetch, nicht die einthreadige native Whisper-Transkription; ein Folgeturn kann hinter der verworfenen Arbeit bis zum nächsten Timeout warten. |
| 94 | P1 | Ein transienter Fehler beim allerersten Whisper-Start wird endgültig behandelt: Restart ist nur nach früherer Readiness erlaubt und Voice zerstört den Provider, sodass STT ohne App-Neustart nicht mehr gesund werden kann. |
| 95 | P1 | Nach einem transienten initialen Capture-/Worklet-/`getUserMedia`-Fehler meldet AudioBridge nur `captureReady=false`, plant aber keinen Selbst-Retry; F9 bleibt bis zu einem zufälligen Config-/Capability-Ereignis oder Neustart deaktiviert. |
| 96 | P1 | AudioBridge liest Config und Runtime vor Registrierung der Listener; ein VoiceMode- oder STT-Wechsel in diesem Fenster geht verloren und kann F9 dauerhaft deaktivieren oder den Mikrofon-Graph entgegen der aktuellen Einstellung offen halten. |
| 97 | P1 | Fällt STT während gehaltenem F9 aus, werden aktiver Capture und Turn nicht gemeinsam terminalisiert; Hotkey-Neuregistrierung verliert das Key-up und kann Aufnahmebesitz sowie F9 bis zum Neustart beschädigen. |
| 98 | P1 | Beim Unterbrechen laufender TTS sammelt VoiceService global auch Outputs unabhängiger reiner Text-Chat-Turns ein; F9 kann dadurch eine parallel sichtbare Textantwort abbrechen und aus dem Renderer entfernen. |
| 99 | P1 | Der MUTE-Toggle rollt bei Save-Fehlern nicht sichtbar zurück und Audio-Patches verwenden ein veraltetes vollständiges Read-modify-write-Objekt; die UI kann MUTE anzeigen, während tatsächlich weiter aufgenommen wird. |

### Wesentliche Unterpfade und Abgrenzungen

- Die Runtime-Befunde 85 und 92 sind getrennt: 85 betrifft eine blockierte Serialisierungsqueue, 92 die falsche Verfügbarkeits- und Recovery-Steuerung nach Providerfehlern.
- Die Capture-Befunde 95 und 96 sind getrennt: 95 benötigt einen begrenzten Recovery-/Backoff-Pfad, 96 eine race-freie Snapshot-/Subscription-Reihenfolge mit anschließendem Reconcile.
- Der Whisper-Abbruch 93 ist kein Rückfall von Befund 72: 72 verhinderte unnötiges Recycling bei normalem Abort; Audit 7 belegt nun, dass die native einthreadige Arbeit trotzdem kontrolliert isoliert oder beendet werden muss.
- Nicht als P1 gezählt wurden reine Fehlermeldungsformulierungen, UI-Nachlauf ohne falsche Funktion, theoretische Datenabflüsse ohne erreichbaren IPC-Pfad und Codeästhetik.

Layer 1 bleibt offen. Vor der praktischen Windows-Matrix müssen die Befunde 83 bis 99 geplant, umgesetzt, vollständig geprüft und anschließend erneut uneingeschränkt auditiert werden.

## Umsetzung der siebten Befundrunde

Die Befunde 83 bis 99 wurden umgesetzt und mit Regressionstests abgesichert. Die Korrekturen erzwingen die Memory- und Bestätigungsregeln an technischen Grenzen, begrenzen und regenerieren Modell-, Browser-, Splash- und Voice-Laufzeiten, beenden Arbeit bereits beim Shutdown-Beginn und halten Capture-, Playback-, STT- sowie Audio-Konfigurationszustände auch bei Abbruch und Fehler konsistent.

Eine fokussierte Integrationsprüfung des Umsetzungsdiffs fand noch einen offenen Unterpfad von Befund 92: Nicht durch Timeout ausgelöste Runtime-Fehler während eines Modellwechsels degradierten die Capability noch nicht und planten keinen Recheck. Dieser Unterpfad wurde im selben Durchgang geschlossen und mit einem `ECONNREFUSED`-Regressionstest abgesichert.

Der integrierte Stand bestand danach 81 Testdateien mit 879 Tests, Main- und Renderer-Typecheck, den vollständigen Build und `git diff --check`. Die native SQLite-Bindung wurde anschließend wieder auf Electron 41.1.1 gestellt.

Gemäß der Abstimmung vom 26.08.2026 folgt jetzt kein weiteres vollständiges Layer-1-Audit. Vor einer neuen systematischen Fehlersuche oder der praktischen Windows-Matrix wird das weitere Vorgehen gemeinsam besprochen. Konkrete Lücken, die bei der direkten Arbeit an den bekannten Befunden auffallen, dürfen weiterhin im engen Zusammenhang behoben werden.

## Ergebnis des achten vollständigen Audits

Auf ausdrücklichen neuen Auftrag wurde Layer 1 erneut uneingeschränkt sowie über seine Runtime-, Memory-, Action-, Browser-, Voice-, Renderer- und IPC-Grenzen geprüft. Gezählt wurden nur produktiv erreichbare Fehlfunktionen, falsche Zustände, Daten-/Sicherheitsgrenzen und belastbare Folgefehler; reine Architektur-, Design- und Härtungswünsche blieben ungezählt. Nach Abgleich mit den Befunden 1 bis 99 verbleiben 20 neue beziehungsweise noch offene eigenständige Ursachen: 14 P1- und 6 P2-Befunde, keine P0-Lücke.

| Nr. | Priorität | Größe | Befund |
|---:|:---:|:---:|---|
| 100 | P1 | S | Eine Chatnachricht mit mehr als 4.000 Zeichen wird im Dashboard bereits als User-Bubble angezeigt, an der IPC-Grenze aber abgelehnt; `accepted: false` erzeugt weder Rücknahme noch Fehlermeldung, sodass die Nachricht dauerhaft wie erfolgreich gesendet aussieht. |
| 101 | P1 | S | Die numerischen Schemas für System- und Spotify-Lautstärke wandeln einen leeren beziehungsweise nur aus Leerzeichen bestehenden Action-Parameter in `0` um; ein unvollständiger Modell-Tag kann dadurch statt einer Ablehnung stummschalten. |
| 102 | P1 | M–L | `/anonymous`- und durch Memory-Ausschlüsse flüchtige Turns bleiben in der Live-History. Ein normaler Folgeturn kann ihren Inhalt wiederholen und diese abgeleitete Antwort anschließend dauerhaft speichern; die Transienz wird nicht entlang des Informationsflusses fortgeführt. |
| 103 | P1 | M | Die Quarantäne externer Suchdaten endet nach der Zusammenfassung: Die Summary wird als normale Assistant-History und in SQLite gespeichert und in späteren Turns ohne Datenprovenienz erneut eingespeist. Übernommene Web-Instruktionen können dadurch Folge-Turns und spätere Starts beeinflussen. |
| 104 | P1 | S–M | Die technisch gebundene Bestätigung nennt weder die Action noch ihren validierten Parameter. Der Nutzer bestätigt nur eine UUID; bei `/confirm` wird der Sideeffect-Request außerdem vor der konkreten Acknowledgement-Ausgabe gestartet. |
| 105 | P1 | M | Ein Turn wird nicht atomar persistiert. User- und Assistant-Zeilen werden einzeln autocommitted und Einzelfehler verschluckt; SQLite kann deshalb dauerhaft einen User ohne Antwort, eine Antwort ohne User oder nur einen Teil einer mehrteiligen Action-Antwort enthalten. |
| 106 | P2 | M | Startkontext- und Tokenlimits schneiden nach einzelnen Nachrichten statt nach vollständigen Turns. Dadurch kann eine ältere User-Nachricht entfallen, während ihre Assistant-Antwort als verwaister Kontext beim Modell verbleibt. |
| 107 | P1 | M | Suchresultate und Redirects werden nur auf `http:` beziehungsweise `https:` geprüft. Loopback-, Link-local- und private Netzadressen werden akzeptiert, sodass ein öffentliches Ergebnis das Browserfenster auf lokale Dienste oder Geräte lenken kann. |
| 108 | P2 | S | Der neue Built-in `/confirm` fehlt in der reservierten Command-Liste der Einstellungen. Ein eigener `/confirm` lässt sich sichtbar speichern, wird vom Resolver aber immer als Built-in abgefangen und ist daher unbenutzbar. |
| 109 | P1 | S–M | Der Memory-Ausschluss „Browser-Daten“ erkennt tatsächliche URLs nicht strukturell. Beispielsweise passiert `https://example.com/private` die neue Persistenzgrenze, weil lediglich nach Wörtern wie `url`, `browser` oder `webseite` gesucht wird. |
| 110 | P2 | M | Die Deadline aus Befund 87 beendet nur das Warten des Aufrufers. Nicht abbrechbare Electron-Operationen wie `clearStorageData()` und `clearCache()` können nach Abbruch weiterlaufen und die gemeinsame Session einer bereits gestarteten Folgesuche nachträglich verändern. |
| 111 | P1 | M | Die ModelRuntime-Recovery endet weiterhin in zwei realen Sackgassen: Ein initialer Docker-/Ollama-/Routerfehler zerstört den Router-Service ohne Selbstheilung, und ein beim ersten Recheck noch fehlender Worker plant keinen weiteren Versuch. Beide Zustände benötigen trotz später gesunder Runtime einen App-Neustart. |
| 112 | P1 | M | Der SandboxBrowser besitzt keine dauerhafte Fenster- und Navigationsgrenze. Nach dem ersten Load werden Redirect-Listener entfernt und `target=_blank` beziehungsweise `window.open()` wird nicht per `setWindowOpenHandler` gesperrt; untrusted Seiten können dadurch nicht verwaltete Popup-/Phishing-Fenster erzeugen, die `close()` nicht kennt. |
| 113 | P2 | S | Die Blockseitenerkennung wertet jedes Vorkommen des Wortes `captcha` als Challenge. Normale Suchergebnisse zur Suchanfrage „captcha“ werden deshalb bei beiden Suchprovidern als blockiert verworfen. |
| 114 | P1 | S–M | Befund 99 ist im separaten Audio-Settingsfenster offen: Der Dialog speichert bei einer Gerätewahl einen veralteten vollständigen Audio-Snapshot, während `audio-config-changed` nur das Hauptfenster erreicht. So können aktuelle Mute-/Lautstärkewerte zurückgesetzt und Rollbacks gegen einen falschen bestätigten Zustand ausgeführt werden. |
| 115 | P2 | M | `restartRequired` vergleicht eine neue LLM-Konfiguration mit dem zuletzt gespeicherten Snapshot statt mit der tatsächlich laufenden ModelRuntime. Nach mehreren Saves kann die UI einen weiterhin nötigen Neustart verschweigen oder beim Zurückstellen auf den Laufzeitwert fälschlich verlangen. |
| 116 | P1 | M | PTT-Beginn und -Ende besitzen keinen Renderer-Flush-/ACK-Vertrag. Der 2.048-Sample-Workletpuffer kann bis zu etwa 128 ms Vor-Key-Audio der neuen Capture-ID zuordnen und am Key-up ebenso bis zu etwa 128 ms Wortende sowie noch fliegende IPC-Chunks aus der STT-Aufnahme verlieren. |
| 117 | P1 | S | Nach Track- oder Geräteverlust versucht AudioBridge den Live-Capture genau einmal wiederaufzubauen. Scheitert dieser Versuch transient, wird kein Backoff-Retry geplant und F9 bleibt bis zu einem späteren Config-/Capability-Ereignis oder Neustart deaktiviert. |
| 118 | P1 | S | Wirft `webContents.send()` bei einem schließenden oder abgestürzten Fenster, bricht `forwardToRenderers()` den gesamten Fan-out ab. Spätere Fenster – einschließlich Dashboard – verlieren dadurch Chunks, terminale Events oder Playback-Anforderungen. |
| 119 | P2 | S | Das später geöffnete Voice-Out-Fenster liest keinen initialen TTS-Capability-Snapshot. War TTS bereits beim Boot unavailable, zeigt das Fenster den Offline-Zustand bis zu einer weiteren Capability-Änderung nicht an. |

### Wesentliche Restpfade und Abgrenzungen

- 102 und 109 sind verbleibende Folgepfade von 83: 83 schloss die direkte Persistenzgrenze, aber weder die Provenienz über Folgeturns noch die strukturelle Erkennung echter URLs.
- 107, 110 und 112 sind von 87 getrennt: 87 begrenzte das Warten und löste den Search-Lock; offen bleiben Netzwerkziel-Validierung, nachlaufende native Session-Mutationen und die dauerhafte Fenster-/Navigations-Containment-Policy.
- 111 ist die weiterhin unvollständige ModelRuntime-State-Machine aus 92 und nicht der Faster-Whisper-Initialpfad aus 94.
- 114 ist der reale Cross-Window-Restpfad von 99; der direkte Home-Mute-Patch bleibt davon getrennt.
- 116 und 117 sind offene Randpfade von 78/79 beziehungsweise 54/95: Worklet-Grenzen besitzen weiterhin keinen Flush-/ACK-Vertrag und Live-Recovery nutzt den vorhandenen Initial-Backoff nicht.
- 118 ist nicht die frühere Listener-Isolation aus 14 oder die Diagnosemetadaten-Korrektur aus 33; der Fehler entsteht innerhalb eines einzelnen Multi-Renderer-Listeners nach dem ersten werfenden Fenster.

### Audit-Verifikation

- Runtime-, Boot-, Provider-, Browser- und Config-Bereich: 103 von 103 gezielten Tests grün.
- Voice-, Renderer- und IPC-Bereich: 175 von 175 gezielten Tests grün.
- Direkte Repros bestätigten unter anderem die Leerstring-zu-Null-Konvertierung, die fehlende URL-Erkennung im Memory-Ausschluss, den CAPTCHA-Fehlalarm, zerrissene Context-Fenster sowie die beiden Runtime-Recovery-Sackgassen.
- Die grünen Bestandsprüfungen decken die neuen Abläufe nicht ab; für jeden Befund fehlt mindestens ein passender Regressionstest.
- In diesem Audit wurden keine Produktcode-Fixes umgesetzt. Das bereits vorhandene ungetrackte `docs/architecture/` blieb unverändert.

Layer 1 bleibt damit offen. Vor einer praktischen Windows-Matrix sollten mindestens die P1-Befunde 100 bis 105, 107, 109, 111, 112, 114 und 116 bis 118 umgesetzt und anschließend gezielt regressionsgeprüft werden. Ein weiteres vollständiges Audit ist mit diesem Ergebnis ausdrücklich nicht automatisch beauftragt.

## Umsetzung der achten Befundrunde

Die Befunde 100 bis 119 wurden vollständig umgesetzt und mit Regressionstests abgesichert:

- Chat- und Action-Eingänge teilen eine zentrale Längengrenze beziehungsweise strikt nichtleere numerische Schemas; stille Ablehnungen werden sichtbar und reservierte Built-ins einschließlich vorhandener Alt-Kollisionen werden zentral bereinigt.
- Flüchtige, ausgeschlossene und externe Inhalte behalten ihre Provenienz. Ein Turn, der solche Inhalte tatsächlich einbezieht, bleibt ebenfalls flüchtig; Quelle und Ableitung werden danach aus der Live-History verbraucht, sodass spätere unabhängige Turns wieder normal gespeichert werden können.
- User- und Assistant-Nachrichten eines Turns werden über einen Storage-Batch atomar geschrieben; Start- und Live-Kontext werden nur noch als vollständige Turngruppen zugeschnitten.
- Bestätigungen zeigen die validierte Action samt Parameter, und die konkrete Bestätigungsausgabe wird vor dem Sideeffect-Request veröffentlicht.
- Der SandboxBrowser akzeptiert nur öffentliche HTTPS-Ziele, prüft Hostauflösung vor der Fenstererzeugung sowie erneut über den Resolver der isolierten Electron-Session, sperrt Popups dauerhaft, tokenisiert spätere Navigationen und trennt jede neue Fenstergeneration über eine eigene nicht persistente Sessionpartition.
- ModelRuntime und Router-Service bleiben bei initialen Docker-/Ollama-/Routerfehlern recovery-fähig; Router- und Worker-Rechecks laufen weiter, bis die Capability wieder bereit ist.
- Audio-Saves sind feldweise und werden an alle lebenden lokalen Fenster gespiegelt; `restartRequired` vergleicht gegen den unveränderlichen Laufzeit-Boot-Snapshot.
- PTT besitzt nun einen korrelierten Worklet-Begin-/Flush-/Cancel-Vertrag, wartet auf die Capture-spezifische IPC-Kette und bestätigt Main erst nach vollständigem Restblock. Fehlende Worklets, Teardown, Gerätewechsel und Capture-Verlust enden kontrolliert statt gekürztes Audio zu transkribieren.
- Live-Capture-Recovery verwendet Backoff und verliert auch einen zweiten Track-Ausfall während laufender Recovery nicht. Renderer-Fan-out ist pro Fenster fehlerisoliert; Voice-Out reconciliert initiale Capability- und State-Snapshots gegen neuere Events.

Das gegenseitige Integrationsreview schloss zusätzlich unmittelbar zusammenhängende Folgepfade: IPv4-mapped IPv6, veraltete asynchrone Browsernavigationen, sichtbar stehenbleibende alte Browserergebnisse, falsche Flush-Erfolgs-ACKs, verlorene Recovery-Ereignisse, Gerätewechsel während aktivem F9, non-flush Worklet-/IPC-Cleanup, veraltete Voice-State-Snapshots und bereits gespeicherte `/confirm`-Kollisionen.

Der integrierte Stand bestand danach 85 Testdateien mit 924 Tests, Main- und Renderer-Typecheck, den vollständigen Build und `git diff --check`. Die native SQLite-Bindung wurde anschließend wieder für Electron 41.1.1 hergestellt.

Bewusst verbleibendes Restrisiko: Die doppelte öffentliche Hostprüfung nutzt unmittelbar vor der Navigation bereits den Resolver derselben Electron-Session und damit deren DNS-Cache. Eine kryptografische Bindung der geprüften IP an die nachfolgende Chromium-Verbindung ist mit `BrowserWindow.loadURL()` jedoch nicht verfügbar; vollständiges DNS-Rebinding-Pinning würde einen eigenen lokalen Proxy- beziehungsweise Netzwerkpfad erfordern. Dieses enge Restfenster wurde nicht durch eine unverhältnismäßige neue Netzwerkarchitektur ersetzt.

Mit dieser Umsetzung ist kein neuntes vollständiges Audit beauftragt. Die praktische Windows-Matrix und das weitere Vorgehen werden weiterhin separat abgestimmt.

## Ergebnis des neunten vollständigen Audits

Auf ausdrücklichen neuen Auftrag wurde ausschließlich Layer 1 bis hinunter zu Layer 0 erneut geprüft. Eigenständige Layer-2-Themen wie Memory-, Berechtigungs- oder Privacy-Policy waren nicht Teil dieses Durchgangs. Überschneidungen zwischen den Prüfpfaden wurden nur einmal gezählt. Das Audit fand 13 neue produktiv erreichbare Ursachen:

| Nr. | Priorität | Befund |
|---:|:---:|---|
| 120 | P1 | Speichern fachfremder Controls wie Quiet Mode oder Custom Commands wendet die komplette Voice-Konfiguration erneut an und kann einen laufenden Voice-Turn abbrechen. |
| 121 | P1 | Mehrere direkte Renderer-Sends für Voice-Level, Runtime-Status, Voice-Input-Konfiguration und Systemmetriken sind nicht pro Fenster isoliert; ein schließendes Fenster kann Fan-out oder Capture-IPC abbrechen. |
| 122 | P1 | Der noch nicht funktionsfähige Keyword-Modus wird im Main-Prozess wie `off` behandelt, hält den Renderer-Capture aber weiter warm. |
| 123 | P1 | Ein suspendierter oder unterbrochener Capture-`AudioContext` bleibt fälschlich bereit und besitzt keinen begrenzten Resume-/Recovery-Pfad. |
| 124 | P1 | Ungültige Push-to-Talk-Tasten passieren das Schema und deaktivieren PTT erst still im nativen Hotkey-Layer. |
| 125 | P2 | Ein verspäteter initialer Voice-State-Snapshot kann einen neueren Live-State im Renderer überschreiben. |
| 126 | P1 | Voice-Level-Telemetrie ist nicht an die aktive `captureId` gebunden und leitet auch verworfene beziehungsweise veraltete Chunks weiter. |
| 127 | P1 | Der Lifecycle-Servicebericht kann einen präziseren, vom recovery-fähigen Router bereits publizierten Fehlerzustand fälschlich mit `ready` überschreiben. |
| 128 | P1 | Router-, Action- oder Teilworkerfehler können als erfolgreicher „Worker nicht verfügbar“-Fallback maskiert werden, sobald der Worker-Snapshot nach dem Fehler unavailable ist. |
| 129 | P1 | Ein absichtlich ersetzter SandboxBrowser-Redirect kann durch das nachfolgende Chromium-`ERR_ABORTED` trotzdem als fehlgeschlagene Navigation enden. |
| 130 | P2 | Ein verspäteter initialer Runtime-Snapshot kann einen neueren Live-Runtime-Status im Dashboard überschreiben. |
| 131 | P1 | Leere terminale Worker- beziehungsweise Search-Modellantworten werden als erfolgreiche Ergebnisse akzeptiert. |
| 132 | P1 | Modell-Deadlines werfen einen normalen `Error('timeout')`; der Router-Zweig für `TimeoutError` und der vorgesehene Retry sind dadurch unerreichbar. |

### Umsetzung der neunten Befundrunde

Alle 13 Befunde wurden umgesetzt und regressionsgetestet. Voice-Konfiguration wird nur noch bei tatsächlich relevanten Änderungen neu angewendet, Voice-Modi und PTT-Tasten werden zentral normalisiert beziehungsweise validiert, Capture- und Level-Ereignisse sind korreliert und AudioContext-Recovery ist begrenzt. Renderer-Fan-out und Snapshots sind gegen tote Fenster und veraltete Antworten isoliert. Router-, Search- und Worker-Abschlüsse bleiben ehrlich und leere Antworten schlagen kontrolliert fehl.

Beim direkten Integrationsreview wurde zusätzlich ein enger Lifecycle-Unterpfad geschlossen: Nach einer Recovery-Transition von `degraded` zu `starting` durfte der bereits abgeschlossene App-Start den Runtime-Zustand nicht dauerhaft im Bootzustand halten. Dieser Nachzug gehört zur Umsetzung von Befund 127 und wurde nicht als eigener Auditbefund gezählt.

Der integrierte Stand bestand danach 88 Testdateien mit 947 Tests, beide Typechecks, den vollständigen Build und `git diff --check`.

## Ergebnis des zehnten vollständigen Audits

Weil Audit 9 mehr als fünf Befunde hatte, folgte automatisch ein weiterer, erneut auf Layer 1 und Layer 0 begrenzter Durchgang mit vertauschten Prüfbereichen. Er fand acht neue eigenständige Fehler:

| Nr. | Priorität | Befund |
|---:|:---:|---|
| 133 | P1 | Ein Capture-Readiness-Flap während gehaltenem PTT kann den Hotkey neu registrieren und dadurch die physische Key-up-Flanke verlieren. |
| 134 | P1 | Renderer-Reload oder -Crash während eines Captures beendet nur den Renderer-Graph; der Main-Turn kann in `listening` weiterlaufen. |
| 135 | P2 | Ein verspäteter Fehler des initialen Runtime-Snapshot-IPC deaktiviert den Chat auch nach einem neueren Live-`ready`. |
| 136 | P1 | Ein Worker-Recheck publiziert für einen bereits geladenen Router erneut `starting`; der Early Return des Modellwechsels stellt `ready` danach nicht wieder her. |
| 137 | P1 | Beim internen Modell-Timeout kann der providerseitige `AbortError` das `TimeoutError`-Promise gewinnen; Retry und Fehlerklassifikation werden dadurch umgangen. |
| 138 | P1 | Bricht der Worker nach bereits sichtbaren Chunks ab, ergänzt der Router einen zweiten Fallback und beendet den Turn fälschlich erfolgreich. |
| 139 | P2 | Der in `AudioBridge.start()` ausgewählte Voice-Snapshot kann nach asynchronem Capture-Warmup einen inzwischen neueren Live-State überschreiben. |
| 140 | P1 | Ein während des Boots publizierter Recovery-Zustand `starting` kann durch den erfolgreichen Servicebericht vor Abschluss der Recovery mit `ready` überschrieben werden. |

### Umsetzung der zehnten Befundrunde

Alle acht Befunde wurden umgesetzt. Hotkey-Ownership bleibt über transiente Capture-Recovery erhalten; Renderer-Verlust terminalisiert den korrelierten Capture mainseitig. Runtime- und Voice-Snapshots besitzen symmetrische Revisionsgrenzen. ModelRuntime publiziert bereits geladenen Routerzustand korrekt, eigene Deadlines bleiben auch gegenüber abort-reaktiven Providern `TimeoutError`, und ein Worker-Midstream-Fehler erzeugt genau ein Fehlerterminal. Unvollständige Assistant-Bubbles werden bei `error` ebenso wie bei `canceled` verworfen.

Der integrierte Stand bestand danach 89 Testdateien mit 957 Tests, beide Typechecks, den vollständigen Build und `git diff --check`. Da auch dieser Durchgang mehr als fünf Befunde hatte, folgte automatisch Audit 11.

## Ergebnis des elften vollständigen Audits

Audit 11 prüfte erneut nur Layer 1 bis Layer 0 und konzentrierte sich auf die soeben geänderten Übergänge sowie ihre direkten Komponentenverträge. Nach Deduplizierung verblieben genau fünf neue Fehler:

| Nr. | Priorität | Befund |
|---:|:---:|---|
| 141 | P2 | Ein beim Workerfehler im Dashboard verworfener Teilstream wird von VoiceService weitergesprochen und anschließend noch um die Fehleransage ergänzt. |
| 142 | P1 | Renderer-Verlust beendet eine aktive TTS-Wiedergabe nicht; Queue und Voice-State warten bis zum Playback-ACK-Timeout und können weitere Audiodaten an den verlorenen Renderer senden. |
| 143 | P1 | Bleibt die PTT-Taste während eines Renderer-Neustarts physisch gehalten, kann ein Keyrepeat nach der Neuregistrierung ungewollt einen zweiten Capture starten. |
| 144 | P1 | Scheitert beim Idle-Restore das Entladen des Workers, bleibt der nicht erreichbare Router fälschlich `ready` und es wird kein Recovery-Recheck geplant. |
| 145 | P2 | Erholt sich der Router während desselben Boots, hält die Bootsequenz trotzdem am zuerst beobachteten `router-terminal` fest und überspringt den Ready-Abschluss. |

### Umsetzung und Stopbedingung der elften Befundrunde

Alle fünf Befunde wurden umgesetzt und regressionsgetestet. Fehlerhafte Teilstreams verlieren aktive, vorgepufferte, wartende und während PTT zurückgestellte TTS-Arbeit, bevor ausschließlich die Fehleransage ausgegeben wird. Renderer-Präsenz und Mikrofon-Readiness sind getrennte Zustände; Renderer-Verlust stoppt die gesamte nicht mehr zustellbare Audioarbeit, während ein vorhandener Renderer auch bei deaktiviertem Mikrofon weiter TTS abspielen kann. Der native Hotkey behält den physischen Held-Latch über Renderer-Recovery, ohne den normalen Key-up bei einem bloßen Capture-Flap zu verlieren. Fehlgeschlagene Worker-Unloads degradieren nun auch den unerreichbaren Router und planen Recovery; die Bootsequenz gleicht ihren Abschluss gegen den aktuellen Lifecycle-Snapshot ab.

Die abschließende Vollprüfung bestand 89 Testdateien mit 963 Tests, Main- und Renderer-Typecheck, den vollständigen Produktionsbuild und `git diff --check`. Gemäß der vereinbarten Schwelle endet die automatische Audit-Schleife hier: Genau fünf Befunde wurden vollständig umgesetzt, daher folgt kein zwölftes Audit. Eine praktische Windows-Matrix bleibt eine separate Abnahme und wurde in dieser Code-Audit-Schleife nicht ausgeführt.

## Praktische Windows-Abnahme – Sitzung 1

Die praktische Abnahme begann am 27.08.2026 auf dem aktuellen PR-Branch. Der erste Kaltstart, ein normaler Fensterschluss und der erste reale Chatturn ergaben vier neue Laufzeitbefunde:

| Nr. | Priorität | Befund |
|---:|:---:|---|
| 146 | P1 | Der Renderer gab das Warten auf Pipers terminalen Bootzustand nach acht Sekunden auf, obwohl Main bei einem kalten Whisper-Start begrenzt bis zu 330 Sekunden auf den Service-Lifecycle wartet. Dadurch entfielen Orb-Break und Bereitschaftsansage trotz später erfolgreicher Voice-Readiness. |
| 147 | P0 | Der produktive Router-Call besaß weder einen eigenen `num_predict`-Deckel noch eine harte Gesamtdauer. Der reale Phi-4-Mini-Request erzeugte mehr als 12.000 Tokens und blockierte den Worker-Fallback rund fünf Minuten. |
| 148 | P1 | Ein gesendeter Chatturn zeigte bis zum ersten Worker-Chunk keine turnbezogene Processing-Bubble und wirkte während Routing und Modellwechsel wie nicht gestartet. |
| 149 | P1 | Reine Textchat-Turns wurden im PTT-Modus nicht als unterbrechbarer Processing-Besitz geführt. F9 eröffnete deshalb parallele leere Voice-Turns, statt den hängenden Chatturn abzubrechen. |

### Umsetzung und Abnahmestand

- Befund 146 wurde behoben: Der Renderer wartet innerhalb einer eigenen 340-Sekunden-Sicherheitsgrenze auf das autoritative `piper-ready` beziehungsweise `piper-unavailable`. Der wiederholte reale Kaltstart bestand Orb-Break und Bereitschaftsansage. Elf gezielte Boottests und beide Typechecks waren grün.
- Der normale Fensterschluss wurde praktisch bestanden: Electron und Whisper endeten vollständig, Whisper bestätigte `/shutdown`, es blieben keine Sarah-eigenen Python-/Electron-Prozesse und kein geladenes Ollama-Modell zurück.
- Befund 147 wurde mit einem produktiven Routerdeckel von 64 Tokens, Temperatur 0 und einer harten 15-Sekunden-Gesamtdeadline behoben.
- Befund 148 wurde durch eine sofortige turnbezogene `Wird verarbeitet …`-Bubble behoben, die beim ersten Chunk übernommen und auf Reject-, Error- oder Terminalpfaden entfernt wird.
- Befund 149 wurde behoben: Im PTT-Modus besitzt VoiceService auch aktive reine Textturns für Barge-in; F9 cancelt und terminalisiert den bisherigen Turn, bevor ein neuer Capture-Turn beginnt.
- Der integrierte Zwischenstand bestand sieben gezielte Testdateien mit 152 Tests, Main- und Renderer-Typecheck sowie `git diff --check`.
- Die praktische Wiederholung der Befunde 147 bis 149, der Chat-/Speak-A/B-Test und die vollständige Suite samt Produktionsbuild sind für die nächste Abnahmesitzung vorgesehen. Bis dahin bleibt Layer 1 offen und PR #31 ungemergt.
