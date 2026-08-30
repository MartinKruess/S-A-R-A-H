# Layer 3 — Intelligence, Decisions und Planning: Auditserie

**Stand:** Auditserie einschließlich unabhängiger Layer-3→2-/Layer-3→1-Läufe und separater Timer-/Reminder-Vertikalprüfung abgeschlossen; Abbruchschwelle erreicht

**Branch:** `fix/layer3-audit-1`

**Ausgangsbasis:** `dev` nach Timer V2, Erinnerungs-MVP und aktualisierter 704er-Checkliste

**Abbruchregel:** Weitere Durchläufe enden, sobald ein Audit weniger als fünf neue relevante Befunde liefert. Bereits bekannte oder doppelte Ursachen werden nicht erneut gezählt.

## 1. Scope und Reihenfolge

1. Audit 1 prüft Layer 3 isoliert: Routing, Intent, Direktentscheidungen, Rückfragen, Modelloutput und Ausführungsentscheidung.
2. Audit 2 prüft Layer 3 → 2: Kontext, Memory, Nutzerregeln, Datenschutz, Berechtigungen und konfigurierbare Commands.
3. Audit 3 prüft Layer 3 → 2 unabhängig und adversarial.
4. Audit 4 prüft Layer 3 → 1 auf Turn-, Abbruch-, Bestätigungs- und Ergebnisverträge.
5. Danach folgen separate Vertikalaudits für Timer, Erinnerungen und die unmittelbar vorherigen Änderungen.

Layer 0 wird nur entlang eines konkret belegten Fehlerpfads einbezogen. Der fehlende vollständige Planner-/Evaluator-Kreislauf wird nicht während eines Audits improvisiert eingebaut.

## 2. Audit 1 — Layer 3 isoliert

### Ergebnis

Sieben relevante Befundkomplexe. Die Abbruchschwelle ist nicht erreicht.

### L3-A01 — P1 — Timerwerte und destruktive Selektoren waren nicht vollständig gegroundet

**Bestätigt. Direkt behoben.**

- Reminder prüfen Zeit, Inhalt und destruktive Selektoren gegen die aktuelle Nutzeräußerung.
- Timer prüften bisher nur, ob ein vorgeschlagenes Label im Satz vorkam.
- Eine formal gültige, aber falsch normalisierte Dauer konnte dadurch ausgeführt werden.
- Ein Modelloutput `cancel_timer:all` wurde strukturell akzeptiert, auch wenn der Nutzer nur einen benannten Timer abbrechen wollte.

Korrektur:

- Neue Timer-Grounding-Grenze für Sekunden, Minuten, Stunden, gemischte Werte, Dezimalwerte und gebräuchliche deutsche Bruchformen.
- `all`, Label und Dauer werden bei Abbruch fail-closed gegen den wirksamen Auftrag geprüft.
- Ungroundete Labels werden weiterhin entfernt, ohne einen ansonsten korrekt belegten Timer zu verhindern.

### L3-A02 — P1 — Nicht alle Action-Parameter besitzen eine Herkunftsprüfung

**Bestätigt. Architekturpunkt offen.**

- Timer und Reminder besitzen jetzt fachliche Grounding-Grenzen.
- `open_program`, `web_search`, Medienziel und Lautstärkewert verlassen sich nach der Schema-Prüfung weiterhin auf den Modelloutput.
- Ein Schema beweist Typ und Grenzen, aber nicht, dass Programm, Query, Ziel oder Wert aus dem Nutzerauftrag stammen.

Eine gemeinsame Herkunftsprüfung muss pro Action fachlich definiert werden. Ein pauschaler Textvergleich würde legitime Alias- und Normalisierungsfälle beschädigen.

### L3-A03 — P1 — Zusammengesetzte Anliegen können durch Direktpfade teilweise verschluckt werden

**Bestätigt. Erster sicherer Teil behoben.**

- Profilfragen, sichtbare Browser-Follow-ups, MediaContext und einzelne lokale Shortcuts laufen vor dem Modellrouter.
- Bei Sätzen wie „Wie heiße ich und öffne Spotify?“ durfte die Profilantwort bisher den zweiten Auftrag vollständig verdrängen.
- Die Profilauflösung greift jetzt nicht mehr bei erkennbaren zusätzlichen Satzteilen.

Browser-, Medien- und weitere zusammengesetzte Anliegen benötigen später einen gemeinsamen Multi-Intent-Vertrag statt einzelner lokaler Sonderregeln.

### L3-A04 — P1 — Es gibt noch keinen ausführbaren Planner-/Evaluator-Kreislauf

