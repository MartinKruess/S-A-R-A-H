# Talkabouts — Spec-Review-Protokoll

Copilot trägt hier Reviews von Specs ein. Erledigte Reviews (Feature gemerged) werden entfernt.

---

# Action-Layer-V1-Spec (2026-07-16)

Geprueft gegen den aktuellen Stand auf `dev`. Die Spec beschreibt die richtige
Richtung, setzt aber an einigen Stellen Infrastruktur voraus, die noch nicht
existiert oder deren Verhalten genauer festgelegt werden muss. Die folgenden
Punkte sollten vor der Implementierung in die Spec bzw. den Umsetzungsplan.

## Kritische Blocker

### 1. Aktionskorrelation und Parallelitaet fehlen

`action:request` und `action:result` enthalten keine Anfrage-ID. Der
`MessageBus` liefert synchron an alle Listener, die Action-Ausfuehrung ist aber
asynchron. Bei zwei schnell aufeinanderfolgenden Befehlen kann daher ein
Suchergebnis nach der Antwort auf eine spaetere Anfrage gesprochen und in deren
Kontext eingeordnet werden. Das gilt besonders fuer Timer, deren Ergebnis erst
Stunden spaeter kommt.

**Ergaenzung fuer den Vertrag:**

- `action:request` bekommt mindestens `{ requestId, action, param, mode }`.
- `action:result` bekommt mindestens `{ requestId, action, ok, speak? }`.
- Der Router fuehrt ausstehende Anfragen oder einen kleinen Ablaufzustand, damit
	Ergebnis, Historie und TTS eindeutig zugeordnet werden koennen.
- Timer duerfen nicht an eine vergangene User-Anfrage gebunden wirken. Ihr
	Ablaufereignis braucht entweder einen eigenen, als Benachrichtigung
	modellierten Vertrag oder eine eindeutige Timer-ID und eine neutrale Ansage.
- Es muss entschieden werden, ob Antworten strikt in Eingabereihenfolge
	gesprochen werden oder ob unabhaengige Action-Ergebnisse sofort sprechen
	duerfen. Ohne Regel sind TTS- und Historienreihenfolge nicht deterministisch.

### 2. Der Router-Zustand ist nicht actionsicher beschrieben

Aktuell verarbeitet `RouterService` nur `chat:message`; seine `history` wird
direkt dort gepflegt. Die Spec verlangt zusaetzlich `action:result`, beschreibt
aber nicht, wie dieses Ergebnis gegen gleichzeitige neue Nachrichten und einen
laufenden 9B-Worker abgegrenzt wird.

Konkrete Risiken:

- Ein Action-Ergebnis kann waehrend eines Worker-Streams eintreffen. Dann
	mischen sich `llm:chunk` und `llm:done` zweier Antworten fuer Renderer und
	TTS.
- Ein erneuter User-Befehl kann vor dem Suchergebnis in die Historie gelangen;
	die nachtraegliche Summary steht dann nicht mehr neben der ausloesenden Frage.
- Der 9B-Idle-Timer und `activeModel` bleiben aktiv, wenn eine Action waehrend
	eines Modellwechsels ausgefuehrt wird. Der Plan muss festlegen, ob Actions
	nur bei aktivem Router erlaubt sind und wie ein Ergebnis nach `destroy()`
	verworfen wird.

**Ergaenzung fuer die Architektur:** Eine zentrale, serialisierte
`emitAssistantResponse()`-Methode im Router sollte exklusiv Chunk/Done,
Historie und DB-Schreiben erledigen. Fuer Action-Summaries ist ein Queue- bzw.
Turn-Modell erforderlich; ein blosses zweites `onMessage` reicht nicht.

### 3. Service-Startreihenfolge und Shutdown sind unvollstaendig

Services werden erst durch `registry.initAll()` verdrahtet. Der Plan nennt die
Registrierung neuer Services in `main.ts`, aber weder ihren Registrierungs- und
Init-Zeitpunkt noch ihre Abhaengigkeiten. Der `SandboxBrowser` und In-Memory-
Timer haben ausserdem Ressourcen, die beim App-Shutdown aufgeraeumt werden
muessen.

**Planentscheidung:**

- Die neue Reihenfolge explizit festlegen: Infrastruktur/Launcher/Browser,
	dann `SearchService`, dann `ActionService`, dann `RouterService`; alle vor
	dem ersten `registry.initAll()` registrieren.
