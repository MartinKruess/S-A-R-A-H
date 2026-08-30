# Timer-Priorität und pausierbare Sprachausgabe

**Stand:** Abschnitte A bis D implementiert sowie automatisiert und praktisch unter Windows abgenommen
**Branch:** `feat/timer-interruption`
**Scope:** Phase 1, lokaler Desktopbetrieb

## 1. Ziel

Wenn ein Timer während einer längeren gesprochenen Antwort abläuft, darf Sarah weder parallel sprechen noch die Meldung bis zum Ende der Antwort verzögern.

Der Zielablauf lautet:

1. Der aktuell gesprochene Satz wird beendet.
2. Die Timer-Meldung wird mit höherer Priorität gesprochen.
3. Noch nicht gesprochene Antwortsätze bleiben vollständig erhalten.
4. Die normale Sprachausgabe bleibt nach der Timer-Meldung pausiert.
5. Die normalisierte Wortfolge `wieder da` setzt die pausierte Ausgabe fort.
6. Die Textgenerierung darf während der Sprachpause weiterlaufen und weitere Sätze puffern.
7. Es gibt niemals zwei parallele Sprachausgaben.

Die Priorisierung muss als allgemeiner Queue-Vertrag entstehen, nicht als Sonderfall, der lediglich einen Timer an den Anfang eines Arrays setzt.

## 2. Bewusst begrenzter Phase-1-Umfang

In dieser Runde wird ausschließlich `wieder da` als Fortsetzungs-Keyword unterstützt.

- Groß-/Kleinschreibung, umgebende Satzzeichen und STT-Leerzeichen werden normalisiert.
- Die Wortfolge darf Teil einer kurzen Äußerung sein, beispielsweise `Bin wieder da.`.
- Die Erkennung greift nur, wenn tatsächlich eine Timerpause mit erhaltener Ausgabe besteht.
- Ohne Timerpause bleibt dieselbe Äußerung eine normale Nutzereingabe.
- Die Fortsetzung wird lokal erkannt und benötigt weder Router- noch 8B-Inferenz.
- Der Fortsetzungs-Turn erzeugt keine zusätzliche gesprochene Bestätigung wie `Okay`, sondern setzt direkt die gepufferte Ausgabe fort.

Nicht Teil dieser Runde:

- weitere Resume-Formulierungen,
- `warte`, `Sekunde` oder eine manuell ausgelöste Sprachpause,
- ein eigener Abbruchdialog für pausierte Antworten,
- persistente Pausen über einen Sarah-Neustart,
- Wecker oder benannte Timer,
- Mehrsprachigkeit,
- eine allgemeine natürliche Intent-Klassifikation durch ein LLM.

Andere inhaltliche Nutzereingaben behalten das bestehende Barge-in-Verhalten: Sie besitzen höchste Priorität und dürfen alte noch nicht gesprochene Ausgabe verwerfen. Dadurch entsteht kein zweiter wartender Antwortstapel.

## 3. Bestehender Ablauf

### 3.1 Timer

`SystemActions.setTimer()` verwaltet bereits bis zu fünf wall-clock-basierte Timer. Beim Ablauf ruft der Timer den zentralen Notify-Handler mit einem festen deutschen Satz auf.

Relevante Datei:

- `src/services/actions/system-actions.ts`

### 3.2 Benachrichtigung

`ActionService` veröffentlicht den Ablauf als `action:notify`. `RouterService.emitSystemNotification()` stellt diese Meldung derzeit absichtlich hinter den aktiven Turn. Das verhindert überlappende Chunks, führt aber bei langen Antworten zu einer verspäteten Timer-Meldung.

Relevante Dateien:

- `src/services/actions/action-service.ts`
- `src/services/llm/router-service.ts`
- `src/core/bus-events.ts`

### 3.3 Satz- und Audiopuffer

`VoiceService` zerlegt Streaming-Ausgaben bereits über `SentenceBuffer` in vollständige Sätze. `TtsQueue` spielt genau einen Satz und synthetisiert den nächsten Satz vor. Queue-Einträge und vorgerendertes Audio sind bereits einem Turn und Output zugeordnet; Playback-ACK, Timeout, Turn-Abbruch und verspätete Syntheseergebnisse sind abgesichert.

Relevante Dateien:

- `src/services/voice/voice-service.ts`
- `src/services/voice/tts-queue.ts`
- `tests/services/voice/tts-queue.test.ts`
- `tests/services/voice/voice-service.test.ts`

### 3.4 Modell-Idle-Verhalten

