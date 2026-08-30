# Erinnerungen MVP — persistente lokale Zeitpunkte

**Stand:** Implementiert, automatisiert geprüft und praktisch unter Windows abgenommen

**Branch:** `feat/reminders`

**Ausgangsbasis:** `dev` nach Squash-Merge von Timer V2 (PR #33)

**Ziel:** Einmalige Erinnerungen mit Inhalt und lokalem Fälligkeitszeitpunkt persistent speichern, zuverlässig wieder laden und über die bewährte priorisierte Sprachausgabe melden

**Nicht enthalten:** Kalenderintegration, Wiederholungen, Sekunden-Erinnerungen, Hintergrundzustellung bei vollständig geschlossener Sarah

## 1. Zielbild

Sarah unterstützt einmalige Erinnerungen wie:

- „Erinnere mich in 30 Minuten daran, den Steuerberater anzurufen.“
- „Erinnere mich in anderthalb Stunden daran, loszufahren.“
- „Erinnere mich morgen um 11 Uhr an den Steuerberater.“
- „Erinnere mich Freitag um 10 Uhr an den Wochenabschluss mit Manuel.“
- „Erinnere mich am 17. März um 9 Uhr an …“
- „Welche Erinnerungen stehen heute an?“
- „Brich die Erinnerung an den Steuerberater ab.“

Eine Erinnerung besteht immer aus:

1. einem konkreten Inhalt,
2. einem konkreten lokalen Datum,
3. einer konkreten lokalen Uhrzeit.

Relative Angaben werden beim Erstellen sofort in einen konkreten lokalen Zeitpunkt umgerechnet. Danach ist die Erinnerung kein laufender Countdown, sondern ein persistenter Datensatz.

## 2. Bewusst getrennte Fachbereiche

### 2.1 Timer

- relativ und kurzlebig,
- Sekunden, Minuten und Stunden,
- nur während der laufenden Sarah-Instanz vorhanden,
- weiterhin in `SystemActions`,
- unveränderte Maximaldauer und Timer-Abbruchlogik.

### 2.2 Erinnerungen

- persistent,
- mindestens minutengenau,
- relativer oder absoluter Startwunsch,
- fachlich eigener `ReminderService` und `ReminderStore`,
- Wiederherstellung nach Neustart,
- Auflisten und eindeutiger Abbruch.

### 2.3 Späterer Kalender

- bleibt außerhalb dieses MVP,
- darf später Erinnerungen und Kalendertermine in einer gemeinsamen Agenda chronologisch zusammenführen,
- erfordert jetzt weder Kalenderfelder noch Synchronisationslogik.

Damit wird der praktisch abgenommene Timer nicht zu einem halben Kalender umgebaut.

## 3. Fachlicher MVP-Vertrag

### 3.1 Unterstützte Zeitangaben

Relative Angaben:

- Minuten und Stunden,
- gemischte Dauern wie `1 Stunde 30 Minuten`,
- Tage und Wochen für Formulierungen wie `in zwei Tagen` oder `in einer Woche`,
- umgangssprachliche Werte wie `anderthalb Stunden`, sofern der Router sie eindeutig normalisieren kann.

Absolute lokale Angaben:

- heute, morgen und übermorgen plus Uhrzeit,
- Wochentag plus Uhrzeit,
- Datum plus Uhrzeit,
- Datum ohne Jahr: nächster zukünftiger Kalendertag dieses Monats/Tags,
- reine Uhrzeit ohne Datum: heute, wenn sie noch bevorsteht, sonst morgen.

Regeln:

- Sekunden werden bei Erinnerungen nicht still gerundet. Sarah verweist auf einen Timer oder bittet um eine minutengenaue Angabe.
- Ein ausdrücklich genannter vergangener Zeitpunkt wird nicht gespeichert.
- „Heute um 10 Uhr“ um 11 Uhr wird nicht automatisch zu morgen.
- Ein Datum ohne Uhrzeit oder ein Inhalt ohne Zeitpunkt wird nicht gespeichert.
- Unvollständige Wünsche führen zu einer ehrlichen Bitte, den vollständigen Erinnerungswunsch mit Inhalt und Uhrzeit zu wiederholen. Ein mehrstufiger Reminder-Entwurf ist nicht Teil des MVP.

### 3.2 Lokale Zeit als Wahrheit

- Sarah verwendet Datum, Uhrzeit und Zeitzone des Betriebssystems.
- Es wird keine eigene Sommer-/Winterzeitlogik entwickelt.
- Gespeichert wird der lokale Zielzeitpunkt kanonisch als `YYYY-MM-DDTHH:mm`.
- Bei Start, Resume und Neuplanung wird dieser lokale Wert erneut mit der dann gültigen Systemzeit verglichen.
- Eine manuelle Zeitzonenänderung verschiebt damit die Erinnerung nicht auf eine vermeintlich ursprüngliche Ortszeit; maßgeblich bleibt die gespeicherte lokale Uhrzeit.

### 3.3 Überfällige Erinnerungen

Bestätigter MVP-Default:

- War Sarah zur Fälligkeit geschlossen oder im Standby, wird die offene Erinnerung beim nächsten Start beziehungsweise Resume nachgeholt.
- Mehrere überfällige Erinnerungen werden chronologisch ausgegeben.
- Es wird nichts still verworfen oder automatisch als erledigt markiert.
- Die Ansage unterscheidet den Fall, zum Beispiel: `Überfällige Erinnerung: Steuerberater anrufen.`

Dieser Default wurde bestätigt und umgesetzt. Ein großer Altbestand kann beim Start entsprechend mehrere chronologisch sortierte Ansagen auslösen.

### 3.4 Benachrichtigung und Gesprächspause

Eine fällige Erinnerung verwendet denselben Produktvertrag wie der Timer:

- laufenden Satz vollständig beenden,
- Erinnerung genau einmal in die priorisierte Ausgabekette geben,
- normale Ausgabe danach pausiert lassen,
- weitere fällige Timer oder Erinnerungen dürfen die Pause passieren,
- bestehendes Resume über „Ich bin wieder da“ bleibt zuständig.

Beispiel:

```text
Erinnerung: Steuerberater anrufen.
```

Die TTS-/Satzgrenzenlogik selbst wird nicht umgebaut.

### 3.5 Auflisten

Der MVP unterstützt mindestens:

- heutige offene Erinnerungen,
- alle kommenden offenen Erinnerungen.

Die Ausgabe ist chronologisch sortiert. Intern liefert der Reminder-Bereich neutrale Einträge:

```ts
interface ReminderAgendaItem {
  kind: 'reminder';
  id: number;
  dueLocal: string;
  text: string;
}
```

Eine spätere Agenda kann solche Einträge mit Kalenderquellen zusammenführen. Ein allgemeiner `AgendaService` wird erst eingeführt, wenn tatsächlich eine zweite Quelle existiert.

### 3.6 Abbrechen

- Abbruch nach eindeutigem Inhalt, Zeitpunkt oder einer Kombination daraus.
- Kein Treffer verändert nichts.
- Mehrere Treffer verändern nichts und erzeugen eine Rückfrage beziehungsweise eine eindeutige Liste der Kandidaten.
- Zwei identische Erinnerungen bleiben durch stabile IDs unterscheidbar.
- `alle Erinnerungen abbrechen` ist nur bei ausdrücklicher Formulierung zulässig.
- Abgebrochene Datensätze werden auf `cancelled` gesetzt und nicht physisch gelöscht.
- Ändern/Verschieben ist zunächst „abbrechen und neu erstellen“.

## 4. Technische Architektur

### 4.1 Reminder-Vertrag und Router-Wire-Format

Ein gemeinsamer `reminder-contract.ts` definiert Parser, kanonische Serialisierung und Domain-Typen. Wie bei Timer V2 geben die Zod-Schemas weiterhin Strings zurück, damit der generische Router niemals `[object Object]` dispatcht.

Vorgesehenes Format:

```text
[ACTION:set_reminder:after=30m|text=Steuerberater anrufen]
[ACTION:set_reminder:after=1h30m|text=Losfahren]
[ACTION:set_reminder:at=tomorrow@11:00|text=Steuerberater anrufen]
[ACTION:set_reminder:at=weekday:fri@10:00|text=Wochenabschluss mit Manuel]
[ACTION:set_reminder:at=month-day:03-17@09:00|text=...]
[ACTION:set_reminder:at=date:2027-03-17@09:00|text=...]
[ACTION:list_reminders:today]
[ACTION:list_reminders:upcoming]
[ACTION:cancel_reminder:text=Steuerberater anrufen]
[ACTION:cancel_reminder:at=tomorrow@11:00|text=Steuerberater anrufen]
[ACTION:cancel_reminder:all]
```

Zulässige relative Einheiten sind `m`, `h`, `d` und `w`. Freie natürliche Sprache gelangt nie in die Zeit-Domain.

Der Router erhält für jeden Routing-Aufruf einen injizierten, testbaren lokalen Clock-Kontext mit:

- aktuellem lokalen Datum,
- aktueller lokaler Uhrzeit,
- aktuellem Wochentag.

Symbolische Angaben wie `tomorrow` oder `weekday:fri` werden erst im Reminder-Vertrag deterministisch gegen diese Uhr aufgelöst. Der Router muss keine Datumsarithmetik erfinden.

### 4.2 Inhaltsvalidierung und Grounding

Der Erinnerungstext:

- ist Pflicht,
- wird mit NFKC normalisiert,
- erhält bereinigte Leerzeichen,
- ist auf eine kleine fachlich ausreichende Länge begrenzt,
- darf keine Steuerzeichen oder Wire-Trenner `|` und `]` enthalten,
- muss als zusammenhängender Inhalt aus der aktuellen Nutzeräußerung stammen,
- darf vom Router nicht ergänzt oder in eine neue Anweisung umgeschrieben werden.

Ein eigener Grounding-Check prüft Zeitindizien und Inhalt vor dem Action-Dispatch. Nicht belegte oder unvollständige Werte werden fail-closed abgelehnt.

### 4.3 Persistenz

Neue SQLite-Schema-Version 2 mit einer eigenen Tabelle `reminders`:

```text
id
due_local
text
state              pending | firing | delivered | cancelled
source_kind        zunächst local
external_id        optional, zunächst leer
created_at
firing_at
delivered_at
cancelled_at
```

- `ReminderStore` verwendet ausschließlich die vorhandene `appContext.db`/`StorageProvider`-Naht.
- Es gibt keine eigene Datenbank und keine eigene Schlüsselverwaltung.
- `text`, `due_local` und `external_id` bleiben durch `EncryptedStorage` zeilen- und spaltengebunden verschlüsselt.
- Nur strukturelle Felder wie ID, Status, Herkunft und technische Zeitstempel bleiben filterbar.
- Der Store lädt `pending`-Datensätze und filtert/sortiert die erwartbar kleine Menge im Reminder-Bereich; die generische Storage-Schnittstelle wird dafür nicht vorschnell um Range-Abfragen erweitert.
- Bei einem Bootstrap-Fallback auf eine flüchtige In-Memory-Datenbank darf Sarah keine dauerhafte Erinnerung bestätigen. Der Persistenzzustand muss dafür explizit an den Reminder-Bereich weitergegeben werden.

### 4.4 ReminderService und Scheduler

Ein eigener `ReminderService` implementiert den Sarah-Service-Lifecycle:

- `init`: offene Zustände wiederherstellen und Fälligkeiten abgleichen,
- `create`: validierten lokalen Zielzeitpunkt persistent speichern,
- `list`: offene Einträge chronologisch liefern,
- `cancel`: genau einen beziehungsweise ausdrücklich alle passenden Einträge auf `cancelled` setzen,
- `reconcile`: überfällige Einträge zustellen und den nächsten heutigen Termin scharf stellen,
- `destroy`: Handles und Listener entfernen, persistente Einträge aber erhalten.

Scheduler-Regeln:

- Nur heutige offene Erinnerungen werden aktiv scharf gestellt; spätere bleiben in der Datenbank.
- Es wird jeweils die nächste Fälligkeit geplant, nicht für jede Erinnerung eine dauerhafte Schleife erzeugt.
- Spätestens alle 60 Sekunden wird die Wall-Clock erneut verglichen. Das deckt Uhrsprünge ab, ohne Sekunden herunterzuzählen.
- Nach Fälligkeit, neuer Erinnerung, Abbruch, Mitternacht und Windows-Resume läuft ein zentraler Reconcile.
- Reconcile-Aufrufe werden serialisiert und mit einer Generation geschützt, damit parallele Timeouts, Resume und Cancel keine Doppelzustellung erzeugen.
- `powerMonitor`-Resume wird in `main.ts` registriert und beim Shutdown sauber entfernt.
- Der Service wird erst gestartet, wenn Router und Voice die Benachrichtigung empfangen können; beim Shutdown wird er vor Datenbank und Voice gestoppt.

### 4.5 Zustellzustand

Die Zustellung verwendet:

```text
pending -> firing -> delivered
```

- Vor dem Dispatch wird atomar von `pending` auf `firing` gewechselt.
- Nach angenommenem Benachrichtigungs-Dispatch wird `delivered` gespeichert.
- Ein beim Start gefundenes `firing` wird auf `pending` zurückgesetzt und erneut verarbeitet.
- Das bevorzugt eine seltene Doppelmeldung nach einem Absturz gegenüber einem stillen Verlust.

Eine akustisch exakt-einmalige Garantie über Datenbank, Router, TTS und tatsächliche Audio-Wiedergabe ist ohne dauerhafte Zustellbestätigung nicht möglich. Der MVP garantiert deshalb De-Duplizierung im laufenden Prozess und dokumentiert das kleine Crashfenster ausdrücklich.

### 4.6 Benachrichtigungsnaht

Der bestehende Notify-Pfad wird minimal typisiert:

```ts
{
  notificationId: string;
  kind: 'timer' | 'reminder';
  speak: string;
}
```

- Timer sendet weiterhin `kind: 'timer'`.
- Reminder sendet `kind: 'reminder'`.
- Der Router führt beide im MVP auf dieselbe bewährte Voice-Priorität und `pauseAfter: true`.
- Die Voice-Schicht und ihre Prioritätswerte bleiben unverändert.
- Weitere zeitkritische Benachrichtigungsarten können später über einen neuen `kind` ergänzt werden, ohne Timer oder Reminder fachlich umzubauen.

## 5. Fehler- und Sicherheitsregeln

- Keine Erfolgsmeldung, bevor der Datensatz persistent geschrieben wurde.
- Keine Speicherung, wenn nur flüchtiger Fallback-Speicher verfügbar ist.
- Reminder-Inhalte werden nicht in Logs ausgegeben.
- Gespeicherter Inhalt wird bei der Ausgabe ausschließlich als Text behandelt, niemals als Prompt oder Action.
- Ungültige Daten, unbekannte Selector-Formate und Mehrdeutigkeit verändern nichts.
- Store-/Entschlüsselungsfehler werden ehrlich als nicht verfügbare Reminder-Funktion gemeldet.
- Manipulierte verschlüsselte Zellen folgen dem bestehenden Quarantäne-/Integritätsvertrag.
- Ein Cancel/Fälligkeits-Rennen entscheidet atomar über den Status; kein Eintrag wird zweimal aktiv verarbeitet.
- Ein aktives Limit für offene Erinnerungen schützt vor unbegrenzter lokaler Belegung; der genaue, kleine Grenzwert wird beim Domain-Gate festgelegt und getestet.

## 6. Umsetzung in Gates

### Gate A — Vertrag festziehen (abgeschlossen)

1. Die zwei Produktdefaults aus Abschnitt 9 bestätigen.
2. `reminder-contract.ts` mit Set-/List-/Cancel-Typen, Parser und Serializer ergänzen.
3. Zeitauflösung gegen eine injizierbare lokale Uhr implementieren.
4. Inhaltsnormalisierung und Grounding definieren.

**Haltepunkt:** Alle gültigen und ungültigen Wire-Formate sind per Unit-Test festgelegt; noch keine Datenbank- oder Voice-Änderung.

### Gate B — Persistenz (abgeschlossen)

1. SQLite-Migration v1 -> v2 ergänzen.
2. `ReminderStore` über `StorageProvider` implementieren.
3. Reminder-Inhalt und lokales Fälligkeitsfeld durch `EncryptedStorage` schützen.
4. Persistenten gegenüber flüchtigem DB-Betrieb eindeutig kenntlich machen.

**Haltepunkt:** Neuerstellung, Migration, Verschlüsselung, Statuswechsel und Wiederherstellung sind mit temporärer echter SQLite-Datenbank geprüft.

### Gate C — ReminderService und Lifecycle (abgeschlossen)

1. Create/List/Cancel implementieren.
2. Serialisierten Scheduler und Wall-Clock-Reconcile implementieren.
3. Startup-, Mitternachts- und Resume-Verhalten anbinden.
4. Shutdown-Cleanup ohne Löschen offener Erinnerungen ergänzen.

**Haltepunkt:** Fake-Clock-Tests beweisen Fälligkeit, Neustart, Resume, Uhrsprünge, Reihenfolge und De-Duplizierung.

### Gate D — Action- und Router-Pipeline (abgeschlossen)

1. `set_reminder`, `list_reminders` und `cancel_reminder` in Schema, Policy, Feedback und `ActionService` ergänzen.
2. Den Routing-Prompt pro Anfrage mit lokalem Clock-Kontext bauen.
3. Reminder-Beispiele und die Abgrenzung zu Sekunden-Timern ergänzen.
4. Zweite Validierung und Grounding vor der Domain-Ausführung erzwingen.
5. Unvollständige Wünsche ohne Schein-Erfolg an den Antwortpfad geben.

**Haltepunkt:** Keine freie Modellantwort kann eine Reminder-Aktion ausführen; kein Objekt wird als String dispatcht; erfundener Inhalt oder Zeitpunkt wird abgelehnt.

### Gate E — Priorisierte Meldung (abgeschlossen)

1. Notify-Payload um `kind` typisieren.
2. Timer-Emission mit `kind: 'timer'` regressionssicher aktualisieren.
3. Reminder-Emission mit `kind: 'reminder'` anbinden.
4. Beide Arten auf dieselbe abgenommene Satzgrenzen-/Pause-/Resume-Kette führen.

**Haltepunkt:** Timer-Verhalten ist unverändert und mehrere Timer/Reminder können dieselbe Pause seriell passieren.

### Gate F — Gesamtprüfung und praktische Abnahme (abgeschlossen)

1. Zieltests aus Abschnitt 7 ausführen.
2. Main- und Renderer-Typecheck ausführen.
3. Vollständige Vitest-Suite ausführen.
4. Produktionsbuild und `git diff --check` ausführen.
5. Sarah neu starten und die Windows-Matrix aus Abschnitt 8 praktisch durchführen.

**Haltepunkt:** Erst nach technischer Prüfung und praktischer Windows-Abnahme gilt der Reminder-MVP als implementiert.

## 7. Automatisierte Testmatrix

### Vertrag und Zeitauflösung

- Minuten, Stunden, gemischte Dauern, Tage und Wochen.
- `anderthalb Stunden` wird kanonisch `1h30m`.
- Sekunden, Null, negative Werte, Überlauf und unbekannte Einheiten werden abgelehnt.
- Heute, morgen, übermorgen, Wochentag, Datum mit und ohne Jahr.
- Uhrzeit ohne Datum: noch bevorstehend heute, sonst morgen.
- Explizit vergangenes `heute` und vergangenes Datum werden abgelehnt.
- Mitternacht, Monats-/Jahreswechsel und Schaltjahr.
- Datum oder Inhalt ohne Uhrzeit führt nie zu einer Action.
- Inhaltsgrenzen, Unicode, Steuerzeichen und Delimiter.
- Router-Erfindungen bei Zeit und Inhalt werden vom Grounding abgelehnt.

### Storage und Verschlüsselung

- frische Schema-v2-Datenbank,
- Migration v1 -> v2 ohne Verlust bestehender Tabellen,
- Rollback bei Migrationsfehler,
- Ablehnung einer neueren unbekannten Schema-Version,
- Remindertext und `due_local` sind in der rohen SQLite-Datenbank nicht lesbar,
- AAD-Manipulation führt zum bestehenden Integritäts-/Quarantäneverhalten,
- `pending`, `firing`, `delivered` und `cancelled` werden korrekt gefiltert,
- flüchtiger Fallback-Speicher verweigert persistente Erstellung.

### Scheduler

- zukünftige Erinnerung heute wird einmal ausgelöst,
- morgige Erinnerung wird erst beim Tageswechsel scharf,
- überfällige Erinnerung wird bei Start nachgeholt,
- mehrere überfällige Erinnerungen sind chronologisch,
- zwei Erinnerungen zur selben Minute werden beide einmal dispatcht,
- Restart rekonstruiert offene Einträge,
- Resume über die Fälligkeit löst sofort aus,
- Uhr vor: überfällig und auslösen; Uhr zurück: neu armieren,
- paralleler Timeout/Resume/Reconcile erzeugt keine Doppelzustellung,
- Cancel vor Fälligkeit verhindert späte Callback-Ausgabe,
- `firing` wird nach Crash wiederhergestellt,
- Destroy entfernt Timer und Resume-Listener, erhält aber DB-Daten.

### Action-, Router- und Notify-Pipeline

- alle drei Reminder-Actions durchlaufen Parser, Schema, Router und ActionService korreliert,
- `[object Object]`-Regression ist ausgeschlossen,
- neutrale Bestätigung behauptet noch keine erfolgreiche Speicherung,
- Domain-Ergebnis nennt Inhalt und konkreten Zeitpunkt,
- kein/ein/mehrere Cancel-Treffer verhalten sich fail-closed,
- `all` entsteht nur aus ausdrücklichem Nutzerwunsch,
- Listen sind chronologisch und als `kind: reminder` verfügbar,
- Timer-Notify bleibt unverändert grün,
- Reminder während langer Antwort beendet erst den Satz, pausiert danach und lässt weitere priorisierte Meldungen passieren.

## 8. Praktische Windows-Abnahme

1. Erinnerung in zwei Minuten erstellen; Sarah vorher neu starten; Erinnerung muss nach Neustart zur richtigen lokalen Zeit kommen.
2. Erinnerung für heute einige Minuten später erstellen und parallel eine längere Fahrrad-/Computerantwort starten.
3. Prüfen: Satz endet, `Erinnerung: …` kommt einmal, normale Antwort pausiert, „Ich bin wieder da“ setzt sie fort.
4. Zwei Erinnerungen auf dieselbe beziehungsweise aufeinanderfolgende Minuten setzen; beide müssen die Pause passieren.
5. Sarah vor Fälligkeit beenden und erst danach starten; überfällige Meldung prüfen.
6. Rechner vor Fälligkeit in Standby schicken und danach fortsetzen; Resume-Nachholung prüfen.
7. Heutige und kommende Erinnerungen auflisten; Reihenfolge und gesprochene Inhalte prüfen.
8. Eindeutige Erinnerung abbrechen; sie darf später nicht erscheinen.
9. Zwei gleich benannte Erinnerungen anlegen; mehrdeutiger Abbruch darf keine davon verändern.
10. `alle Erinnerungen abbrechen` ausdrücklich testen.
11. Sekunden-Erinnerung und unvollständiges Datum testen; Sarah darf nichts still falsch speichern.
12. Bestehende Timer-Kurzmatrix erneut ausführen, insbesondere Sekunden, Labels, Mehrfachablauf und Abbruch.

## 9. Bestätigte Produktdefaults

Für den MVP wurden zwei sichtbare Defaults bestätigt und implementiert:

1. **Reine Uhrzeit liegt schon zurück:** `Erinnere mich um 10 Uhr …` bedeutet nach 10 Uhr den nächsten Tag. Ein ausdrücklich genanntes vergangenes `heute` bleibt dagegen ein Fehler.
2. **Sarah war aus:** Jede noch offene überfällige Erinnerung wird beim nächsten Start nachgeholt und nicht still verworfen.

Alle weiteren Unsicherheiten werden fail-closed behandelt.

## 10. Abschluss und Abnahme

Automatisiert geprüft:

- Main- und Renderer-Typecheck erfolgreich,
- Produktionsbuild erfolgreich,
- vollständige Vitest-Suite mit 112 Dateien und 1.557 Tests erfolgreich,
- `git diff --check` ohne Fehler.

Praktisch unter Windows bestätigt:

- Erstellung relativer Erinnerungen und Zustellung zur Fälligkeit,
- Persistenz über Neustarts und Nachholung überfälliger Erinnerungen,
- priorisierte Ausgabe während längerer Antworten mit anschließender Pause,
- mehrere aufeinanderfolgende Erinnerungen,
- heutige, aktive und alle offenen Erinnerungen auflisten,
- eindeutige, mehrdeutige und vollständige Abbrüche,
- Auswahl eines mehrdeutigen Treffers über Uhrzeit oder Listennummer,
- kurze Kommandos für Timer und Erinnerungen.

Bewusst getrennte Nacharbeiten:

- Command- und Antwortformulierungen sowie TTS-Verständlichkeit werden separat gepflegt,
- die irreführende STT-Meldung nach einer leeren F9-Aufnahme ist ein eigener Usability-Befund,
- Zustellung bei vollständig geschlossener Sarah bleibt außerhalb des MVP.

## 11. Bewusst später

- Kalender lesen oder schreiben,
- gemeinsame Agenda aus mehreren Quellen,
- wiederkehrende Erinnerungen,
- Erinnerungen ändern/verschieben,
- natürliche mehrstufige Reminder-Entwürfe,
- Zustellung bei vollständig geschlossener Sarah über Windows-Dienst, Task Scheduler oder Systembenachrichtigung,
- Smartphone-, E-Mail-, WhatsApp- oder Anrufintegration,
- eigene Zeitzonenverwaltung,
- Refaktor des praktisch abgenommenen Timer-Schedulers in eine gemeinsame abstrakte Engine.
