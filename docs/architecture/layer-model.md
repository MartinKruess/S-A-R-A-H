# S.A.R.A.H. – Architektur-Layer

**Stand:** 03.09.2026
**Geltungsbereich:** S.A.R.A.H. Desktop und die darauf aufbauenden späteren Systeme
**Zweck:** Dauerhafte Zuordnung technischer Verantwortung, bekannter Bestandteile und zukünftiger Erweiterungen

## 1. Warum dieses Layer-Modell existiert

S.A.R.A.H. wird in sieben projektspezifische Architektur-Layer von **Layer 0 bis Layer 6** gegliedert. Diese Layer sind kein Ersatz für Features, Pläne oder die Phase-1-Checkliste. Sie beantworten eine andere Frage:

> An welcher Stelle des Systems gehört eine Verantwortung hin und auf welchem Fundament baut sie auf?

Das Modell ist außerdem **nicht** das OSI-Modell. Die sieben OSI-Schichten beschreiben Netzwerkkommunikation. Die sieben S.A.R.A.H.-Layer beschreiben den Aufbau des Assistenten.

Neue Komponenten und Befunde werden künftig dem primär verantwortlichen Layer zugeordnet. Wenn eine Aufgabe mehrere Layer verbindet, erhält sie einen primären Besitzer und dokumentierte Anschlussstellen statt mehrfacher, voneinander abweichender Implementierungen.

## 2. Gesamtübersicht

```text
Layer 6  Proaktivität & Autonomie
    nutzt eigenständig Regeln, Planung, Tools und Benachrichtigungen

Layer 5  Produkterlebnis & UI
    macht Zustände, Entscheidungen, Rückfragen und Ergebnisse bedienbar

Layer 4  Fähigkeiten & Tools
    führt konkrete Aktionen in Programmen, Diensten und der Umgebung aus

Layer 3  Intelligence, Decisions & Planning
    versteht Ziele, plant Schritte, wählt Modelle und Tools und prüft Ergebnisse

Layer 2  Kontext, Memory, Regeln & Berechtigungen
    bestimmt Wissen, Grenzen, Datenschutz und erlaubte Handlungen

Layer 1  Turn-, IPC- & Ereignis-Orchestrierung
    transportiert und korreliert jede Verarbeitung eindeutig und abbrechbar

Layer 0  Runtime-, Service- & Modell-Lifecycle
    startet, überwacht, degradiert, repariert und beendet das technische System
```

Das System wird nach oben fachlich breiter. Viele UI-Flächen und Fähigkeiten verwenden dieselben wenigen Verträge der unteren Layer. Das bedeutet nicht, dass die oberen Layer erst ganz am Ende entstehen: Eine minimale UI und einzelne Tools werden früh benötigt, dürfen aber die unteren Verantwortlichkeiten nicht selbst nachbauen.

## 3. Statusmodell

- 🟢 **Tragfähig:** Die aktuell benötigten Garantien sind automatisiert und praktisch ausreichend belegt.
- 🟡 **Teilweise tragfähig:** Wesentliche Strukturen bestehen, aber bekannte relevante Lücken sind offen.
- 🔴 **Nicht tragfähig:** Die gemeinsame Architektur fehlt oder wird nur durch Einzelfälle simuliert.
- ⚪ **Noch nicht auditiert:** Der Zielbereich ist grob beschrieben, aber weder vollständig geplant noch gegen den Codebestand geprüft.

Ein Layer kann nach einer Integration wieder von Grün auf Gelb wechseln. Ein früherer Abnahmestand bleibt dokumentiert, ersetzt aber keine neueren Laufzeitbefunde.

## 4. Layer 0 – Runtime-, Service- und Modell-Lifecycle

**Leitfrage:** Ist S.A.R.A.H. technisch betriebsbereit und sagt sie darüber die Wahrheit?
**Aktueller Stand:** 🟢 – die aktuell benötigten Runtime-, Recovery-, Modell- und Shutdown-Garantien sind automatisiert sowie in der aktualisierten Windows-Matrix praktisch belegt. Höhere Layer können gezielte neue Regressionen erforderlich machen.

### Gehört zu Layer 0