**Bestätigter Architekturstand, nicht kurzfristig behoben.**

- Komplexe Aufgaben werden an den Worker weitergegeben.
- Es existieren keine persistierten Planschritte, Abhängigkeiten, Prüfkriterien oder geregelte Re-Planung.
- Toolergebnisse werden gesprochen, aber nicht allgemein gegen das ursprüngliche Ziel bewertet.

Das ist die zentrale geplante Layer-3-Lücke und kein kleiner Auditfix.

### L3-A05 — P2 — Identische Bestätigungsanfragen konnten am alten Vorschlags-Turn hängen bleiben

**Bestätigt. Direkt behoben.**

- Der Confirmation-Gate verwendete bei identischer Action und identischem Parameter dieselbe ID auch für einen neuen Turn.
- Dadurch konnte die sichtbare neue Anfrage intern weiter den alten `requestedTurnId` tragen.
- Wiederholung innerhalb desselben Turns bleibt idempotent; ein neuer Turn ersetzt den alten Vorschlag jetzt mit einer neuen ID und korrekter Provenienz.

### L3-A06 — P2 — Deklarierte Routen und tatsächliche Ausführung stimmen nicht vollständig überein

**Bestätigt. Offen dokumentiert.**

- Der Parser kennt `backend`, `extern` und `vision`.
- `RouterService` veröffentlicht teilweise ein entsprechendes Routing-Ereignis, führt diese Ziele derzeit jedoch trotzdem über den lokalen Worker aus.
- Der aktuelle Prompt erzeugt diese Routen nicht produktiv; deshalb ist dies noch kein aktiver Fehl-Dispatch, aber ein irreführender Zukunftsvertrag.

Vor Aktivierung eines solchen Ziels braucht jede Route einen echten Executor oder muss ausdrücklich als nicht verfügbar abgewiesen werden.

### L3-A07 — P2 — Der Warm-Worker-Heuristikpfad ist eine zweite manuelle Intent-Liste

**Bestätigt. Offen dokumentiert.**

- `ACTION_HINT_STEMS` entscheidet bei warmem Worker, ob zurück zum Router gewechselt wird.
- Die Liste ist unabhängig von Action-Schema und Routing-Prompt gepflegt.
- Neue Actions oder natürliche Formulierungen können deshalb je nach aktivem Modell unterschiedlich behandelt werden.

Die Heuristik darf weiter nur Mehrkosten verursachen und niemals selbst ausführen. Mittelfristig braucht sie einen testbaren Capability-Vertrag oder einen konservativen Router-Fallback.

## 3. Audit 2 — Layer 3 → 2

### Ergebnis

Sechs relevante Befundkomplexe. Die Abbruchschwelle ist nicht erreicht.

### L3-B01 — P1 — Layer-2-Kontext beeinflusst die Routerentscheidung nicht allgemein

**Bestätigt. Architekturpunkt offen.**

- Kuratierte Erinnerungen und Live-History werden erst für den Worker-Kontext zusammengestellt.
- Der kleine Router erhält nur Systemuhr und aktuelle wirksame Nutzeräußerung.
- Präferenzen oder bekannte Zuordnungen können daher keine allgemeine Action-Auswahl wie „öffne meinen Editor“ oder „nimm meinen üblichen Browser“ begründen.

Layer 3 benötigt später einen kleinen, expliziten und datensparsamen DecisionContext statt den vollständigen Worker-Prompt.

### L3-B02 — P1 — Router-Vorentscheidung und live durchgesetzte ActionPolicy waren nicht deckungsgleich

**Bestätigt. Aktueller Policy-Teil direkt behoben; dynamischer Capability-Teil offen.**

- Der Routing-Prompt listet Actions statisch.
- Deaktivierter Webzugriff wurde bisher erst im ActionService abgewiesen, nachdem der Router bereits „Ich suche …“ ausgegeben hatte.
- Der Router führt jetzt vor Ankündigung oder Bestätigungsdialog denselben aktuellen Policy-Entscheid aus; ActionService validiert weiterhin autoritativ ein zweites Mal.
- Dynamische Fähigkeiten, die über die aktuelle Trust-Konfiguration hinausgehen, sind im statischen Routing-Prompt weiterhin nicht abgebildet.

Ein späterer CapabilitySnapshot darf nur Verfügbarkeit und Policy-Effekt liefern; die Durchsetzung bleibt weiterhin im Action-Layer.

### L3-B03 — P1 — Custom-Command-Expansion und Grounding verwendeten verschiedene Quellen

**Bestätigt. Direkt behoben.**

