# Timer V2 — relative Dauern, Labels und gezielter Abbruch

**Stand:** Implementiert; automatisierte Prüfung und praktische Windows-Abnahme bestanden
**Ausgangsbranch:** `feat/timer-interruption`
**Ziel:** Kleine, rückwärtskompatible Erweiterung des bestehenden relativen Timers
**Nicht enthalten:** absolute Erinnerungen, Persistenz und Änderungen an der TTS-Pausenarchitektur

Technische Abschlussprüfung nach dem Action-Grounding-Fix:

- 108 Testdateien und 1444/1444 Tests grün,
- Main- und Renderer-Typecheck grün,
- Produktionsbuild grün,
- `git diff --check` grün.

## 1. Zielbild

Timer V2 erweitert den bereits praktisch abgenommenen Timer um:

- Sekunden, Minuten und Stunden,
- gemischte Dauern wie `5 Minuten 30 Sekunden` und `1 Stunde 30 Minuten`,
- optionale kurze Bezeichnungen wie `Brötchen`, `Eier` oder `Kassler`,
- Ablaufmeldungen wie `Dein Brötchen-Timer ist abgelaufen.`,
- Abbruch eines eindeutigen Timers nach Bezeichnung oder Dauer,
- ausdrücklichen Abbruch aller laufenden Timer.

Der bestehende Ablaufvertrag bleibt erhalten: Ein Timer darf eine normale Sprachausgabe erst an der Satzgrenze übernehmen, wird genau einmal gesprochen und lässt die normale Ausgabe pausiert, bis die bestehende Resume-Funktion ausgelöst wird.

## 2. Ausgangsarchitektur und geschützter Codevertrag

Dieser Abschnitt dokumentiert die vor Timer V2 vorhandenen Schnittstellen, gegen die die Erweiterung geplant wurde. Während der Planung lagen im gemeinsamen Working Tree bereits unfertige Änderungen; sie galten erst nach Abschluss aller Gates und der praktischen Abnahme als bestätigter Produktstand.

### 2.1 Router und Action-Format

- `src/services/llm/routing-prompt.ts` kennt bisher `[ACTION:set_timer:<minutes>]`.
- `src/services/llm/route-parser.ts` reicht den Inhalt nach dem Action-Namen als String weiter.
- `src/services/actions/action-schemas.ts` validiert `set_timer` als Ganzzahl von 1 bis 1440 und transformiert sie in eine Zahl.
- `src/services/llm/router-service.ts` serialisiert das validierte Ergebnis generisch mit `String(parsed.data)` für Bestätigung, Feedback und Dispatch.
- `src/services/actions/action-service.ts` validiert erneut und ruft `SystemActions.setTimer(number)` auf.

Folgerung: Ein Schema darf nicht unbemerkt ein Objekt zurückgeben, solange `RouterService` generisch `String(parsed.data)` verwendet. Sonst würde `[object Object]` weitergereicht. Timer V2 soll deshalb im Action-Kanal einen kanonischen String behalten; die Umwandlung in Domain-Daten erfolgt erst unmittelbar vor `SystemActions`.

### 2.2 Timer-Domain

- `src/services/actions/system-actions.ts` verwaltet maximal fünf Timer.
- `SystemActions.setTimer(number)` interpretiert die Zahl als Minuten.
- Jeder Timer speichert Startzeit und Timeout und prüft beim Aufwachen die vergangene Wall-Clock-Zeit erneut.
- `clearAllTimers()` wird für Shutdown und Cleanup verwendet.
- Der Ablauf geht über den bestehenden zentralen Notify-Handler in die bereits abgenommene Prioritäts-/TTS-Kette.

### 2.3 Geschützte bestehende Funktionen

Timer V2 darf folgende Bereiche nicht fachlich umbauen:

- `src/services/voice/tts-queue.ts`,
- `src/services/voice/voice-service.ts`,
- die Satzgrenzenerkennung,
- Prioritätsübernahme und Audio-Pause,
- `Ich bin wieder da`/Resume,
- die Hintergrundgenerierung während einer Timer-Pause,
- den Leerlauffall ohne künstlich zurückbleibende Pause.