- Electron-Appstart und Bootstrap
- Konfiguration laden, validieren und kontrolliert auf Defaults zurückfallen
- `ServiceRegistry` und gemeinsamer Service-Lifecycle
- `AppLifecycleController` und Runtime-Zustände
- Start, Readiness, Degradation, Recovery und Shutdown
- Router-, Worker- und Modell-Lifecycle
- Ollama-/Docker-Verfügbarkeit und Modellwechsel
- Whisper-, Piper- und weitere Provider-Lifecycles
- Capability-Zustände wie STT, TTS, Router und Worker
- Ressourcenbesitz, Prozessbereinigung, Ports und Zombie-Vermeidung
- Splash-, Wizard- und Dashboard-Übergang als Boot-Lifecycle
- harte technische Deadlines für Start-, Health- und Cleanup-Operationen

### Bereits vorhandene Grundlage

- zentrale Service-Registrierung und geordneter Shutdown
- differenzierte Runtime- und Capability-Zustände
- kontrollierte Teildegradation bei mehreren Dienstausfällen
- Modellrollen und grundlegender Router-/Worker-Wechsel
- Provider-Start, -Stop und mehrere Recovery-Pfade
- praktisch bestandene Windows-Lifecycle-Matrix des damaligen Abnahmestands

### Weitere Regression bei neuen Anforderungen

- gezielte Regression der unteren Verträge, wenn höhere Layer neue Lifecycle-, Provider- oder Ressourcenanforderungen ergänzen

Verbindliche Detailpläne:

- [`layer0-runtime-and-model-lifecycle-plan.md`](../steps/layer0-runtime-and-model-lifecycle-plan.md)
- [`layer0-closing-gaps-plan.md`](../steps/layer0-closing-gaps-plan.md)

## 5. Layer 1 – Turn-, IPC- und Ereignis-Orchestrierung

**Leitfrage:** Welche Verarbeitung gehört zu welcher Eingabe, wer besitzt sie gerade und wie wird sie sicher beendet?
**Aktueller Stand:** 🟢 – die zentrale Architektur ist nach elf vollständigen Audits, 153 umgesetzten Befunden und der aktualisierten praktischen Windows-Matrix für den aktuellen Layer-1-Scope tragfähig. Die kommende Layer-2-Integration wird gezielt gegen diese Verträge regressionsgeprüft.

### Gehört zu Layer 1

- IPC-Verträge zwischen Main, Preload und Renderer
- typisierter Message Bus und Fehlerisolation seiner Listener
- eindeutige Turn-, Request-, Output-, Capture- und Playback-IDs
- Annahme, Queue, Ausführung, Abbruch und terminaler Turnabschluss
- genau ein autoritativer Besitzer je Verarbeitungsschritt
- Korrelation von Router, Worker, Action und Toolergebnis
- Korrelation von Aufnahme, STT, TTS und physischer Wiedergabe
- Unterbrechung über F9 beziehungsweise Barge-in
- Umgang mit verspäteten, doppelten oder fremden Ereignissen
- Streaming-Vertrag einschließlich Sequenz und vollständigem Abschluss
- Chat-, Voice-, System- und autonome Turn-Herkunft
- turnbezogene Diagnose- und Performance-Daten

### Bereits vorhandene Grundlage

- zentraler `TurnCoordinator` mit begrenzter Queue
- Turn- und Output-Korrelation durch die wesentlichen Verarbeitungspfade
- genau einmal akzeptierte terminale Zustände
- gemeinsamer Abort-Kontext für zahlreiche Router-, Action-, STT- und TTS-Pfade
- turnbezogene Renderer-Ausgaben statt einer einzigen globalen Antwortblase
- korrelierte Audio-Capture- und Playback-Lifecycles
- zahlreiche Regressionstests für Konkurrenz, Abbruch und verspätete Ereignisse

### Weitere Regression bei neuen Anforderungen

- Layer-2-Verträge für Kontext, Persistenz, Regeln und Bestätigungen end-to-end gegen Turn-, Abort- und Terminalverhalten prüfen
- neue Anforderungen höherer Layer gezielt bis zu ihrer tatsächlichen Ursache regressionsprüfen, ohne abgeschlossene untere Layer pauschal neu zu auditieren

Verbindlicher Detailplan:

- [`layer1-turn-orchestration-plan.md`](../steps/layer1-turn-orchestration-plan.md)

## 6. Layer 2 – Kontext, Memory, Regeln und Berechtigungen