- Pruefen, wo `initAll()` aktuell aufgerufen wird, und sicherstellen, dass die
	Action-Subscriptions davor aktiv sind.
- `destroy()` muss Search-Abbrueche, BrowserWindow, offene Navigationen und
	Timer bereinigen. Spaete Promises duerfen nach Shutdown kein Bus-Event mehr
	emittieren.

## Abweichungen vom aktuellen Code

### 4. Programmtypen widersprechen der Spec

`ProgramEntrySchema` und `classifyProgramPath()` kennen bereits
`'exe' | 'launcher' | 'appx' | 'updater'`. Die Spec reduziert dies auf drei
Typen und sagt zugleich, Updater wuerden beim Scanner als Launcher markiert.
Das ist fachlich und technisch widerspruechlich.

**Entscheidung erforderlich:** Entweder `updater` als vorhandenen Typ behalten
und im `ProgramLauncher` hart ablehnen, oder vorhandene `updater`-Eintraege mit
einer expliziten Migration auf einen korrigierten Hauptpfad umstellen. Sie
duerfen nicht wie `launcher` gestartet werden. Der aktuelle Scan filtert viele
Updater bereits heraus, die Konfiguration kann sie aber weiterhin enthalten.

Ausserdem existieren schon Alias-Generierung, Pfadklassifikation,
Verifikation und Duplicate-Groups in `src/main/program-utils.ts`. Der neue
Matcher sollte diese Funktionen wiederverwenden statt Alias-Logik parallel
aufzubauen. Ein exakter Treffer muss dabei gegen Name *und* Alias gewinnen;
fuzzy Matching darf nicht still einen anderen Eintrag aus einer
`duplicateGroup` auswaehlen.

### 5. `appx`-Start ist nicht ausreichend konkret

`appx:<AppUserModelId>` wird aktuell beim Scan erzeugt. `shell:AppsFolder`
allein ist kein `child_process.spawn`-Ziel. Der Plan muss einen getesteten
Electron-/Windows-Aufruf fuer genau diese AppUserModelId benennen, inklusive
Fehlerbehandlung, wenn die Store-App deinstalliert oder der Identifier veraltet
ist. Argumente fuer EXE- und Launcher-Eintraege sind ebenfalls nicht Teil des
aktuellen Datenmodells und duerfen nicht aus LLM-Text abgeleitet werden.

### 6. Die Routing-Semantik muss rueckwaertskompatibel bleiben

Der Parser akzeptiert heute nur `[ROUTE:<wort>]` und faellt bei fehlendem Tag
auf `self` zurueck. Die neue diskriminierte Union braucht explizite Regeln:

- Nur ein Tag am String-Anfang ist gueltig; kein Nachparsen von Tags im
	Feedback und keine verschachtelten oder mehrfachen Tags.
- Ungueltige oder unbekannte ACTION-Namen werden als ungueltiges Routing-
	Ergebnis behandelt, nicht als 9B-Route und nicht als ausfuehrbare Action.
- `hadTag` muss ACTION-Tags ebenfalls erfassen; sonst entstehen irrefuehrende
	Warnungen und Metriken.
- Die bestehenden `ROUTE:self`-Beispiele fuer Programmoeffnen muessen entfernt
	werden, sonst trainiert der Prompt gegensaetzliches Verhalten.
- Der Parametertrenner `:` ist mehrdeutig fuer Suchanfragen, Uhrzeiten und
	Programmnamen. Entweder ein kodiertes strukturiertes Format waehlen oder
	genau festlegen, dass nur der erste und zweite Doppelpunkt strukturell sind
	und der Rest zum Parameter gehoert.

## Suche und Browser: fehlende Fehler- und Sicherheitsfaelle

### 7. Navigation braucht einen vollstaendigen Netzwerkvertrag

Die genannten `will-navigate`- und Popup-Guards reichen nicht allein. Auch
Redirects, Subresources, `webContents.loadURL()`-Fehler, Zertifikatsfehler,
HTTP-Fehler, `did-fail-load`, endlose Redirect-Ketten und der Status einer
bereits sichtbaren Browser-Seite brauchen definierte Behandlung. Das
`sarah-web`-Profil ist zwar nicht persistent, bleibt aber pro laufender App
geteilt; fuer V1 sollte vor jeder Suche klar sein, ob Cookies/Cache/History
geloescht werden oder die Partition eindeutig nur eine Session tragen darf.

**Ergaenzungen:**

