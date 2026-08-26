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