**Leitfrage:** Was weiß und darf S.A.R.A.H. in diesem Turn und welche Informationen dürfen danach bestehen bleiben?
**Aktueller Stand:** 🟡 – sieben Fixrunden und sechs unabhängige Kontrollaudits sind technisch abgeschlossen. Der letzte Kontrollaudit fand fünf Befunde (drei P1, zwei P2); alle fünf wurden behoben. Die vollständige Suite mit 1.165 Tests, beide Typechecks und der Produktionsbuild sind grün. Offen ist die praktische Windows-Abnahme, deshalb ist Layer 2 noch nicht als vollständig abgenommen markiert.

### Gehört zu Layer 2

- strukturierte Profildaten und gewünschte Nutzeransprache
- Session-Kontext und begrenztes Kurzzeitgedächtnis
- Langzeitgedächtnis und gezielter Recall
- Relevanzbewertung und Memory-Hygiene
- Zusammenführen verwandter Erinnerungen durch einen späteren Memory-Autor
- explizites „Merke dir“ und gezieltes Vergessen, Korrigieren und Löschen
- Inkognito-/Private-Turns und technische Persistenzverbote
- Memory-Ausschlüsse für Themen und sensible Inhalte
- Prompt-Layer und kontrollierte Kontextzusammenstellung
- Sicherheitsregeln außerhalb frei formulierter Modellprompts
- Risikoklassen und technisch erzwungene Bestätigungen
- Secrets-, Datenschutz- und Vertrauensgrenzen externer Inhalte
- Nutzer-, Geräte- und gegebenenfalls Rollenberechtigungen

### Bereits vorhandene Grundlage

- validierte Profil- und Trust-Konfiguration
- fail-closed Konfigurations-, Schlüssel- und Storage-Recovery
- verschlüsselte lokale Conversation-Persistenz mit gebundener Herkunft und Quarantäne
- atomare Turn-, Session-, Staging- und Curator-Lebenszyklen
- query-bezogener Recall, begrenzter Live-Kontext und konservatives Kontextbudget
- technisch erzwungene Memory-Ausschlüsse und Secret-Erkennung
- mehrturniges Inkognito und flüchtiges `/anonymous`
- zentrale Action-Policy mit turn-, action-, parameter- und anfragegebundenen Bestätigungen
- technisch erzwungene Dateizugriffsgrenzen und sichtbare Degraded-Zustände

### Noch praktisch abzunehmen

- Inkognito in Chat und Speak einschließlich Wechsel, Abbruch und Neustart
- Erinnerungen anzeigen, korrigieren, einzeln löschen und vollständig bereinigen
- Policy-Wechsel während eines bereits laufenden Turns
- sichtbare OAuth-, Schlüssel-, Storage- und Quarantäne-Zustände
- ausdrücklich bestätigter Altwert-Recovery-Dialog einschließlich Sicherung und Abbruch
- Ende-zu-Ende-Verhalten von Recall, Kontextgrenzen und Bestätigungen im realen Windows-Betrieb

Verbindlicher Detailplan und erstes Audit:

- [`layer2-context-memory-security-plan.md`](../steps/layer2-context-memory-security-plan.md)

## 7. Layer 3 – Intelligence, Decisions und Planning

**Leitfrage:** Wie wird aus einem Nutzerziel ein sinnvoller, überprüfbarer Lösungsweg?
**Aktueller Stand:** 🟡 – die Layer-3-Auditserie und der unabhängige Layer-3→2-Closure-Lauf sind technisch abgeschlossen. Routing, Grounding, Policy-Spiegelung und Kontextbudget sind für den aktuellen Funktionsumfang gehärtet. Der begrenzte Multi-Intent-MVP zerlegt zwei bis drei explizite Absichten produktiv, kompiliert sie gegen einen datensparsamen DecisionContext und führt sofort erlaubte Action-/Answer-Schritte seriell mit deterministischer Ergebnisauswertung aus. Gruppenbestätigung, Spezialistenadapter und kontrollierte Re-Planung fehlen noch.

### Gehört zu Layer 3

- Absicht, Ziel und Schwierigkeitsgrad einer Anfrage erkennen
- zwischen direkter Antwort, einfachem Toolbefehl und komplexer Aufgabe unterscheiden
- notwendige Rückfragen erkennen und zum richtigen Zeitpunkt stellen
- Aufgaben in überprüfbare Arbeitsschritte zerlegen
- Planstatus und Abhängigkeiten zwischen Schritten verwalten
- geeignetes Router-, Worker-, Spezial- oder Backend-Modell auswählen
- geeignete Tools und Datenquellen auswählen
- Reihenfolge, Parallelität, Abbruch- und Wiederholungsstrategie bestimmen
- Zwischenergebnisse bewerten und den Plan bei Bedarf anpassen
- Konflikte, fehlende Daten und unzureichende Ergebnisse erkennen
- fertige Ergebnisse gegen Ziel und Nutzerregeln prüfen
- Zeit-, Ressourcen- und Risikobudget einer Aufgabe beachten
- kleine Aufgaben ohne unnötigen Planner-Overhead direkt ausführen