- Der Router klassifiziert bei einem benutzerdefinierten Slash-Command den vertrauenswürdig gespeicherten Expansionstext.
- Timer-/Reminder-Grounding verglich das Ergebnis bislang mit dem ursprünglichen Slash-Command.
- Dadurch konnte eine korrekt konfigurierte Expansion an der Herkunftsprüfung scheitern.

Alle fachlichen Grounding- und Misrouting-Korrekturen verwenden jetzt konsistent `effectiveText`. Die unveränderte Originaleingabe bleibt separat für Audit und Persistenz erhalten.

### L3-B04 — P2 — „Erinnerung“ bezeichnet zwei verschiedene persistente Domänen

**Bestätigt. Produkt-/Intent-Vertrag offen.**

- Das kuratierte Langzeitgedächtnis verwendet in Commands und Antworten ebenfalls „Erinnerung“.
- Die neue zeitgesteuerte Reminder-Domain verwendet dasselbe Nutzerwort.
- Direktmuster für „Speichere als Erinnerung …“ laufen vor dem Modellrouter und können bei zeitbezogenen Formulierungen mit geplanten Erinnerungen kollidieren.

Die Domänen brauchen intern und in den Commands eindeutige Begriffe; die Nutzersprache darf danach weiterhin natürlich „Erinnerung“ verwenden.

### L3-B05 — P2 — Verwendung bestehenden Gedächtnisses im Anonymous-Modus ist nicht separat steuerbar

**Bestätigter bekannter Gap. Offen.**

- Anonymous verhindert Persistenz und verwirft privaten Verlauf.
- Bei global aktiviertem Gedächtnis kann die Worker-Kontextbildung weiterhin kuratierte Erinnerungen abrufen.
- Die Checkliste führt diese gewünschte Wahlmöglichkeit deshalb weiterhin gelb.

Eine Änderung braucht eine explizite Produktentscheidung und wird nicht als vermeintlicher Securityfix still deaktiviert.

### L3-B06 — P2 — Action-Requests verlieren die Herkunft aus einem Custom Command

**Bestätigt. Architekturpunkt offen.**

- `TurnEnvelope` unterscheidet Originaltext, wirksamen Expansionstext und Custom-Command-Herkunft korrekt.
- `action:request` transportiert danach jedoch nur Action, Parameter und Turn-Korrelation.
- ActionService und spätere Audit-/Policy-Entscheidungen können deshalb nicht mehr unterscheiden, ob die Action direkt gesprochen oder aus einem konfigurierten Makro abgeleitet wurde.

Vor benutzerspezifischen Command-Berechtigungen oder einem Planner braucht der Action-Vertrag eine kleine, nicht frei manipulierbare Provenienzangabe.

## 4. Direkt umgesetzte Änderungen nach Audit 1 und 2

- Timerdauer und Timer-Abbruchselektoren vollständig gegen den wirksamen Auftrag gegroundet.
- Destruktive Eskalation eines einzelnen Timerabbruchs zu `all` blockiert.
- Bestätigungsprovenienz bei identischer Anfrage in einem neuen Turn korrigiert.
- Deterministische Profilantwort verschluckt keine erkennbare zweite Absicht mehr.
- Grounding und Misrouting-Korrekturen für Custom Commands auf `effectiveText` vereinheitlicht.
- Live-ActionPolicy vor jeder Router-Ankündigung gespiegelt; ActionService bleibt die autoritative zweite Schranke.
- Unit- und Router-Regressionstests für die korrigierten Pfade ergänzt.

## 5. Bewusst nicht als Schnellfix umgesetzt

- allgemeiner Planner und Evaluator,
- Multi-Intent-Ausführung,
- allgemeine Parameter-Provenienz für jede Action,
- Backend-/Extern-/Vision-Executor,
- datensparsamer DecisionContext und CapabilitySnapshot,
- Action-Provenienz für konfigurierte Commands,
- Umbenennung oder Migration der beiden Erinnerungsdomänen,
- neue Anonymous-Memory-Produktregel,
- Policy-Versionierung für noch nicht vorhandene mehrschrittige Pläne.

Diese Punkte sind relevant, aber größer als ein sicherer lokaler Auditfix oder benötigen eine Produktentscheidung.

## 6. Technische Abschlussprüfung

- vereinigte fokussierte Timer-/Reminder-/Layer-Matrix: 346/346 Tests grün,
- vollständige Vitest-Suite: 113 Dateien, 1.595/1.595 Tests grün,
- Main- und Renderer-Typecheck grün,
- Produktionsbuild grün,
- `git diff --check` ohne Fehler,
- `better-sqlite3` nach den Node-Tests wieder auf Electron 41.1.1 hergestellt.