- Einen `AbortSignal` bzw. Abbruchpfad fuer die 15-Sekunden-Frist vorsehen,
	damit ein spaetes `did-finish-load` keine veraltete Summary erzeugt.
- URL vor *jeder* Navigation und nicht nur beim Extraktionsergebnis validieren.
	Redirects muessen ebenfalls auf `http:`/`https:` beschraenkt bleiben.
- Browserfenster darf nicht zufaellig geschlossen werden; `closed` muss die
	gespeicherte Referenz loeschen. Bei Renderer-Crash muss die laufende Anfrage
	genau einmal fehlschlagen, nicht beim naechsten Aufruf erneut sichtbar werden.
- Kein `executeJavaScript` mit Query, URL oder DOM-Text per Stringinterpolation
	bauen. Die Extraktionsfunktion muss statisch sein, sonst wird die
	Sicherheitsgrenze selbst zum Script-Injection-Pfad.
- DuckDuckGo und Bing koennen Bot-Schutz, Consent-Seiten, CAPTCHA, regionale
	Umleitungen oder geaendertes Markup liefern. Das ist ein erwarteter Provider-
	Fehler mit Diagnose, nicht nur "keine Ergebnisse".

### 8. Die Text-Schleuse braucht Unicode- und Prompt-Grenzen

Steuerzeichen und Unicode-Separatoren zu entfernen ist sinnvoll, aber fuer
Prompt-Quarantaene nicht vollstaendig. Beruecksichtigen: bidi-Steuerzeichen,
Zero-Width-Zeichen, homoglyphische Tag-Imitationen, HTML-Entities, sehr lange
einzelne Tokens sowie Titel und Snippets, die nur aus Steuer-/Leerzeichen
bestehen.

**Festlegen:** Normalisierung (z. B. NFC), Whitespace-Kanonisierung,
Entfernung unsichtbarer Formatzeichen, Validierung nichtleerer Felder und ein
Gesamtbudget nach Zeichen/Token fuer alle acht Ergebnisse. URLs sind fuer die
Summary nicht notwendig; idealerweise gehen nur Titel und Snippet in den
Prompt, waehrend die kanonisch validierte URL ausschliesslich in `lastResults`
bleibt.

Die Summary darf keine Action-Tags ausfuehren, aber ihr Text kann spaetere
Router-Entscheidungen beeinflussen, weil er in der Historie steht. Der
Systemprompt des Workers und Routers sollte deshalb klarstellen, dass
Suchzusammenfassungen und alle zuvor zitierten Webinhalte Daten sind, keine
Anweisungen.

### 9. `lastResults` braucht Session- und Kontextregeln

Ein globales `lastResults` ist bei parallelen Suchen, mehreren Fenstern oder
einem Ergebnis nach App-/Browser-Neustart mehrdeutig. `show_browser:2` muss an
eine Search-Session gebunden sein, die mit der Summary in Historie bzw.
`requestId` verknuepft wird. Bei einer neuen Suche sollte klar sein, ob sie die
alte Session ersetzt, und ob "das zweite" ohne vorherige Suche den letzten
erfolgreichen Satz Ergebnisse meint. URLs aus Suchergebnissen muessen vor dem
Speichern kanonisch validiert werden; die Zuordnung darf nicht nach Titel-
Stichwort allein erfolgen, weil mehrere Treffer denselben Titel haben koennen.

## Ausfuehrungs- und Plattformrisiken

### 10. Systemaktionen brauchen echte Plattformgrenzen

Die V1-Aktionen sind Windows-spezifisch. Der `SystemSchema` kennt zwar
Plattformdaten, die Spec fordert aber keine Laufzeitpruefung. Auf macOS/Linux
oder in Tests darf weder `rundll32.exe` noch eine Lautstaerke-Implementierung
versucht werden. Jede Systemaktion braucht eine einheitliche Antwort fuer
"nicht unterstuetzt", Zugriffsfehler und fehlende Binaries.

Fuer `lock_screen` sollte die Ausfuehrung mit `spawn`/`execFile` und festen
Argumenten beschrieben werden, inklusive Fehler- und Exit-Code-Behandlung;
ein einzelner zusammengesetzter String ist nicht ausreichend als
Implementierungsentscheidung. Lautstaerke erfordert vor der Package-Wahl einen
Spike mit gepackter Electron-App und ohne Administratorrechte. Die neue
Dependency gehoert dann in Lockfile, Build und Lizenz-/Native-Module-Check.