### Vorgesehener Kontrollkreislauf

```text
Ziel verstehen
    -> Rückfragen oder Plan erstellen
    -> Tool/Modell auswählen
    -> Schritt ausführen
    -> Ergebnis bewerten
    -> Plan fortsetzen, korrigieren oder kontrolliert abbrechen
    -> Gesamtergebnis prüfen und ausgeben
```

Router, Planner und Evaluator sind fachlich unterschiedliche Rollen. Für den ersten begrenzten Multi-Intent-Ausbau liefert das bestehende Router-Modell nur einen untrusted Proposal; deterministischer TypeScript-Code validiert und kompiliert ihn. Ein drittes Planner-LLM ist dafür nicht vorgesehen.

### Bereits vorhandene Grundlage

- deterministisches Routing zwischen Direktantwort, Action und Worker
- typisierter Einzel-`ActionIntent` mit Entscheidungs-, Eingabe- und optionaler Interaktionsprovenienz bis durch Bestätigung und Ausführung
- zentrale, vor Ankündigung und Ausführung erneut geprüfte ActionPolicy
- fachliches Grounding für Timer und Reminder sowie ehrliche Kennzeichnung noch rein schema-validierter Action-Parameter
- korrelierte Bestätigungen, die den vollständigen Action-Intent unverändert bewahren
- begrenztes Worker- und Router-Kontextbudget mit ehrlicher Überlaufmeldung
- datensicherer Recall und systemseitige Vertrauensgrenzen für externe beziehungsweise lokale Daten
- abgesicherte Turn-, Privacy- und Provenienzgrenzen zu Layer 1 und 2
- verpflichtende, bei Bestätigungen unverändert gebundene Evidence-Scope-Provenienz für Einzel-Actions und klauselscharfe Multi-Intent-Actions
- produktiver V1-Proposal-Parser für zwei bis drei explizite Intents mit striktem Fail-Closed-Schema und vollständigem Preflight vor dem ersten Seiteneffekt
- unveränderlicher, gefingerprinter Multi-Intent-Plan mit höchstens sechs Schritten und gebundenem Privatkontext
- deterministische Handoff-Grenze `Bestätigung -> Spezialistenübergabe`, noch ohne Executor oder Provider-Aufruf
- unveränderlicher, turngebundener `DecisionContext` mit ausschließlich expliziten Programmrollen und relevanten Quellenhinweisen ohne Pfade oder URLs
- fail-closed `DecisionCapabilitySnapshot` aus Lifecycle-, ModelRuntime-, Service- und Web-Policy-Zustand; Media ohne Readiness-Quelle und Spezialisten ohne Adapter bleiben nicht verfügbar
- lokale Programmrollenauflösung, die den kanonischen Programmnamen und seine Herkunft bis in Bestätigung und Plan-Fingerprint bindet
- serieller, einmaliger Planexecutor mit unveränderlichem Ergebniszustand, Abhängigkeitsauswertung und klauselscharfen Worker-Antworten

### Nächste Architekturbausteine

- actionspezifisches fachliches Grounding der bislang nur schema-validierten Parameter
- turnübergreifend gebundene Gruppenbestätigung für bestätigungspflichtige Multi-Intent-Pläne
- kontrollierte Re-Planung und semantische Ergebnisqualitätsprüfung über den deterministischen MVP hinaus
- echte Executor-Verträge oder fail-closed Ablehnung für Backend-, Extern- und Vision-Routen

Verbindlicher Implementierungsplan für den Vertragsstand:

- [`2026-09-03-multi-intent-contract.md`](../superpowers/plans/2026-09-03-multi-intent-contract.md)
- [`2026-09-03-decision-context-capability-snapshot.md`](../superpowers/plans/2026-09-03-decision-context-capability-snapshot.md)
- [`2026-09-04-bounded-planner-evaluator-mvp.md`](../superpowers/plans/2026-09-04-bounded-planner-evaluator-mvp.md)