Der fünfminütige Idle-Timer des 8B-Workers beginnt erst nach abgeschlossener Worker-Inferenz. Er kennt den TTS-Buffer nicht. Das ist korrekt und soll nicht gekoppelt werden:

- Läuft die Textgenerierung noch, bleibt der Worker durch die aktive Operation geschützt.
- Nach abgeschlossener Generierung liegt die restliche Antwort als Text beziehungsweise TTS-Queue-Zustand im Node-Prozess.
- Ein späterer Wechsel vom 8B-Worker zum Router löscht diesen Puffer nicht.
- `wieder da` kann die TTS-Ausgabe fortsetzen, ohne das 8B erneut zu laden.

Deshalb wird kein künstlicher 60-Sekunden-Heartbeat und kein Modell-Keep-alive ergänzt.

Relevante Datei:

- `src/services/llm/model-runtime.ts`

## 4. Zielvertrag für Prioritäten

Die Sprachausgabe erhält eine kleine, zentral definierte Prioritätsskala:

| Priorität | Kategorie | Phase-1-Nutzung |
|---:|---|---|
| 400 | direkte Nutzereingabe / Barge-in | bestehendes Abbruchverhalten |
| 300 | kritische Sicherheits- oder Systemmeldung | Vertrag vorbereitet; produktive Umstellung separat |
| 200 | Timer / später Wecker und Fristen | in diesem Branch produktiv verwendet |
| 100 | normale angeforderte Antwort | bestehende LLM- und Action-Ausgabe |
| 0 | Füllsatz / Hintergrundhinweis | bestehende Füllsätze zunächst entsprechend markieren |

Regeln:

1. Gleiche Prioritäten bleiben FIFO-stabil.
2. Ein bereits abgespielter Satz wird nicht mitten im Audio abgeschnitten.
3. Nach dem Playback-ACK des aktuellen Satzes wird der höchstpriorisierte wartende Eintrag gewählt.
4. Vorgerendertes Audio niedrigerer Priorität bleibt erhalten und wird nicht unnötig erneut synthetisiert.
5. Ein Prioritätseintrag darf nur niedrigere Prioritäten überholen, nicht bereits aktive Wiedergabe.
6. Mehrere gleichzeitig fällige Timer werden untereinander FIFO gesprochen, bevor die normale Ausgabe pausiert bleibt.
7. Kritische Meldungen dürfen einen wartenden Timer überholen; die produktive Einspeisung bestehender Fehler wird nicht ungeprüft in diesen Branch gezogen.

## 5. Pausenvertrag

Die Pause gehört der Sprachausgabe, nicht dem Modell und nicht dem fachlichen Turn.

### 5.1 Eintritt

Ein Timer verlangt nur dann eine anschließende Pause, wenn normale gesprochene Ausgabe aktiv, vorgepuffert oder noch streamend ist. Läuft der Timer im Leerlauf ab, wird er normal gesprochen und Sarah bleibt anschließend nicht künstlich pausiert.

### 5.2 Zustand

Während der Pause:

- bleibt höchstens ein normaler Antwortstrom erhalten,
- dürfen weitere normale Sätze in dieselbe begrenzte Queue gelangen,
- dürfen weitere Timer oder kritische Meldungen die Pausenschranke passieren,
- darf normale Ausgabe nicht abgespielt werden,
- gilt die Queue weiterhin als belegt, aber nicht als aktiv sprechend,
- darf F9 eine neue Aufnahme beginnen, ohne den pausierten Buffer vor der Intent-Prüfung zu löschen.

Der Buffer bleibt ausschließlich flüchtig. Er wird bei Shutdown, Renderer-Verlust mit nicht wiederherstellbarer Audio-Ownership oder einer neuen inhaltlichen Barge-in-Anfrage verworfen. Ein separates Zeitlimit wird in Phase 1 nicht benötigt, weil nur ein durch die bestehende Antwortgrenze beschränkter Strom gehalten wird.

### 5.3 Fortsetzung

Bei erkannter Wortfolge `wieder da`:

1. wird kein LLM aufgerufen,
2. wird kein neuer Antworttext erzeugt,
3. wird die Pausenschranke aufgehoben,
4. wird zuerst vorhandenes vorgerendertes Audio verwendet,
5. läuft danach die normale Queue in ursprünglicher Reihenfolge weiter.

## 6. Ereignis- und Besitzmodell

Der Router bleibt Eigentümer sichtbarer Assistentenausgaben; der VoiceService bleibt Eigentümer von TTS und Playback.

Vorgeschlagener Ablauf:

1. `action:notify` erhält typisierte Metadaten für Art und Sprachpriorität oder wird unmittelbar im Router in ein typisiertes Priority-Output übersetzt.
2. Der Router akzeptiert synchron einen korrelierten System-Turn für die Benachrichtigung.
3. Der Router veröffentlicht eine neue main-process-interne Priority-Speech-Nachricht an den VoiceService.
4. Der VoiceService reicht sie mit Priorität 200 und bedingter Pausenschranke an die TTS-Queue.
5. Die sichtbare Timer-Nachricht bleibt über den seriellen Router-Ausgang geordnet, erhält aber für denselben Turn eine unterdrückte normale Sprachausgabe. So wird sie nicht doppelt gesprochen.
6. Die TTS-Queue beendet den aktiven Satz, spricht alle fälligen höherpriorisierten Einträge und aktiviert anschließend die Pause vor Priorität 100 und niedriger.

Die konkrete Busform soll bei der Umsetzung anhand der existierenden MessageBus-Validierung gewählt werden. Entscheidend sind:

- genau ein sichtbarer Timer-Output,
- genau eine gesprochene Timer-Meldung,
- keine Umgehung der Turn-Korrelation,
- kein direkter Renderer- oder ActionService-Zugriff auf interne TTS-Zustände.

## 7. Geplante Änderungen nach Datei

### `src/core/bus-events.ts`

- typisierte interne Priority-Speech-Nachricht oder erweiterte Notify-Metadaten,
- keine untypisierten Event-Payloads.

### `src/services/voice/tts-queue.ts`

- Priorität an `TtsQueueItem`,
- stabile priorisierte Einfügung,
- Auswahl höherer Priorität nach aktuellem Satz,
- Erhalt eines niedrigpriorisierten Prebuffers,
- Pausenschranke für normale Ausgabe,
- `resume()` und `isPaused`,
- sauberes Stop-/Cancel-/Fehlerverhalten im pausierten Zustand.

### `src/services/voice/voice-service.ts`

- Empfang der Priority-Speech-Nachricht,
- Entscheidung, ob eine normale Ausgabe unterbrochen und anschließend pausiert werden muss,
- UI-/Voice-State darf während der Pause nicht fälschlich `speaking` melden,
- F9 während einer Timerpause startet Aufnahme, ohne den Buffer sofort zu verwerfen,
- Resume-Ereignis hebt die Queue-Pause auf.

### `src/services/llm/router-service.ts`

- Timer-Notify nicht mehr ausschließlich hinter den aktiven Sprachfluss stellen,
- sichtbaren Output weiter seriell und korreliert halten,
- doppelte TTS-Ausgabe unterdrücken,
- `wieder da` nur bei aktivem Pausenzustand lokal abfangen,
- andere Nutzereingaben über das bestehende Barge-in-Verhalten behandeln.

### `src/services/llm/model-runtime.ts`

- keine produktive Änderung vorgesehen,
- nur Regressionstest oder Dokumentationskommentar, falls der Review einen Beleg für die Entkopplung verlangt.

## 8. Umsetzungsabschnitte und sichere Haltepunkte

### Abschnitt A — Queue-Vertrag

**Status:** Implementiert; gezielte Queue-Tests und Main-Typecheck grün.

- Priorität, Prebuffer-Auswahl, Pause und Resume in `TtsQueue`.
- Ausschließlich gezielte Queue-Tests.
- Noch keine produktive Timer-Verdrahtung.

**Sicherer Haltepunkt:** Der bestehende Produktfluss bleibt unverändert, neue Queue-Fähigkeiten sind isoliert geprüft.

### Abschnitt B — VoiceService

**Status:** Implementiert; gezielte Bus-/Queue-/Voice-Tests und Main-Typecheck grün.

- Priority-Speech empfangen.
- Timerpause und F9-Aufnahme ohne Bufferverlust verwalten.
- Voice-State und Cleanup absichern.

**Sicherer Haltepunkt:** Die Voice-Schicht kann priorisieren und pausieren; der produktive Timer verwendet den neuen Pfad noch nicht.

### Abschnitt C — Router und Fortsetzung

**Status:** Implementiert; gezielte Router-/Voice-/Bus-Tests und Main-Typecheck grün.

- Timer-Notify produktiv an den Priority-Pfad anbinden.
- sichtbaren und gesprochenen Output entkoppeln.
- `wieder da` lokal abfangen und Resume auslösen.

**Sicherer Haltepunkt:** Feature technisch vollständig; die praktische Windows-Abnahme folgt in Abschnitt D.