### 11. Programmstart erfordert Prozess- und Fehlermodell

`spawn(path, { detached: true })` allein kann unter Windows mit Leerzeichen,
fehlenden Zugriffsrechten, blockierten Dateien, bereits laufenden Anwendungen
oder Launcher-Prozessen scheitern. Der Plan braucht `error`-Listener und eine
klare Definition, wann "geoeffnet" gesagt werden darf: erfolgreich gestarteter
Prozess ist nicht gleich sichtbares Programmfenster. `unref()` und die
Standard-Streams muessen so konfiguriert werden, dass die Electron-App nicht
am Kindprozess haengt. Fuer `launcher` ist ein Timeout bzw. keine positive
Sichtbarkeitsbehauptung sinnvoll.

### 12. Timer: Zeitbasis, TTS und Testbarkeit

Die Grenzen 1 bis 1440 Minuten sind definiert, nicht aber Wiederholung,
Abbruch, Benennung, Anzeige und Verhalten bei Standby. Mindestens fuer V1
festlegen: monotone Zeitberechnung versus `setTimeout`, Umgang mit sehr langen
Delays, Timer-ID, Reinigung nach Ablauf sowie dass ein TTS-Fehler den Timer
nicht wiederholt ansagt. Timer muessen mit Fake-Timern getestet werden, ohne
reale Minuten zu warten.

## Fehlende Tests und Akzeptanzkriterien

Der bestehende Testplan ist ein guter Start, deckt aber diese faelschbaren
Faelle noch nicht ab:

- Parallel: zwei Action-Requests mit vertauschter Fertigstellungsreihenfolge;
	Ergebnisreihenfolge, requestId und Historieneintraege pruefen.
- Race: `action:result` waehrend Worker-Stream, Router-Idle-Swap und App-
	Shutdown; keine vermischten `llm:chunk`/`llm:done`, keine unhandled
	rejections.
- Browser: Redirect auf unzulaessiges Protokoll, `did-fail-load`, Timeout mit
	spaetem Load-Event, Browserfenster manuell geschlossen, Renderer-Crash und
	Abbruch bei Shutdown.
- Search-Provider: Consent/CAPTCHA/HTTP-Fehler/Markup-Aenderung als
	unterscheidbare Diagnosen; URL- und Ergebnis-Session-Isolation.
- Sanitizer: bidi, zero-width, homoglyphische ACTION-Tags, HTML-Entities,
	leergewaschene Strings und Gesamt-Tokenbudget.
- Programme: persistierter `updater`, veralteter `appx`-Identifier,
	`spawn`-`error`, Leerzeichen im Pfad, Alias-Konflikt und Fuzzy-Gleichstand.
- Plattform: Windows-Guard, nicht unterstuetzte Plattform, Lautstaerke ohne
	verfuegbare Implementierung und Fehler bei `LockWorkStation`.

## Empfohlene Umsetzungsreihenfolge

1. **Vertrag und Tests zuerst:** Bus-Payloads mit `requestId`, diskriminierte
	 Parser-Union, strikte ACTION-Syntax und Unit-Tests fuer Rueckwaertskompatibilitaet.
2. **Router-Turn-Modell:** serialisierte Assistant-Ausgabe, Ergebnis-Queue,
	 Historien-/DB-Eigentum, Shutdown-Guard sowie Race-Tests implementieren.
3. **Programmausfuehrung isoliert:** vorhandene Program Utilities wiederverwenden,
	 `updater` hart blockieren, `appx` technisch verifizieren und alle Spawn-
	 Fehlerpfade testen.
4. **Systemaktionen isoliert:** Windows-Guard, Timer-Registry mit IDs und
	 Fake-Timer-Tests; Lautstaerke erst nach dem technischen Spike festlegen.
5. **Browser-Grundgeruest:** Lifecycle, Navigation-Guards, Timeout/Abort und
	 Crash-/Close-Tests noch ohne echten Suchprovider.
6. **Search-Provider und Schleuse:** Fixtures, kanonische Sanitization,
	 Ergebnis-Session und Diagnosevertrag; erst dann die aktionsfreie Summary.
7. **End-to-End:** Alle sechs Aktionen mit kontrollierten Fakes und danach die
	 manuellen Voice-Tests. Dabei explizit parallele Eingaben, Shutdown und
	 Folgefragen auf Suchergebnisse pruefen.