## 8. Layer 4 – Fähigkeiten und Tools

**Leitfrage:** Welche konkrete Fähigkeit kann S.A.R.A.H. zuverlässig und sicher ausführen?
**Aktueller Stand:** ⚪/🟡 – mehrere einzelne Fähigkeiten existieren, der gemeinsame Layer ist noch nicht vollständig auditiert.

### Gehört zu Layer 4

- Programme finden, starten, bedienen und kontrolliert schließen
- Spotify- und allgemeine Mediensteuerung
- Browser öffnen, navigieren und Seitenzustände erkennen
- Websuche, Research, Quellenvergleich und Ergebnisextraktion
- Dateien und Ordner suchen, lesen, organisieren und verändern
- Dokument-, Bild-, Archiv- und Installationsdateiverständnis
- Word-, Excel-, PowerPoint- und weitere Office-Fähigkeiten
- Timer, Erinnerungen, Kalender und Termine
- E-Mail- und Nachrichtendienste
- Systemstatus, Ressourcen, Speicher, Netzwerk und First-Level-Diagnose
- benutzerdefinierte Commands und mehrschrittige Skills
- später Smart-Home-, Geräte- und Serverfähigkeiten
- stabile APIs bevorzugen und UI-Automation nur kontrolliert einsetzen

### Bereits vorhandene Grundlage

- Programme generisch über ausführbare Dateien starten
- Spotify-Grundsteuerung einschließlich Lautstärke
- Websuche mit abgesicherter Browserumgebung
- Timer- und Systemactions in begrenztem Umfang
- modularer Action-/Toolvertrag und korrelierte Ergebnisse
- einzelne Medienkontext- und Custom-Command-Strukturen

Jede Fähigkeit muss die Verträge aus Layer 0 bis 3 verwenden. Ein Browser- oder Spotify-Feature darf keine eigene parallele Turn-, Security-, Planungs- oder Persistenzarchitektur aufbauen.

## 9. Layer 5 – Produkterlebnis und UI

**Leitfrage:** Versteht und kontrolliert der Nutzer jederzeit, was S.A.R.A.H. tut?
**Aktueller Stand:** ⚪/🟡 – eine nutzbare Desktop-Oberfläche existiert, eine vollständige Layer-Abnahme fehlt.

### Gehört zu Layer 5

- Desktop-Shell, kompakte Sarah-Ansicht und Dashboard
- Setup-Wizard und Einstellungen
- Textchat, Voice-Modus und getippte Eingabe mit Sprachantwort
- Zustände für Hören, Denken, Toolausführung, Sprechen und Fehler
- verständliche Fortschritts- und Wartehinweise
- sichtbare Rückfragen, Bestätigungen und Sicherheitsentscheidungen
- Anzeige, Bearbeitung und Abbruch mehrschrittiger Aufgaben
- Memory-, Berechtigungs-, Routine- und Datenschutzverwaltung
- Benachrichtigungen und Ergebnisdarstellung
- konsistente Nutzeransprache, Stimme und Persönlichkeitsmodi
- Barrierefreiheit, Tastaturbedienung und verständliche Fehlertexte
- wahrheitsgemäße UI: Anzeige und tatsächlicher Systemzustand dürfen nicht auseinanderlaufen

Die UI ist der oberste Darstellungs-Layer, wird aber nicht erst nach allen anderen Layern gebaut. Sie wächst parallel und darf nur keine fachlichen Entscheidungen duplizieren, die Layer 0 bis 4 gehören.

## 10. Layer 6 – Proaktivität und Autonomie

**Leitfrage:** Wann darf S.A.R.A.H. ohne aktuellen Nutzerbefehl selbst einen Turn beginnen oder eine Aktion ausführen?
**Aktueller Stand:** ⚪ – Zielbild; noch keine vollständige Architektur oder Umsetzung.

### Gehört zu Layer 6

- explizit beauftragte zeitgesteuerte Aufgaben
- ereignisgesteuerte Monitore und wiederkehrende Prüfungen
- proaktive Erinnerungen und Benachrichtigungen
- wiederkehrende Muster erkennen und eine Routine vorschlagen
- vom Nutzer genehmigte Routinen selbstständig ausführen
- autonome Turns mit Herkunft, Besitzer und vollständigem Auditpfad
- Ausführungsfrequenz, Zeitfenster, Budgets und Wiederholungsgrenzen
- pausieren, bearbeiten, deaktivieren und löschen
- Fehler-, Eskalations- und Rückfrageverhalten
- Benachrichtigungswege und Offline-Nachholung
- Schutz vor Schleifen, Spam, ungewollten Käufen und unkontrollierten Seiteneffekten
- nachvollziehbare Erklärung, warum eine autonome Handlung ausgelöst wurde