### Abschnitt D — Abschlussprüfung

**Status:** Automatisierte Prüfung und praktische Windows-Abnahme abgeschlossen.

- gezielte Integrationsprüfungen,
- beide Typechecks,
- vollständige Suite,
- Produktionsbuild und `git diff --check`,
- praktischer Windows-Test.

Technischer Stand:

- fokussierte Timer-/Router-/Voice-/Bus-Matrix: 215/215 grün,
- vollständige Suite: 107 Testdateien und 1391/1391 Tests grün,
- Main- und Renderer-Typecheck grün,
- Produktionsbuild grün,
- `git diff --check` grün.

Praktischer Stand unter Windows:

- Timer übernimmt erst nach dem Ende des aktuell gesprochenen Satzes.
- Zwei Timer konnten denselben längeren Antwortstrom nacheinander unterbrechen.
- Nach jeder Timer-Meldung blieb die normale Ausgabe pausiert; die Textgenerierung durfte weiterlaufen.
- Die Pause blieb auch während einer etwa 30 bis 40 Sekunden langen Nutzereingabe stabil.
- Zwei gleichzeitig gestellte Timer wurden während einer bereits bestehenden Pause jeweils genau einmal und ohne Audioüberlagerung gesprochen.
- `Ich bin wieder da` hob die Pause anschließend einmalig auf und setzte die normale Ausgabe fort.
- Ein Timer im Leerlauf hinterließ keine künstliche Pause; die nächste normale Anfrage wurde unmittelbar beantwortet.

## 9. Automatisierte Testmatrix

### TTS-Queue

- Timer wird erst nach dem aktuellen Satz gesprochen.
- Timer überholt normalen Queue-Eintrag.
- kritischer Eintrag überholt Timer.
- gleiche Priorität bleibt FIFO.
- niedriger Prebuffer bleibt erhalten und wird nach Resume verwendet.
- laufende Prebuffer-Synthese kann keinen Timer überholen.
- mehrere Timer werden vollständig gesprochen, bevor die Pause normale Ausgabe blockiert.
- normale Chunks dürfen während der Pause weiter gepuffert werden.
- `resume()` setzt genau einmal fort.
- `resume()` ohne Pause verändert nichts.
- Stop, Turn-Cancel, Rendererfehler und Playback-Timeout räumen den Pausenzustand korrekt auf.
- verspätete Synthese- und Playback-ACKs können keine alte Pause wiederbeleben.

### VoiceService

- Timer im Leerlauf spricht ohne anschließende Pause.
- Timer während normaler Sprachausgabe pausiert nach der Timer-Meldung.
- F9 in Timerpause erhält den Buffer bis zur ausgewerteten Eingabe.
- `wieder da` setzt fort, ohne neue TTS-Duplikate zu erzeugen.
- neue inhaltliche Eingabe verwirft den alten Buffer über das bestehende User-Barge-in.
- Voice-State zeigt während der stillen Pause nicht `speaking`.
- neue Timer dürfen während einer bestehenden Pause gesprochen werden.

### Router und Bus

- Timer-Notify bleibt als genau eine sichtbare Nachricht erhalten.
- dieselbe Meldung wird genau einmal gesprochen.
- sichtbare LLM-Chunks werden nicht ineinander verschachtelt.
- `wieder da` wird nur bei aktiver Timerpause lokal behandelt.
- Fortsetzung ruft weder Router- noch Worker-Modell auf.
- Shutdown verwirft späte Timer- und Resume-Ereignisse.

## 10. Praktische Windows-Abnahme

**Status:** Bestanden.

1. Sprachmodus starten.
2. Einen kurzen Timer stellen.
3. Eine Antwort mit mindestens zehn längeren Absätzen anfordern.
4. Prüfen, dass der aktuelle Satz beendet wird.
5. Prüfen, dass die Timer-Meldung genau einmal und ohne Audioüberlagerung kommt.
6. Mindestens zwei weitere Sätze Generierungszeit abwarten.
7. Prüfen, dass Sarah still pausiert und der Chattext weiter vollständig erscheinen darf.
8. Mit F9 `Bin wieder da.` sagen.
9. Prüfen, dass die Sprachausgabe ohne neuen Antwortanfang an der gepufferten Stelle fortgesetzt wird.
10. Einen Timer im Leerlauf ablaufen lassen und prüfen, dass danach keine künstliche Pause besteht.
11. Zwei nahe beieinander liegende Timer während einer Antwort prüfen.
12. Optional mit verkürztem Test-Idle prüfen, dass ein Worker-Restore den TTS-Buffer nicht berührt.