Eine praktische Windows-/Whisper-/Audio-Abnahme wurde in diesem Audit nicht durchgeführt. Die grünen Prüfungen sind technische Evidenz und ersetzen diese praktische Abnahme nicht.

## 7. Audit 3 — unabhängig Layer 3 → 2

### Ergebnis

Vier neue relevante Befundkomplexe. Damit liegt dieser Lauf unter fünf und erfüllt die Abbruchregel.

### L3-C01 — P1 — Dauer- und Zeitbelege wurden satzweit statt fachlich gruppiert

**Behoben.** Timer- und Reminderzeiten werden als zusammengehörige Gruppen beziehungsweise Zeitklauseln ausgewertet. Separate Angaben, Alternativen und Inhaltszeiten werden nicht mehr addiert oder als Ausführungszeit übernommen. Alternativen ausschließlich im Erinnerungstext bleiben zulässig.

### L3-C02 — P1 — Flüchtiger Entscheidungszustand überlebte Privacy-Grenzen

**Behoben.** Offene Action-Bestätigungen und Reminder-Auswahlkontext werden beim Wechsel des Anonymous-Zustands gelöscht. Ein späterer Turn kann keinen vor der Privacy-Grenze erzeugten Entscheidungszustand mehr verbrauchen.

### L3-C03 — P2 — Profil-Direktantwort erkannte zusätzliche Absichten nicht robust

**Behoben.** Weitere Konjunktionen, Satzzeichen und Zeilenumbrüche verhindern den deterministischen Profil-Shortcut. Zusammengesetzte Anliegen gehen wieder durch den normalen Router; ein vollständiger Multi-Intent-Planner bleibt separat offen.

### L3-C04 — P2 — Einzelne Folgeverträge verwendeten noch den Originaltext statt `effectiveText`

**Behoben.** Timer, Reminder, Reminder-Auswahl und Misrouting-Korrekturen verwenden konsistent die vertrauenswürdig expandierte Custom-Command-Eingabe. Originaltext und Expansion bleiben getrennt erhalten.

## 8. Audit 4 — unabhängig Layer 3 → 1

### Ergebnis

Vier neue relevante Befundkomplexe. Auch dieser Lauf liegt unter fünf.

### L3-D01 — P1 — Natürliche Bestätigung blieb nach einem fremden Turn verwendbar

**Behoben.** Eine natürliche Bestätigung ist nur der unmittelbaren offenen Aktion zugeordnet. Der erste nicht passende Turn lässt die natürliche Autorität verfallen; objektbezogene Befehle wie „Timer abbrechen“ werden nicht mehr als pauschales „Abbrechen“ verschluckt.

### L3-D02 — P1 — Reminder-Auswahlkontext überlebte den Abbruch seines Eigentümer-Turns

**Behoben.** Der Kontext trägt jetzt den Eigentümer-Turn und wird bei Cancel, Error, Privacy-Wechsel oder Ablauf verworfen.

### L3-D03 — P1 — Reminder-Operationen ignorierten Turn-Abbruch und Commit-Grenzen

**Behoben.** Create, List und Cancel erhalten das `AbortSignal`. Vor dem ersten Commit wird abgebrochen; ein bereits persistierter Erfolg wird nicht als normaler Fehler zurückgemeldet. Bei einem Fehler mitten in `cancel all` wird ein bereits erfolgter Teil-Commit ausdrücklich als partielles Ergebnis gemeldet.

### L3-D04 — P1 — Reminder galt vor Annahme der sichtbaren Ausgabe als zugestellt

**Behoben.** Router und ReminderService besitzen einen korrelierten Annahmevertrag. Deadline-Ausgaben umgehen blockierte normale Worker-Ausgaben, erzeugen sofort den sichtbaren Layer-1-Output und werden erst danach bestätigt. Ein nicht angenommener Output bleibt erneut zustellbar.

## 9. Separates Timer-Audit

### Ergebnis

Drei neue relevante Befunde; unter fünf.

### TIMER-A01 — P1 — Höher priorisierter Timer konnte hinter laufender TTS-Synthese warten

**Behoben.** Höher priorisierte Synthese unterbricht nun auch die Synthese des noch nicht abgespielten aktuellen Satzes, nicht nur das Prebuffering. Die unterbrochene normale Ausgabe bleibt geordnet erhalten.

### TIMER-A02 — P2 — Pausevertrag verlor später eintreffende Streaming-Chunks