### Autonomiestufen

1. **Explizite Automatisierung:** Der Nutzer beauftragt eine wiederkehrende Aufgabe.
2. **Proaktive Erinnerung:** S.A.R.A.H. weist selbstständig auf einen bekannten relevanten Zeitpunkt hin.
3. **Routinevorschlag:** Ein erkanntes Muster wird vorgeschlagen, aber noch nicht ausgeführt.
4. **Genehmigte autonome Ausführung:** Eine bestätigte Routine darf innerhalb ihrer Grenzen selbstständig handeln.
5. **Begrenzt adaptive Routine:** Anpassungen sind nur innerhalb vorher definierter Regeln und mit nachvollziehbarer Meldung erlaubt.

Beobachtung allein ist keine Erlaubnis. Wenn der Nutzer regelmäßig um 8 Uhr VS Code und Server startet, darf S.A.R.A.H. zunächst eine Routine vorschlagen. Erst nach Zustimmung darf sie diese selbstständig ausführen.

## 11. Beispiel: Hotels für Hamburg zusammenstellen

Die Anfrage „Such mir für nächste Woche ein Hotel in Hamburg und stell die drei besten Optionen zusammen“ durchläuft mehrere Layer:

1. **Layer 1** eröffnet einen eindeutigen Turn und verwaltet Abbruch sowie Ereignisse.
2. **Layer 2** liefert Reisepräferenzen, Datenschutzregeln, Budgetgrenzen und erlaubte Datenquellen.
3. **Layer 3** klärt fehlende Angaben, plant Suche und Vergleich und bestimmt Prüfkriterien.
4. **Layer 4** führt Browser-, Search- und gegebenenfalls Kalenderfähigkeiten aus.
5. **Layer 3** bewertet Ergebnisse, sucht bei Bedarf nach und wählt drei passende Optionen.
6. **Layer 5** zeigt Fortschritt, Rückfragen, Quellen und Ergebnis verständlich an.
7. **Layer 6** ist nur beteiligt, wenn daraus beispielsweise eine genehmigte tägliche Preisüberwachung entsteht.

Layer 0 stellt währenddessen die technische Betriebsfähigkeit sicher.

## 12. Pflege dieser Dokumentation

- Neue Architekturverantwortungen werden zuerst einem primären Layer zugeordnet.
- Neue konkrete Tools werden unter Layer 4 ergänzt; ihre Planungslogik gehört weiterhin Layer 3.
- Neue UI-Flächen werden unter Layer 5 ergänzt, ohne dort Business- oder Sicherheitslogik zu duplizieren.
- Proaktive Auslöser und Routinen gehören Layer 6, die ausgeführte Fähigkeit weiterhin Layer 4.
- Nach jedem vollständigen Layer-Audit wird der Status aktualisiert.
- Detailbefunde und Umsetzungsschritte bleiben in eigenen Plänen; diese Datei bleibt die verständliche Gesamtkarte.
- Die Phase-1-Checkliste misst Produktfortschritt. Dieses Dokument misst Architekturverantwortung und Fundamentreife. Beide dürfen nicht zu einem einzigen Zähler vermischt werden.

## 13. Aktueller Arbeitsfokus

1. Layer 2 praktisch unter Windows gegen die dokumentierten Kontext-, Memory-, Datenschutz- und Berechtigungsverträge abnehmen.
2. Dabei sichtbare Layer-1/0-Folgefehler an ihrer tatsächlichen Ursache beheben; nach dem sechsten Kontrollaudit mit fünf vollständig behobenen Befunden ist gemäß vereinbarter Schwelle kein weiterer isolierter Layer-2-Vollaudit vorgesehen.
3. Layer 3 erst verbindlich detaillieren, wenn die technische Layer-2-Grundlage auch praktisch ausreichend stabil bestätigt ist.
4. Layer 4 bis 6 zunächst als Zielstruktur pflegen und bei jeder neuen Funktion die Verantwortungsgrenzen einhalten.
5. Die praktische Gesamtmatrix schrittweise erweitern und spätestens nach Layer 6 einmal vollständig bis Layer 0 durchführen.