Der bereits bestandene praktische Test ist in `docs/steps/timer-priority-interruption-plan.md` dokumentiert und dient als Regression-Baseline.

## 3. Fachlicher Scope

### 3.1 Timer stellen

Der Router übersetzt natürliche Sprache in ein kleines deterministisches Wire-Format:

```text
[ACTION:set_timer:30s]
[ACTION:set_timer:5m30s|Brötchen]
[ACTION:set_timer:1h30m|Kassler]
```

Zulässige Einheiten sind `h`, `m` und `s`. Die Reihenfolge ist Stunden, Minuten, Sekunden; jede Einheit kommt höchstens einmal vor. Der Gesamtwert muss mindestens eine Sekunde und höchstens 24 Stunden betragen.

Ein reiner Integer bleibt aus Rückwärtskompatibilität eine Minutenangabe:

```text
[ACTION:set_timer:5]
```

Das bedeutet weiterhin fünf Minuten und niemals fünf Sekunden.

Der Router übernimmt die sprachliche Interpretation, zum Beispiel:

- `30 Sekunden` → `30s`,
- `fünfeinhalb Minuten` → `5m30s`,
- `anderthalb Stunden` → `1h30m`,
- `eine Dreiviertelstunde` → `45m`.

Die produktive Timer-Domain interpretiert keine freie natürliche Sprache. Sie akzeptiert ausschließlich den validierten kompakten Vertrag.

### 3.2 Labels

Ein Label ist optional und wird mit `|` von der Dauer getrennt. Der Router extrahiert eine kurze semantische Bezeichnung aus dem Nutzerwunsch, ohne feste Lebensmittel- oder Objektliste. Bei `Timer für die Eier im Wasserkocher` ist beispielsweise `Eier` das bevorzugte Label.

Validierung und Normalisierung:

- Unicode-Normalisierung mit NFKC,
- führende und nachfolgende Leerzeichen entfernen,
- innere Leerraumfolgen zusammenfassen,
- Steuerzeichen und Wire-Trennzeichen wie `|` und `]` ablehnen,
- maximal 40 Zeichen,
- ohne `|` ist der Timer unbenannt; ein vorhandener Trenner mit leerem Label wird am Schema abgelehnt.

Für die Suche werden Labels ohne Beachtung der Groß-/Kleinschreibung verglichen. Für die Ausgabe bleibt die bereinigte ursprüngliche Schreibweise erhalten.

### 3.3 Timer abbrechen

Neue Action:

```text
[ACTION:cancel_timer:label=Eier]
[ACTION:cancel_timer:duration=30m]
[ACTION:cancel_timer:all]
```

Regeln:

- Ein eindeutiger Label-Treffer bricht genau diesen Timer ab.
- Ein eindeutiger Dauer-Treffer bricht genau diesen Timer ab.
- Kein Treffer verändert keinen Timer und erzeugt ehrliches Feedback.
- Mehrere Treffer verändern keinen Timer und erzeugen eine Rückfrage beziehungsweise eindeutiges Mehrdeutigkeitsfeedback.
- `all` ist nur bei einer ausdrücklichen Nutzerformulierung wie `alle Timer abbrechen` zulässig.
- Ein mehrdeutiger Einzelwunsch darf niemals zu `all` hochgestuft werden.

`cancel_timer` ist eine reversible Systemaktion mit derselben Timer-Berechtigung wie `set_timer`. Shutdown-Cleanup über `clearAllTimers()` bleibt davon getrennt und weiterhin still.

## 4. Technischer Zielvertrag

### 4.1 Gemeinsamer Timer-Codec

Eine kleine fachliche Datei unter `src/services/actions/`, beispielsweise `timer-contract.ts`, bündelt:

- `TimerRequest` mit `durationSeconds` und optionalem `label`,
- `TimerSelector` für `all`, `label` oder `durationSeconds`,
- Parser für die kompakten Action-Parameter,
- kanonische Serialisierung,
- deterministische deutsche Dauerformatierung.

Parser und Serializer bilden gemeinsam die einzige Definition des Wire-Formats. Router und ActionService dürfen keine zweite, abweichende Dauerlogik erhalten.