Durchgeführte Mehrfachvarianten:

- Zwei Timer unterbrachen denselben längeren Antwortstrom mit einer Fortsetzung zwischen den Meldungen.
- Zwei gleich lange Timer liefen während derselben Antwort ab; der zweite Timer durfte die bereits bestehende Pause passieren. Erst nach beiden Meldungen wurde mit `Ich bin wieder da` fortgesetzt.
- Der Leerlauffall wurde separat geprüft und erzeugte keinen zurückbleibenden Pausenzustand.

## 11. Aufwand nach Codeprüfung

Unter der beschriebenen Phase-1-Grenze:

- Abschnitt A: 35–50 Minuten,
- Abschnitt B: 30–45 Minuten,
- Abschnitt C: 25–40 Minuten,
- gezielte Integrationsprüfungen: 20–35 Minuten,
- Gesamtsuite und praktische Abnahme: 30–60 Minuten.

Realistischer Gesamtaufwand mit KI-Unterstützung: **etwa 2 bis 3 Stunden**, verteilt auf mehrere sichere Haltepunkte.

## 12. Fragen für den externen Review

Claude soll insbesondere prüfen:

1. Ist die Trennung zwischen sichtbarem seriellen Router-Output und priorisierter TTS-Ausgabe frei von Doppel-Ausgaben und Race Conditions?
2. Bleibt die Ownership von Turn, Output, Playback-ID und Timer-Notification eindeutig?
3. Kann der bestehende einzelne Prebuffer ohne Resynthese sicher hinter einem Timer gehalten werden?
4. Ist eine Pausenschranke nach Priorität robuster als ein separater zweiter Antwortbuffer?
5. Kann F9 während der Pause den STT-Turn starten, ohne durch `cancelActiveWork()` den alten Buffer zu löschen?
6. Reicht die lokale Erkennung der Wortfolge `wieder da`, oder entsteht eine Kollision mit normalen Eingaben?
7. Sind Stop, Shutdown, Renderer-Recovery, Timeout und verspätete ACKs vollständig abgedeckt?
8. Gibt es einen belegbaren Grund, den Modell-Idle-Timer doch an die TTS-Pause zu koppeln?
9. Führt die vorbereitete Prioritätsskala zu unnötiger Architektur, oder ist sie angesichts Timer, künftiger Wecker und kritischer Meldungen angemessen klein?
10. Fehlt ein praktisch relevanter Negativ- oder Nebenläufigkeitstest?

## 13. Timer V2 — Mini-Plan für einen separaten Folge-Branch

Timer V2 erweitert ausschließlich relative Timer. Der in diesem Dokument abgenommene Prioritäts- und Pausenvertrag bleibt unverändert.

### 13.1 Umfang

- relative Dauern in Sekunden, Minuten und Stunden,
- gemischte Dauern wie `5 Minuten 30 Sekunden` oder `1 Stunde 30 Minuten`,
- optionales kurzes Label wie `Brötchen`, `Eier` oder `Kassler`,
- Bestätigung und Ablaufmeldung mit Label, beispielsweise `Dein Brötchen-Timer ist abgelaufen`,
- gezielter Abbruch über eindeutiges Label oder eindeutige Dauer,
- Abbruch aller laufenden Timer,
- vollständige Rückwärtskompatibilität für unbenannte Minuten-Timer.

### 13.2 Sicherheits- und Mehrdeutigkeitsvertrag

- Dauer und Label werden strukturiert durch den Router übergeben und anschließend deterministisch validiert.
- Labels werden normalisiert, in der Länge begrenzt und ausschließlich als Daten behandelt.
- Bei keinem Treffer wird kein Timer verändert.
- Bei mehreren Treffern nach Label oder Dauer wird fail-closed nichts abgebrochen und eine eindeutige Auswahl verlangt.
- `alle Timer abbrechen` ist eine ausdrückliche eigene Aktion und darf nicht aus einer mehrdeutigen Einzelaussage abgeleitet werden.

### 13.3 Bewusste Abgrenzung

Absolute Uhrzeiten wie `Erinnere mich um 13:45 Uhr` oder regionale Formen wie `dreiviertel zwei` sind keine relativen Timer. Sie werden als persistenz- und zeitzonenrelevante Erinnerungsfunktion auf einen eigenen Feature-Branch verschoben. Eine spätere gemeinsame Scheduler-Basis ist möglich, darf die fachlichen Verträge von Timer und Erinnerung aber nicht vermischen.