**Behoben.** Ob eine Pause erforderlich ist, entscheidet VoiceService anhand der vollständigen Output-Lifecycle-Sicht. Hat es `pauseAfterPlayback` gesetzt, behält die TTS-Queue die Barriere auch dann, wenn der nächste normale Chunk erst nach dem Timer-ACK eintrifft.

### TIMER-A03 — P2 — Gebräuchliche Bruchformen waren nicht kombinierbar

**Behoben.** Halbe Stunde, Viertelstunde und Dreiviertelstunde sind echte Dauerteile und lassen sich sicher mit weiteren Minuten oder Sekunden kombinieren.

## 10. Separates Reminder-/Änderungen-von-gestern-Audit

### Ergebnis

Der erste Reminder-Lauf fand fünf und der ergänzende gestrige Diff-Lauf drei relevante Komplexe. Nach den Korrekturen lagen die unabhängigen Abschluss-Reaudits bei drei, drei und vier neuen Punkten und damit jeweils unter fünf.

### REM-A01 — P1 — Symbolische Zeit wurde nach Bestätigung erneut relativ aufgelöst

**Behoben.** Grounding konkretisiert die belegte Zeit vor dem Bestätigungsdialog zu einem lokalen Datum und einer Minute. Eine verzögerte Bestätigung verschiebt „in 30 Minuten“ oder „morgen“ nicht erneut.

### REM-A02 — P1 — Persistierter Erfolg konnte als Fehler erscheinen

**Behoben.** Ein erfolgreiches Insert wird bei anschließendem Readback- oder Reconcile-Fehler als committed behandelt. Regressionstests verhindern dadurch doppelte Erinnerungen nach einem Retry.

### REM-A03 — P1 — `cancel_reminder:all` hatte keinen parametergesteuerten Risikovertrag

**Behoben.** Nur der Selektor `all` wird unter Standard-Policy bestätigt; ein eindeutiger Einzelabbruch bleibt reversibel. Fehler nach dem ersten CAS liefern ein ehrliches partielles Ergebnis statt eines generischen Totalfehlers.

### REM-A04 — P1 — Lokale Fälligkeitszeit und DST-/Zeitzonenverhalten waren widersprüchlich

**Behoben gemäß bestehendem Produktvertrag.** Persistente Wahrheit bleibt `YYYY-MM-DDTHH:mm` in der jeweils aktuellen OS-Zeitzone. Wiederholte lokale Minuten werden bei der Laufzeitauflösung auch für nicht einstündige DST-Überlappungen erkannt; es wird kein dauerhaft ortsgebundener Epochwert eingeführt.

### REM-A05 — P1 — Ausgabeherkunft und Privatkontext gingen bei später Fertigstellung verloren

**Behoben.** Verspätete Reminder-Ergebnisse behalten Modus und Privatkontext. Öffentliche Timeralarme bleiben unabhängig vom Eingabemodus akustisch; private Timerlabels werden sichtbar, aber nicht laut ausgegeben.

### REM-A06 — P1 — Reminder-Inhalte konnten in Conversation-/Memory-Persistenz gelangen

**Behoben.** List- und Cancel-Ausgaben werden als lokale Daten transient gehalten und nicht in persistente Unterhaltung oder kuratiertes Gedächtnis übernommen.

### REM-A07 — P2 — Bestätigungs- und Reminder-Follow-up-Pfade waren zu breit

**Behoben.** Nur isolierte beziehungsweise deiktische Bestätigungsantworten bedienen den offenen Gate. Reminder-Auswahl akzeptiert nur korrelierte Nummern oder eindeutige Uhrzeiten und verfällt mit dem Eigentümer-Turn.

## 11. Abschluss-Reaudits und Abbruchentscheidung

- Timer/TTS-Reaudit: 3 neue Punkte,
- Reminder/Persistenz/Layer-1-Reaudit: 3 neue Punkte,
- Layer-3→2-/gestriger-Diff-Reaudit: 4 neue Punkte.

Alle drei unabhängigen Linien liegen unter fünf. Die neu gemeldeten Punkte wurden in den oben beschriebenen Verträgen berücksichtigt und technisch regressionsgetestet. Die Auditserie endet deshalb nach der festgelegten Abbruchregel.

Die bereits in Abschnitt 5 benannten Architekturthemen werden nicht als verdeckte Restfehler umgezählt. Insbesondere Planner/Evaluator, allgemeine Multi-Intent-Ausführung, allgemeine Action-Provenienz und ein datensparsamer DecisionContext bleiben eigene geplante Arbeiten.