### 4.2 Schema und generischer Router

`ACTION_SCHEMAS` validiert `set_timer` und `cancel_timer`, gibt für beide aber einen kanonischen String zurück. Dadurch bleiben folgende generische Verträge unverändert:

- `String(parsed.data)` in `RouterService`,
- Action-Bestätigung und korrelierter Dispatch,
- zweite Validierung im `ActionService`,
- bestehende Action-Allowlist über den abgeleiteten `ActionName`-Typ.

Nur falls der generische Router bewusst auf einen Action-Codec umgestellt wird, darf ein Schema Domain-Objekte zurückgeben. Das wäre größerer Scope und ist für Timer V2 nicht empfohlen.

### 4.3 SystemActions

Empfohlene kompatible Signatur:

```ts
setTimer(request: TimerRequest | number, signal?: AbortSignal): LaunchResult
```

- Ein `number` bleibt ein Legacy-Minutenwert.
- `TimerRequest.durationSeconds` ist der neue eindeutige Domain-Wert.
- Interne `TimerEntry`-Objekte speichern Sekunden sowie optional bereinigtes und normalisiertes Label.
- Die maximale Anzahl von fünf Timern und die Wall-Clock-Neuarmierung bleiben erhalten.
- Bei unbenannten ganzen Minuten bleibt die bestehende Meldung `Dein 5-Minuten-Timer ist abgelaufen.` erhalten.
- Benannte Timer sprechen `Dein <Label>-Timer ist abgelaufen.`.

Der 24-Stunden-Grenzwert muss sowohl im Wire-Parser als auch defensiv in `SystemActions` gelten. So kann kein interner Aufruf den Schema-Schutz umgehen.

## 5. Umsetzung in kleinen Gates

### Gate A — Arbeitsstand und Vertrag sichern

**Status:** Abgeschlossen.

1. Bereits begonnene Timer-V2-Diffs als unfertig behandeln und gegen diesen Plan prüfen.
2. Keine Änderung an Voice-/TTS-Dateien zulassen.
3. Bestehende Legacy-Tests für `set_timer:1` und `setTimer(1)` vor der Umstellung als Regression festhalten.

**Haltepunkt:** Wire-Format, Maximaldauer, Labelgrenze und Mehrdeutigkeitsregeln sind in Tests eindeutig beschrieben.

### Gate B — Codec und Domain

**Status:** Abgeschlossen.

1. Gemeinsamen Parser/Serializer implementieren.
2. `SystemActions` auf Sekunden plus optionale Labels erweitern.
3. `cancelTimers(selector)` mit fail-closed Semantik ergänzen.
4. `clearAllTimers()` unverändert als stillen Lifecycle-Cleanup erhalten.

**Haltepunkt:** Reine Unit-Tests für Parser, Formatierung, Ablauf und Abbruch sind grün; Router und TTS sind noch unverändert.

### Gate C — Action-Pipeline

**Status:** Abgeschlossen.

1. `set_timer`-Schema auf den kanonischen Stringvertrag erweitern.
2. `cancel_timer` in Schema, Permission-Metadaten, Feedback und `ActionService` ergänzen.
3. Sicherstellen, dass Router-Validierung und ActionService-Validierung denselben Stringvertrag verwenden.
4. Den bestehenden Warm-Worker-Heuristikpfad prüfen; `Timer` und `Wecker` decken Abbruchformulierungen voraussichtlich bereits ab.

**Haltepunkt:** Es gibt keinen `[object Object]`-Dispatch, keine ungeprüfte Action und kein stilles Cancel bei Mehrdeutigkeit.

### Gate D — Router-Prompt

**Status:** Abgeschlossen.

1. Kompaktes Format mit wenigen klaren Beispielen dokumentieren.
2. Sekunden ausdrücklich gegen Minuten-Verwechslung absichern.
3. Gemischte und umgangssprachliche Dauern abdecken.
4. Labels semantisch extrahieren, aber keine Objektliste pflegen.
5. Absolute Uhrzeiten ausdrücklich nicht als Timer routen.

**Haltepunkt:** Prompt- und Parser-Tests beweisen die Ausgabeform; freie Modellantworten können keine unvalidierte Timer-Aktion ausführen.

### Gate E — Gesamtprüfung und praktische Abnahme

**Status:** Abgeschlossen.

1. Zieltests aus Abschnitt 6 ausführen.
2. Beide Typechecks ausführen.
3. Vollständige Vitest-Suite ausführen.
4. Produktionsbuild und `git diff --check` ausführen.
5. Sarah neu starten und die kurze Windows-Matrix aus Abschnitt 7 durchführen.

**Haltepunkt:** Erst nach technischer und praktischer Prüfung gilt Timer V2 als implementiert.

## 6. Automatisierte Testmatrix

### Timer-Codec und Schema

- Legacy `1` → 60 Sekunden.
- `30s`, `5m30s`, `1h30m`, `45m` werden korrekt normalisiert.
- `0s`, negative Werte, fehlende Einheit, doppelte Einheiten, falsche Reihenfolge und Werte über 24 Stunden werden abgelehnt.
- Labels werden bereinigt; leere, zu lange oder delimiterhaltige Labels werden konsistent behandelt.
- `all`, `label=...` und `duration=...` werden korrekt geparst.
- Unbekannte Cancel-Selektoren werden abgelehnt.

### SystemActions

- Bestehendes `setTimer(1)` bleibt eine Minute.
- Ein 1-Sekunden-Timer läuft genau einmal ab.
- Ein benannter Timer verwendet die benannte Ablaufmeldung.
- Ein unbenannter Minuten-Timer behält die bestehende Meldung.
- Maximal fünf parallele Timer bleiben erlaubt.
- Abort und `clearAllTimers()` räumen Handles und Listener auf.
- Standby-/Wall-Clock-Rearm bleibt korrekt.
- Cancel per eindeutigem Label und eindeutiger Dauer funktioniert.
- Kein Treffer und mehrere Treffer brechen nichts ab.
- `all` bricht alle Timer ab; der stille Shutdown-Pfad bleibt separat.

### Action-Pipeline und Router

- Legacy `[ACTION:set_timer:1]` bleibt gültig.
- Neue Set- und Cancel-Tags durchlaufen Parser, Schema, RouterService und ActionService ohne Typverlust.
- `[object Object]` kann nicht als Parameter entstehen.
- Ungültige oder überlange Parameter werden vor der Ausführung abgelehnt.
- Permission-Metadaten sind für alle Action-Namen vollständig.
- Bestätigungs- und Erfolgs-/Fehlerfeedback verwendet Dauer und Label korrekt.
- Router-Beispiele decken Sekunden, Mischdauer, Label sowie die drei Cancel-Varianten ab.

### Bestehende Timer-Priorität

- Die vorhandenen automatisierten Tests für priorisierte Timer-Ausgabe, Satzgrenze, Pause, Resume und Leerlauffall bleiben vollständig grün.
- Es werden keine bestehenden Voice-/TTS-Tests entfernt oder abgeschwächt.

## 7. Praktische Windows-Abnahme

**Status:** Bestanden.

Durchgeführte Fälle:

1. Ein unbenannter 10-Sekunden-Timer blieb unbenannt, wurde als Sekunden-Timer bestätigt und lief korrekt ab.
2. `1,5 Minuten` wurde ohne erfundenes Label als `1 Minute 30 Sekunden` übernommen.
3. Bei `Eier im Kochtopf` wurde das kurze semantische Label `Eier` verwendet; Bestätigung und Ablaufmeldung nannten den Eier-Timer korrekt.
4. Ein direkt als Eier-Timer formulierter Auftrag behielt das ausdrücklich genannte Label ebenfalls bei.
5. `1,75 Minuten` wurde korrekt zu `1 Minute 45 Sekunden` normalisiert.
6. Ein Timer über `2 Minuten 36 Sekunden` behielt die vollständige gemischte Dauer korrekt bei.
7. Der Abbruch bei zwei Timern mit demselben Label blieb fail-closed: Kein Timer wurde geraten oder gelöscht.
8. Nachdem nur noch ein passender Timer eindeutig war, funktionierte der gezielte Abbruch über das Label.
9. `Alle Timer abbrechen` wurde neutral geprüft und brach anschließend alle laufenden Timer ab; es blieb keine spätere Ablaufmeldung zurück.

Die bereits separat praktisch bestandenen Mehrfach-Timer-, Satzgrenzen-, Prioritäts-, Pause-, Leerlauf- und Resume-Fälle bleiben in `docs/steps/timer-priority-interruption-plan.md` dokumentiert. Timer V2 hat diesen bestehenden Sprachvertrag nicht verändert.

## 8. Nichtziele und späterer Erinnerungs-Branch

Nicht Teil von Timer V2:

- `um 13:45 Uhr`, `dreiviertel zwei` oder andere absolute Uhrzeiten,
- `morgen`, Wochentage, Kalenderdaten oder wiederkehrende Termine,
- Persistenz über App-Neustarts,
- Nachholen verpasster Meldungen nach ausgeschaltetem Rechner,
- Zeitzonen- oder Sommerzeitlogik,
- Kalender-, E-Mail-, WhatsApp-, Anruf- oder Handy-Integrationen.

Diese Punkte gehören in einen eigenen Erinnerungsplan und einen separaten Feature-Branch. Eine gemeinsame Scheduler-Basis kann später geprüft werden, darf aber nicht vorab in Timer V2 hineingebaut werden.

## 9. Stop- und Rollback-Kriterien

Die Umsetzung wird angehalten, wenn:

- der generische Action-Pfad für Timer eine Sonderarchitektur benötigt,
- bestehende Minuten-Timer oder deren Meldungen brechen,
- die fünf-Timer-Grenze, Abort- oder Shutdown-Cleanup unsicher werden,
- Voice-/TTS-Dateien fachlich geändert werden müssten,
- Satzgrenze, Priorität, Pause oder Resume regressieren,
- eine mehrdeutige Abbruchanfrage irgendeinen Timer löscht,
- absolute Erinnerungssemantik nötig wird.

Der Rückbau bleibt klein, weil Timer-Codec, neue Action und Domain-Erweiterung isoliert bleiben. Die stabile Rückfalloption ist jederzeit der bisherige Integer-Minutenvertrag ohne Labels und ohne Nutzer-Cancel; `clearAllTimers()` für den Lifecycle bleibt davon unberührt.

## 10. Vor Umsetzung festgelegte Entscheidungen

- Timer V2 bleibt auf relative Dauern begrenzt.
- Maximaldauer bleibt kompatibel bei 24 Stunden.
- Ein nackter Integer bleibt Minuten.
- Das interne neue Einheitsformat ist Sekunden.
- Labels sind optional, kurz und frei semantisch; es gibt keine feste Begriffsliste.
- Label- und Dauersuche sind exakt und fail-closed.
- `alle abbrechen` verlangt eine ausdrückliche All-Aussage.
- Der Action-Kanal behält kanonische Strings; keine Domain-Objekte werden unbemerkt über `String(...)` serialisiert.
- Die bereits praktisch abgenommene Timer-Prioritäts-/Pausenlogik wird nicht umgebaut.

Die konkrete Form des Nutzerfeedbacks bei einem ungültigen Label bleibt eine lokale, reversible Textentscheidung. Sie ändert weder den fail-closed Vertrag noch den abgenommenen Timer-Ablauf.

## 11. Abschlussstatus und weitere Abgrenzung

Timer V2 ist technisch sowie praktisch unter Windows abgenommen. Bestätigt sind relative Sekunden-, Minuten-, Stunden- und Mischdauern, optionale kurze Labels, benannte Ablaufmeldungen sowie eindeutiger und vollständiger Timer-Abbruch mit fail-closed Verhalten bei Mehrdeutigkeit.

Absolute Uhrzeiten und Erinnerungen bleiben ausdrücklich außerhalb dieses Abschlusses. Sie benötigen einen eigenen Plan und Feature-Branch mit Persistenz-, Neustart-, Zeitzonen- und Verpasst-beziehungsweise-Nachholen-Regeln. Timer V2 gilt nicht als praktische oder technische Abnahme dieser späteren Erinnerungsfunktion.
