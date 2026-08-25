# Sarah – Phase 1: Core-Fundamentlücken

Diese Liste ergänzt `phase1-todo.md`. Sie ersetzt weder die 704 Produkt-Checkpunkte noch deren Fortschrittszählung.

- `phase1-todo.md` beantwortet: **Was soll Sarah in Phase 1 können?**
- Diese Datei beantwortet: **Welche gemeinsame Grundlage muss zuverlässig tragen, bevor weitere Feature-Säulen darauf aufgebaut werden?**

Ein grüner Produktpunkt kann für den Prototyp ausreichend sein und trotzdem auf einer gelben Core-Komponente beruhen. Deshalb werden Produktfortschritt und Fundamentreife getrennt bewertet.

## Status-Legende

- 🔴 Fundament fehlt oder eine vorhandene Produktbehauptung wird technisch noch nicht zuverlässig erzwungen
- 🟡 Grundlage ist vorhanden, aber unvollständig, unzuverlässig oder noch praktisch abzunehmen
- 🟢 Für weitere darauf aufbauende Entwicklung ausreichend stabil und automatisiert sowie praktisch bestätigt
- ⚪ Gehört bewusst nicht zum Core-Fundament dieser Phase

## Prioritäten

- **P0:** globaler Blocker; vor weiterer Feature-Erweiterung stabilisieren
- **P1:** vor Features stabilisieren, die diesen Bereich verwenden
- **P2:** vor der vollständigen Phase-1-Abnahme schließen

## Snapshot nach Prompt-/Router-Fundament und Layer 0 (25.08.2026)

- 117 bewertete Core-Aussagen im Abschnitt `Aktueller Stand`
- 19 🟢 ausreichend tragfähig
- 40 🟡 vorhanden, aber noch nicht belastbar genug
- 58 🔴 technisch offen
- Prompt-/Router-Fundament und Layer 0 sind automatisiert umgesetzt.
- Die verbleibende praktische Windows-Matrix hält die betroffenen Runtime-Aussagen bis zur realen Abnahme auf 🟡.

Diese Zahlen sind eine Bestandsaufnahme des Fundaments und ausdrücklich **kein** zusätzlicher Produktfortschrittszähler neben den 704 Checkpunkten.

---

# 1. Eingangsverarbeitung und Turn-Steuerung

**Priorität: P0**

## Aktueller Stand

- 🟡 Texteingaben, Spracheingaben und expandierte Custom-Commands erreichen denselben normalen Verarbeitungsweg.
- 🟡 Benutzerdefinierte Slash-Commands werden auf dem aktuellen Feature-Branch deterministisch erkannt und genau einmal expandiert; die praktische Abnahme steht aus.
- 🔴 Bei einem Custom-Command ersetzt die Expansion derzeit den ursprünglichen Nutzereingang bereits vor History und Persistenz; Rohbefehl, Command-ID beziehungsweise Version, Argumente und expandierte Anweisung bleiben nicht als getrennte Herkunftsdaten erhalten.
- 🔴 Built-ins wie `/anonymous`, `/showcontext` und `/quietmode` besitzen noch keine echte Laufzeitlogik.
- 🔴 Gleichzeitig oder während einer laufenden Antwort eintreffende Nutzernachrichten besitzen noch keinen eindeutig definierten Turn-Queue-, Abbruch- oder Ersetzungsvertrag.
- 🔴 `turnInFlight` kann derzeit durch einen später gestarteten Turn ersetzt werden, obwohl der frühere Turn noch läuft; nur die Ausgabe, nicht die gesamte Verarbeitung, ist serialisiert.
- 🟡 Leere beziehungsweise unverständliche Eingaben werden teilweise behandelt, aber noch nicht zentral vor allen Aktionen abgefangen.
- 🔴 Störgeräusche oder fehlerhafte STT-Texte können noch als scheinbar gültige Aktion interpretiert werden.
- 🔴 Eine Push-to-Talk-Aufnahme besitzt noch keine harte Gesamtgrenze für Dauer beziehungsweise Puffergröße; ein verlorenes Key-up kann den Audio-RAM-Puffer weiter anwachsen lassen.

## Fundamentlücke

Vor Router, Worker und Tools muss genau eine kontrollierte Eingangsschicht entscheiden, ob eine Nachricht normal verarbeitet, als Command expandiert, abgelehnt, angehängt oder als Unterbrechung behandelt wird.

## Abnahmekriterien

- Jede Eingabe erhält eine eindeutige Turn-ID.
- Ein Turn-Envelope trennt ursprüngliche Eingabe, normalisierten Text, STT-Transkript, Command-Herkunft, Expansion und tatsächlich an Router beziehungsweise Worker übergebene Anweisung.
- Eine zentrale Turn-State-Machine besitzt höchstens einen aktiven Besitzer für Router, Worker, Output und Persistenz.
- Es existiert eine festgelegte Regel für `queue`, `cancel`, `replace` und `interrupt`.
- Ein gemeinsames AbortSignal wird bis Router-, Worker-, Provider-, STT- und TTS-Arbeit weitergereicht; verspätete Chunks werden verworfen.
- Slash-Commands werden niemals rekursiv oder als ungeprüfter Shell-/Toolcode ausgeführt.
- Unbekannte Slash-Commands gelangen nicht versehentlich als freie Anweisung an ein Modell.
- Leere, extrem kurze und offensichtlich unverständliche STT-Ergebnisse lösen keine Aktion aus.
- Sprachaufnahmen besitzen eine begrenzte Dauer und Größe; ein Timeout oder verlorenes Key-up beendet sie kontrolliert und erzeugt keine scheinbar vollständige Anfrage.
- Gleichzeitige Eingaben erzeugen weder doppelte Antworten noch vermischte History.

---

# 2. Router-Vertrag und Modellgrenzen

**Priorität: P0**

## Aktueller Stand

- 🟡 Der Router liefert auf dem aktuellen Feature-Branch nur noch einen Route- oder Action-Tag; automatisierte Tests sind grün, die praktische Abnahme steht aus.
- 🟢 Aktionsnamen und Parameter werden hinter dem Router über eine zentrale Allowlist und Zod-Schemas geprüft.
- 🟢 Ungültige oder textreiche Routerausgaben fallen sicher auf den Worker zurück und werden nicht als Routertext angezeigt.
- 🟡 Der Router-Prompt wurde stark verkleinert, muss aber mit real gesprochenen Formulierungen praktisch geprüft werden.
- 🟡 Die Browser-Suche erzeugt freie Zusammenfassungen ausschließlich über den lokalen Worker; der reale Router-/Worker-/Search-Ablauf muss noch praktisch abgenommen werden.
- 🔴 Ein echtes Backend-Ziel existiert noch nicht; Backend-, Extern- und Vision-Routen landen derzeit beim lokalen Worker.
- 🟡 Interne Bezeichnungen `2b` und `9b` entsprechen nicht mehr den tatsächlich konfigurierten Modellgrößen und verschleiern die fachlichen Rollen.

## Fundamentlücke

Der Router darf ausschließlich klassifizieren und Parameter extrahieren. Gespräch, sichtbare Formulierung, Sicherheitsentscheidung und Workflowplanung dürfen nicht still in den Router zurückwandern.

## Abnahmekriterien

- Routerausgaben sind vollständig strukturiert und für Nutzer unsichtbar.
- Freie Fragen, Begrüßungen und Profilfragen werden niemals vom Router beantwortet.
- Zusammenfassungen, Toolergebnis-Erklärungen und alle anderen freien Texte stammen ebenfalls niemals vom Router-Provider, sondern aus deterministischem Code, dem lokalen Worker oder später einem Backend-Worker.
- Unbekannte Route, unbekannte Aktion, zusätzlicher Text und mehrere Tags besitzen sichere Fallbacktests.
- Fachliche Rollen heißen beispielsweise `router`, `local_worker` und später `backend_worker`, unabhängig von Modellgrößen.
- Ein späterer Backend-Adapter kann ergänzt werden, ohne Router- oder UI-Verträge neu zu schreiben.

---

# 3. Autoritatives Profil und bekannte Anwendungsdaten

**Priorität: P0**

## Aktueller Stand

- 🟢 Profildaten, Skills, Ressourcen und Personalisierung sind logisch getrennte Bereiche der verschlüsselten Konfiguration.
- 🟡 Das Worker-Modell erhält ausgewählte Profildaten als strukturierten autoritativen Promptblock.
- 🟡 `Wie heiße ich?` wird auf dem aktuellen Feature-Branch direkt aus dem Profil beantwortet; die praktische Abnahme steht aus.
- 🔴 Weitere eindeutige Profilfragen werden noch nicht über einen allgemeinen Profile-Query-Service beantwortet.
- 🔴 Es gibt keine zentrale Feldklassifikation für öffentlich, persönlich, sensibel und nur nach Bestätigung ausgebbar.
- 🟡 Profilinformationen werden teilweise sinnvoll verwendet, Relevanz und Nicht-Wiederholung sind aber noch modellabhängig.

## Fundamentlücke

Bekannte Anwendungsdaten dürfen nicht vom Modell erraten, verneint oder aus Gesprächserinnerungen rekonstruiert werden. Profil, Skills, Ressourcen, Systemzustand und Memory benötigen eindeutige Besitzer und Prioritäten.

## Abnahmekriterien

- Ein Profile-Query-Service beantwortet mindestens Name, Stadt, Beruf, Hobbys, Alter und relevante konfigurierte Pfade deterministisch.
- Fehlende Werte werden ehrlich als nicht hinterlegt gemeldet.
- Autoritative Konfiguration gewinnt immer gegen widersprechende Gesprächserinnerungen.
- Sensible Felder werden nicht pauschal in Modellprompts injiziert.
- Änderungen in den Einstellungen gelten für den nächsten Turn, ohne Neustart und ohne vom alten Verlauf überschrieben zu werden.

---

# 4. Prompt- und Persona-Vertrag

**Priorität: P0**

## Aktueller Stand

- 🟢 Identität, Sicherheit, Profil, Fähigkeiten, Persönlichkeit und Antwortstil werden in getrennten Prompt-Layern erzeugt.
- 🟡 Die Grundansprache ist auf dem aktuellen Feature-Branch fest auf Du ausgelegt.
- 🟡 Eindeutige Personas wie Pirat wirken bereits, unscharfe Stile werden jedoch zufällig und inkonsistent eingestreut.
- 🔴 Promptregeln besitzen noch keine dokumentierte Prioritätsordnung für Konflikte zwischen Identität, Persona, Profil, Memory, Modus und Verlauf.
- 🟡 Nutzerdefinierte Promptfelder werden teilweise begrenzt und bereinigt, aber noch nicht einheitlich an allen Systemgrenzen behandelt.

## Fundamentlücke

Ein kleines lokales Modell braucht kurze, widerspruchsfreie und priorisierte Verträge. Fakten gehören in strukturierte Datenblöcke; Regeln in klare Instruktionen; frühere Gespräche dürfen beides nicht überschreiben.

## Abnahmekriterien

- Promptreihenfolge und Prioritäten sind dokumentiert und getestet.
- Es gibt keine widersprüchlichen Regeln zu Name, Ansprache, Länge, Format oder Persönlichkeit.
- Persona-Modi definieren Intensität, Häufigkeit und Beispiele statt nur zufällige Schlagwörter.
- Ein späterer Butler-Modus kann formelle Sprache einführen, ohne die globale Grundform zu verändern.
- Promptgrößen werden pro Layer gemessen und besitzen feste Obergrenzen.

---

# 5. Arbeitsgedächtnis und Session-Kontext

**Priorität: P0**

## Aktueller Stand

- 🟢 Der aktuelle Verlauf wird im RouterService gehalten und passend zum Kontextfenster gekürzt.
- 🟡 Die In-Memory-History selbst wächst bis zum Neustart weiter; nur der versendete Ausschnitt wird begrenzt.
- 🟡 Beim Neustart werden die letzten 20 Nachrichten früherer Sessions als roher Startkontext geladen.
- 🔴 Frühere User- und Sarah-Nachrichten behalten ihre ursprünglichen Rollen und können dadurch alte Fehler, Stile und Anweisungen erneut vormachen.
- 🔴 Die vorhandene `conversations.summary`-Spalte wird nicht verwendet.
- 🔴 Eine Conversation wird beim Start angelegt, aber noch nicht mit `ended_at`, Abschlusszustand, tatsächlichem Chat-/Voice-Modus oder einer belastbaren Zusammenfassung beendet.
- 🟡 Bei mittleren Antworten bleibt ein begrenztes, bei ausführlichen Antworten ein sehr kleines reales History-Budget übrig.

## Fundamentlücke

Aktuelle Session, frühere Sessions, autoritative Daten und Erinnerungen werden noch nicht sauber genug getrennt. Ein gespeichertes Transkript ist kein automatisch relevanter Kontext.

## Abnahmekriterien

- Die aktive History besitzt eine harte Größen- oder Turn-Grenze.
- Frühere Sessions werden als gekennzeichnete Zusammenfassung beziehungsweise Recall-Daten geladen, nicht als rohe Rollenvorbilder.
- Falsche frühere Sarah-Antworten können keine aktuellen Profil- oder Persona-Regeln überschreiben.
- Antwortreserve und Kontextbudget werden dynamisch und nachvollziehbar verteilt.
- Start, Ende, Modus und unvollständiger Abbruch einer Session werden eindeutig erfasst; ein App-Absturz macht die letzte Session nicht fälschlich zu einem normalen Abschluss.
- Mehrminütige Gespräche, Themenwechsel und Rückkehr zum vorherigen Thema besitzen reproduzierbare Abnahmetests.

---

# 6. Persistenz, Datenschutz und Inkognito

**Priorität: P0**

## Aktueller Stand

- 🟢 Konfiguration und sensible Datenfelder werden über die Storage-Abstraktion verschlüsselt gespeichert.
- 🟢 Gespräche werden Sessions in SQLite zugeordnet.
- 🔴 Normale Nachrichten werden aktuell unabhängig von `memoryAllowed` in `messages` persistiert.
- 🔴 `/anonymous` beziehungsweise Inkognito verhindert derzeit weder User- noch Assistant-Persistenz zuverlässig.
- 🔴 Aufbewahrung, Löschung, Export und vollständige Bereinigung von Gesprächsdaten besitzen noch keinen durchgängigen Vertrag.
- 🔴 Es ist nicht sauber getrennt, ob eine Einstellung Session-Protokollierung, semantisches Langzeitgedächtnis oder beides deaktiviert.
- 🔴 Bei aktiviertem Push-to-Talk hält der Renderer das Mikrofon derzeit warm und übergibt beim Tastendruck ungefähr 384 ms Pre-Roll von unmittelbar **vor** der bewussten Aktivierung an STT.
- 🔴 Wird Voice nach einem aktivierten Push-to-Talk-Modus auf `Aus` gestellt, erhält der AudioBridge keinen entsprechenden Controls-Apply-Vertrag und kann den warmen Mikrofonstream bis zum Renderer-Shutdown weiter offen halten.
- 🟡 STT legt pro Transkription vorübergehend eine unverschlüsselte WAV-Datei im allgemeinen Temp-Ordner ab und löscht sie im normalen `finally`-Pfad; für Absturzreste, eindeutige Dateinamen und Startbereinigung fehlt noch ein Vertrag.

## Fundamentlücke

Persistenz, Session-Protokoll und Langzeit-Memory werden begrifflich und technisch vermischt. Datenschutzversprechen müssen vor dem Schreiben technisch entschieden werden, nicht nur im Prompt stehen.

## Abnahmekriterien

- Für jeden Turn wird vor der ersten Speicherung eine Persistence-Policy festgelegt.
- Inkognito speichert weder Usertext noch Sarah-Antwort noch daraus abgeleitete Zusammenfassung oder Memory-Kandidaten.
- Temporärer Inkognito-Kontext funktioniert innerhalb der laufenden Unterhaltung und wird anschließend verworfen.
- `memoryAllowed` besitzt eine eindeutige dokumentierte Bedeutung.
- Nutzer können gespeicherte Sessions und semantische Erinnerungen getrennt anzeigen und löschen.
- Mikrofonzustände wie `geschlossen`, `warm`, `hört zu`, `überträgt` und `stumm` sind technisch getrennt und für den Nutzer wahrheitsgemäß sichtbar.
- Push-to-Talk sendet ohne eine bewusst aktivierte Pre-Roll-Option keine Audiodaten von vor dem Tastendruck; Stumm und Voice-Aus leeren vorhandene Pre-Roll-Daten sofort.
- Voice-Aus gibt den Mikrofonstream frei; ein dauerhaft warmes Mikrofon ist nur als bewusst gewählte, sichtbar erklärte Option zulässig.
- Temporäre Audiodateien liegen nur so kurz wie technisch notwendig vor, verwenden kollisionssichere private Pfade und werden nach Fehlern sowie beim nächsten Start bereinigt.
- Automatisierte Tests prüfen Datenbankzustand nach normalen, deaktivierten und Inkognito-Turns.

---

# 7. Memory-Lifecycle und Memory-Autor

**Priorität: P0 für Memory-Behauptungen, P1 für nicht memoryabhängige Tools**

## Aktueller Stand

- 🟡 Tabellen für `learned_facts`, `persistent_rules`, `session_rules` sowie eine Conversation-Summary sind vorhanden.
- 🔴 Diese Strukturen besitzen noch keinen vollständigen produktiven Schreib-, Retrieval-, Merge- und Löschpfad.
- 🔴 Es gibt keinen Memory-Autor, der Sessioninhalte zusammenfasst und strukturierte Memory-Kandidaten erzeugt.
- 🔴 Explizite Aussagen wie `Merk dir ...` besitzen keine garantierte priorisierte Speicherlogik.
- 🔴 Deduplizierung, Widerspruch, Aktualisierung, Verfallsdatum, Quelle und Vertrauensgrad sind nicht vollständig modelliert.
- 🔴 Relevante Erinnerungen werden nicht gezielt anhand der aktuellen Frage gesucht.

## Fundamentlücke

Rohe Nachrichten werden gespeichert, aber nicht in ein verlässliches semantisches Langzeitgedächtnis überführt. Eine Datenbanktabelle allein ist noch kein Memory-System.

## Abnahmekriterien

- Der Memory-Autor verarbeitet neue Sessionabschnitte asynchron beziehungsweise an definierten Abschlussgrenzen.
- Er erzeugt strukturierte Deltas wie `add`, `update`, `merge`, `supersede` oder `ignore`, niemals ungeprüfte freie Datenbankaktionen.
- Jede Erinnerung besitzt Typ, Thema, Inhalt, Quelle, Wichtigkeit, Konfidenz und Zeitstempel.
- Explizites `Merk dir` wird als hohe, nutzerbestätigte Priorität behandelt.
- Vor einem Merge werden nur thematisch passende bestehende Erinnerungen geladen, nicht die gesamte Datenbank.
- Wiederholungen werden zusammengeführt, Widersprüche nicht still überschrieben.
- Ein Retrieval-Service injiziert nur relevante Erinnerungen in das Arbeitsgedächtnis.
- Zusammenfassungen werden nicht unbegrenzt aus früheren Zusammenfassungen weiterverdichtet, ohne Quellenbezug zu behalten.

---

# 8. Action-Ausführung, Zustände und Ergebnisverträge

**Priorität: P0**

## Aktueller Stand

- 🟢 Actions besitzen eine zentrale Allowlist und zentrale Parameterschemas.
- 🔴 Der Router prüft derzeit nur den Action-Namen; die Parameterprüfung erfolgt erst im ActionService und damit nach der sofortigen gesprochenen Fortschrittsmeldung.
- 🟢 Requests und Ergebnisse werden über Request-IDs korreliert; fremde oder doppelte Ergebnisse werden verworfen.
- 🟡 Sofortige Aktionsrückmeldungen stammen auf dem aktuellen Feature-Branch aus festem Code statt aus freiem Routertext.
- 🟡 Viele Tools melden Erfolg oder Fehler, aber es gibt keinen einheitlichen Vertrag für gestartet, bereit, teilweise erfolgreich, fehlgeschlagen und abgebrochen.
- 🔴 Es gibt keinen allgemeinen Runtime-State für installiert, läuft, bereit, bedienbar, aktiv oder hängt.
- 🔴 Browser-Suchergebnisse liegen derzeit in genau einem globalen Ergebnis-Slot; `show_browser` ist nicht an den ursprünglichen Turn oder die Search-Request-ID gebunden und kann nach einer späteren beziehungsweise konkurrierenden Suche auf den falschen Ergebnissatz zeigen.
- 🔴 Vorbedingungen, Nachbedingungen und Erfolgskontrolle sind nicht als gemeinsames Action-Konzept modelliert.
- 🔴 Doppelte `action:request`-Ereignisse mit derselben Request-ID werden vor der Seiteneffekt-Ausführung noch nicht zentral dedupliziert; nur doppelte beziehungsweise fremde Ergebnisse werden verworfen.
- 🔴 Offene `pendingActions` besitzen noch keinen allgemeinen Ablaufzeitpunkt und können ohne Ergebnis dauerhaft bestehen bleiben.
- 🔴 Mehrere Actions können noch nicht sicher zu einem überprüfbaren Workflow verbunden werden.

## Fundamentlücke

Sarah kann einzelne Aktionen auslösen, kennt aber nicht durchgängig den tatsächlichen Zustand vor und nach einer Aktion. Gesprächshistory darf niemals die Quelle für technischen Ist-Zustand sein.

## Abnahmekriterien

- Actions besitzen ein gemeinsames Ergebnisformat mit Status, Nutzermeldung, technischen Details und optionalem Zustandsupdate.
- Action-Parameter werden mit demselben zentralen Schema vor Fortschrittsmeldung, Policy-Entscheidung und Dispatch geprüft.
- Erfolgsbehauptungen werden erst nach einer geeigneten Prüfung ausgegeben; vorherige Texte sind als Fortschritt formuliert.
- Programmstatus wird live geprüft und nicht aus früheren Antworten abgeleitet.
- Prozess läuft, Anwendung bereit und Tool bedienbar werden getrennt behandelt.
- Folgeaktionen auf temporären Toolzustand verwenden einen begrenzten, an Session, Ursprungsturn und Toollauf gebundenen Kontext-Handle statt eines globalen `letztes Ergebnis`-Slots.
- Eine Request-ID darf eine verbindliche Action höchstens einmal ausführen; ein wiederholtes Ereignis liefert das bekannte Ergebnis oder wird sicher abgewiesen.
- Wiederholung, Timeout und Abbruch sind pro Action definiert und begrenzt.
- Jeder Action-Request erreicht genau einen terminalen Zustand und wird auch bei Timeout, Abbruch oder fehlendem Service aus dem Pending-State entfernt.
- Workflows führen eine ursprüngliche Aktion höchstens kontrolliert erneut aus und verhindern Schleifen.

---

# 9. Security-, Berechtigungs- und Bestätigungskern

**Priorität: P0 vor verändernden oder extern verbindlichen Features**

## Aktueller Stand

- 🟢 Unbekannte Action-Namen und ungültige Parameter werden technisch abgewiesen.
- 🟢 Die aktuelle Browser-Zusammenfassung wird nur als sichtbares Ergebnis ausgegeben und nicht erneut als Route- oder Action-Tag geparst; Webseiteninhalt kann dadurch in diesem Pfad nicht direkt ein Tool auslösen.
- 🟡 Browsertexte werden begrenzt, bereinigt und als externe Daten markiert, aber Delimiter und Prompttext sind noch kein verlässlicher Prompt-Injection-Detektor für den erzeugten sichtbaren Inhalt.
- 🟡 Teile der Sicherheitslogik liegen außerhalb des Modells, aber es gibt noch keine vollständige zentrale Policy-Entscheidung.
- 🔴 Actions besitzen noch keine verbindliche Risikoklasse wie lesen, verändern, löschen, extern oder kostenpflichtig.
- 🔴 Bestätigungen sind nicht allgemein an eine konkrete vorbereitete Action mit Parametern und Ablaufzeit gebunden.
- 🔴 Ein universeller Schutz gegen Bestätigungsumgehung durch Custom-Commands, Workflows oder externe Inhalte fehlt.
- 🔴 Secrets und einmalig sensible Daten besitzen noch keinen vollständigen Nicht-Memory-/Nicht-Log-Vertrag.

## Fundamentlücke

Jedes neue Tool würde sonst seine eigene Sicherheitslogik mitbringen. Die Policy muss vor Dateisystem, E-Mail, Browserformularen, Käufen und UI-Automation als gemeinsamer Kern stehen.

## Abnahmekriterien

- Jede Action besitzt Risikoklasse und benötigte Berechtigung.
- Eine zentrale Policy entscheidet `allow`, `confirm`, `deny` oder `prepare_only`.
- Bestätigungen referenzieren exakt Action, Parameter, angezeigte Folgen und eine kurze Gültigkeit.
- Custom-Commands und Workflows können die Policy nicht umgehen.
- Externe Webseiten-, Datei- und Tooltexte gelten als Daten, nicht als Sicherheitsanweisung.
- Sensible Werte erscheinen nicht in Modellkontext, Logs oder Memory, sofern dies nicht explizit erforderlich und erlaubt ist.

---

# 10. Ausgabe, Sprache und Unterbrechung

**Priorität: P0**

## Aktueller Stand

- 🟢 Assistant-Ausgaben und verspätete Toolmeldungen werden über eine Output-Queue serialisiert.
- 🟢 Voice-Modellwechsel können mit festen Füllsätzen überbrückt werden.
- 🟡 TTS lässt sich häufig unterbrechen.
- 🔴 Eine TTS-Unterbrechung beendet nicht garantiert den laufenden LLM-Stream und die zugrunde liegende Turn-Verarbeitung.
- 🔴 Bereits gestartete TTS-Synthese kann nach einem Queue-Stop noch verspätetes Audio liefern, weil Queue und Provider keinen gemeinsamen Generations- beziehungsweise Abbruchtoken besitzen.
- 🔴 STT-Anfragen besitzen noch keinen vollständigen gemeinsamen Timeout-/Abort-Vertrag.
- 🔴 Eine während der Ausgabe eintreffende neue Nachricht besitzt noch keinen vollständigen gemeinsamen Barge-in-Vertrag für TTS, LLM, History und Toolaktionen.
- 🟡 Textfallback bei TTS-Fehlern ist vorhanden, aber die Nutzerinformation über Teilfehler ist nicht überall einheitlich.

## Fundamentlücke

Unterbrechen ist eine End-to-End-Funktion, nicht nur `Audio stoppen`. Alle beteiligten Komponenten müssen denselben Turn abbrechen oder kontrolliert fortführen.

## Abnahmekriterien

- Barge-in stoppt Audio sofort und behandelt den laufenden Stream nach einer dokumentierten Regel.
- Abgebrochene TTS-Generationen können niemals später Audio in eine neue Unterhaltung einspeisen.
- STT-Requests sind zeitlich begrenzt und abbrechbar; ein Hänger blockiert den Voice-State nicht dauerhaft.
- Abgebrochene Teilantworten werden nicht als vollständige Assistant-Antwort persistiert.
- Toolaktionen, die bereits verbindlich gestartet wurden, werden nicht fälschlich als abgebrochen dargestellt.
- Neue Nachrichten können nicht mit alten Chunks oder verspäteten Meldungen vermischt werden.
- Chat und Voice verwenden denselben fachlichen Turn-Status.

---

# 11. Fehler, Recovery und Beobachtbarkeit

**Priorität: P1, einzelne Teile P0**

## Aktueller Stand

- 🟢 Modell-, Tool-, Browser-, Programmstart- und TTS-Fehler werden in mehreren Pfaden erkannt.
- 🟡 Timeouts und begrenzte Retries existieren teilweise.
- 🟡 Nutzer erhalten meist eine Fehlermeldung, aber technische Ursache und betroffener Verarbeitungsteil sind nicht einheitlich klassifiziert.
- 🔴 Fehler innerhalb eines serialisierten Output-Jobs können derzeit geloggt und geschluckt werden, sodass der äußere Turn nicht garantiert einen sichtbaren Fehlerzustand erhält.
- 🔴 Es gibt keine durchgängige Fehler-Taxonomie für nicht verfügbar, Timeout, ungültig, verweigert, teilweise erfolgreich und abgebrochen.
- 🔴 Turn-, Route-, Action-, Tool- und Output-Ereignisse können noch nicht vollständig über eine gemeinsame Korrelations-ID nachvollzogen werden.
- 🟡 Aktuelle Konsolenlogs enthalten teilweise rohe Routerausgaben oder Action-Parameter und benötigen vor einer dauerhaften Diagnoseablage eine Redaktionsregel.
- 🔴 Latenzen und Fehlerquoten werden nicht für alle Core-Stufen dauerhaft vergleichbar erfasst.

## Fundamentlücke

Ohne gemeinsame Zustände und Korrelation wirkt jeder neue Fehler wie ein individuelles Featureproblem. Diagnose und Recovery müssen dieselbe Pipeline abbilden wie die normale Ausführung.

## Abnahmekriterien

- Jeder Turn ist von Eingabe bis Ausgabe und Persistenz korrelierbar.
- Jeder Turn endet genau einmal mit `done`, `error` oder `canceled`; Queueing darf operative Fehler nicht in einen scheinbaren Erfolg verwandeln.
- Fehler besitzen eine strukturierte Kategorie sowie eine sichere Nutzermeldung ohne Secrets.
- Sarah unterscheidet `weiß ich nicht`, `nicht erlaubt`, `nicht unterstützt` und `Dienst ausgefallen`.
- Retries sind begrenzt, zustandsbewusst und erzeugen keine doppelten verbindlichen Aktionen.
- Ein Diagnosebericht kann den fehlgeschlagenen Core-Schritt benennen.
- Langzeittests prüfen wiederholte Modellwechsel, TTS, Router-, Browser- und Toolaufrufe.

---

# 12. Konfiguration und Modell-Lifecycle

**Priorität: P1**

## Aktueller Stand

- 🟢 Konfiguration wird über Zod validiert und zur Laufzeit als aktueller Snapshot gehalten.
- 🟡 Promptbezogene Einstellungen werden beim nächsten Workerturn neu gelesen.
- 🔴 Provider werden beim Start mit Modell, URL, Kontext und GPU-Optionen gebaut; spätere Änderungen werden nicht allgemein durch Neuinitialisierung übernommen.
- 🔴 `activeModel` beschreibt derzeit teilweise die beabsichtigte Auswahl, nicht einen technisch verifizierten geladenen und erreichbaren Modellzustand.
- 🔴 Die Worker-Verfügbarkeit wird beim Start nicht im selben Umfang geprüft wie die Router-Verfügbarkeit.
- 🔴 Modellwechsel, Idle-Unload und neue Turns besitzen noch keinen gemeinsamen Single-Flight-/Race-Vertrag.
- 🟡 Verschiedene Default-Definitionen für Kontextgröße und Modelloptionen können auseinanderlaufen.
- 🔴 Einstellungen zeigen nicht überall eindeutig, ob eine Änderung sofort gilt oder einen Neustart benötigt.
- 🔴 Die Einstellungsoberfläche wartet den Schreibvorgang nicht ab und zeigt bereits `Gespeichert!`, bevor `save-config` erfolgreich bestätigt wurde.
- 🔴 Mehrere gleichzeitig geöffnete Einstellungsansichten arbeiten mit eigenen alten Abschnittskopien und können deshalb neuere Änderungen desselben Konfigurationsbereichs per Last-Write-Wins überschreiben.
- 🔴 Persistieren, Aktualisieren des Laufzeit-Snapshots und Anwenden von Seiteneffekten wie Voice-Neukonfiguration besitzen noch keinen gemeinsamen atomaren beziehungsweise sauber rücksetzbaren Vertrag.
- 🟡 Fehlende beziehungsweise alte Konfigurationsfelder werden teilweise migriert, aber noch nicht als vollständiger Versionsvertrag behandelt.

## Fundamentlücke

Eine gespeicherte Einstellung darf nicht nur in der Oberfläche geändert aussehen. Jede Einstellung benötigt einen klaren Apply-, Restart- oder Migration-Vertrag.

## Abnahmekriterien

- Es existiert genau eine Quelle für produktive Defaults.
- Jede Einstellung ist als live anwendbar oder neustartpflichtig gekennzeichnet.
- Modell-, Provider- und Performanceänderungen werden kontrolliert angewendet oder verlangen sichtbar einen Neustart.
- Modellzustände `loading`, `ready`, `unloading`, `unavailable` und `error` werden durch einen Lifecycle-Controller verifiziert und nicht nur optimistisch gesetzt.
- Ein neuer Turn kann nicht mit einem laufenden Idle-Unload oder fehlgeschlagenen Modellwechsel kollidieren.
- Konfigurationsänderungen werden serialisiert oder revisionsbasiert zusammengeführt; parallele Ansichten können keine zwischenzeitlichen Änderungen unbemerkt überschreiben.
- Die Oberfläche meldet erst nach bestätigtem Persistieren und Anwenden Erfolg; Fehler stellen einen konsistenten vorherigen Zustand wieder her oder zeigen einen klaren Teilfehler.
- Konfigurationsmigrationen sind versioniert und getestet.
- Ungültige Konfiguration fällt nicht still auf fachlich überraschende Defaults zurück.
- Einzelne ungültige Felder führen nicht dazu, dass alle übrigen gültigen Nutzereinstellungen für den Lauf verworfen werden.

---

# 13. Storage-Integrität und Schlüsselverhalten

**Priorität: P2, Datenschutzfehler P0**

## Aktueller Stand

- 🟢 Inhaltsfelder werden verschlüsselt, während notwendige Strukturspalten filterbar bleiben.
- 🟡 Entschlüsselungsfehler fallen aus Kompatibilitätsgründen teilweise auf den rohen gespeicherten Wert zurück.
- 🔴 Beschädigter Ciphertext, alter Klartext und ein falscher Schlüssel werden noch nicht in allen Pfaden eindeutig unterschieden.
- 🔴 Es gibt keinen sichtbaren Degraded-Storage-Vertrag für beschädigte verschlüsselte Profil-, Message- oder Memory-Inhalte.
- 🟡 Nachrichten referenzieren Conversation-IDs logisch, aber referenzielle Integrität und Reparatur verwaister Zeilen sind nicht vollständig erzwungen.

## Fundamentlücke

Beschädigte oder mit einem falschen Schlüssel gelesene Daten dürfen niemals als vermeintlicher Klartext in Profil, Prompt oder Memory gelangen.

## Abnahmekriterien

- Verschlüsselungsformate sind versioniert; Legacy-Klartext und Authentifizierungsfehler werden getrennt behandelt.
- Beschädigte Inhalte werden quarantänisiert und als Storage-Fehler gemeldet, nicht an ein Modell weitergereicht.
- Schlüsselverlust, Backup, Wiederherstellung und nicht wiederherstellbare Daten besitzen einen dokumentierten Nutzerpfad.
- Verwaiste Sessions und Messages werden verhindert oder sicher repariert.

---

# 14. App-Start, Service-Lifecycle und Degraded Readiness

**Priorität: P0**

## Aktueller Stand

- 🟢 Services können zentral registriert und grundsätzlich in umgekehrter Reihenfolge beendet werden.
- 🟡 Router, Whisper und Piper schützen ihre Initialisierungspfade per Single-Flight gegen Doppelstart; die reale Mehrfachstart-Matrix steht noch aus.
- 🟡 `ServiceRegistry` behandelt Teilfehler, initialisiert unabhängige Services weiter und bereinigt fehlgeschlagene Teilinitialisierungen; reale Degraded-Starts stehen noch aus.
- 🟡 Splash und Renderer erhalten einen technisch abgeleiteten Ready-/Degraded-Snapshot statt zeitgesteuerter Erfolgsmeldungen; die sichtbare praktische Abnahme steht noch aus.
- 🟡 Cleanup-Fehler werden gesammelt, während nachfolgende Services und registrierte externe Ressourcen weiter begrenzt bereinigt werden; die reale Prozesskontrolle steht noch aus.
- 🟡 Fenster-Schließen, direkter Quit, fataler Bootstrap und Teilinitialisierung verwenden einen gemeinsamen idempotenten Shutdown-Orchestrator; die praktische Windows-Matrix steht noch aus.

## Fundamentlücke

App-Start und Shutdown bestehen noch aus mehreren teilweise unabhängigen Abläufen. Ein zentraler Lifecycle muss Abhängigkeiten, echte Bereitschaft, Teilfehler und vollständige Bereinigung besitzen, damit neue Services nicht jeweils eigene Sonderwege hinzufügen.

## Abnahmekriterien

- Jeder Core-Service besitzt explizite Zustände wie `registered`, `starting`, `ready`, `degraded`, `error`, `stopping` und `stopped` sowie bekannte Abhängigkeiten.
- Teilfehler initialisieren unabhängige Fähigkeiten kontrolliert weiter oder rollen abhängige Teilschritte zurück; zurückgelassene Subscriptions und halb gestartete Prozesse sind ausgeschlossen.
- Die Oberfläche zeigt `bereit` nur für technisch bestätigte Fähigkeiten und kann einen verständlichen Degraded-Modus ausweisen.
- Initialisierung und Shutdown sind idempotent und gegen parallele Aufrufe geschützt.
- Beim Shutdown werden alle Services und externen Ressourcen trotz einzelner Cleanup-Fehler weiter bereinigt; Fehler werden gesammelt und sicher gemeldet.
- Fenster-Schließen, explizites App-Beenden und Teilinitialisierung verwenden denselben Shutdown-Orchestrator.
- Späte Provider-, Timer- und Event-Callbacks erkennen eine veraltete Lifecycle-Generation und dürfen nach Shutdown keinen neuen Zustand erzeugen.

---

# 15. Systemgrenzen, IPC- und Ereignisverträge

**Priorität: P0 für Turn-/Security-Grenzen, sonst P1**

## Aktueller Stand

- 🟢 Die normalen Electron-Fenster verwenden `contextIsolation`, deaktiviertes Node-Integration und Sandbox; der Web-Browser läuft zusätzlich in einer isolierten Session.
- 🟡 Mehrere eingehende IPC-Payloads werden bereits durch lokale Guards oder das vollständige Zod-Konfigurationsschema geprüft.
- 🔴 Die zentrale IPC-Typdefinition entspricht nicht mehr vollständig dem produktiven Kanalvertrag: unter anderem fehlen reale Kanäle wie `open-external-url`, `wizard-done` und `boot-done`, während `splash-tts` dort eine andere Payloadform beschreibt als die Implementierung.
- 🔴 Turn-bezogene Bus- und Renderer-Ereignisse wie `llm:chunk`, `llm:done`, `llm:error` und Voice-Zustände tragen noch keine gemeinsame Turn-ID; die Oberfläche kann alte und neue Ausgaben daher nicht selbst eindeutig zuordnen.
- 🔴 Der MessageBus ruft Listener synchron ohne Fehlerisolation auf; wirft ein Listener, können nachfolgende Listener desselben Ereignisses ausfallen.
- 🟡 TypeScript schützt viele interne Aufrufer zur Buildzeit, aber es gibt noch keinen einheitlichen Runtime-Schemavertrag für alle Renderer-, Bus-, Tool- und späteren Backend-Grenzen.

## Fundamentlücke

Die Anwendung besitzt mehrere technisch ähnliche, aber getrennt gepflegte Verträge für Preload, IPC, MessageBus, Tools und Renderer. Ohne eine gemeinsame Quelle driften Payloads, Korrelation und Fehlerverhalten mit jedem neuen Feature weiter auseinander.

## Abnahmekriterien

- Eine autoritative Channel-/Event-Registry treibt TypeScript-Typen, Preload-API, Main-Handler und Vertragstests oder wird von ihnen nachweislich vollständig abgedeckt.
- Unvertrauenswürdige Daten werden an jeder Prozess-, Tool- und externen Servicegrenze zur Laufzeit validiert; reine TypeScript-Typen gelten nicht als Eingabeprüfung.
- Alle Turn-bezogenen Events tragen Turn-ID und geordneten Sequenz- beziehungsweise Terminalstatus; Actions behalten zusätzlich ihre Request-ID.
- Ein fehlerhafter Event-Listener verhindert weder andere Listener noch einen definierten Fehlerabschluss des betroffenen Vorgangs.
- Sensible IPC-Handler prüfen neben Payloads auch erlaubte Aufrufer beziehungsweise Fähigkeiten; Renderer-UI ist niemals die letzte Security-Instanz.
- Abonnements und Handler besitzen einen eindeutigen Registrierungs- und Cleanup-Lifecycle ohne Doppelregistrierung nach Reload oder Teilstart.

---

# 16. Core-Abnahme und Schutz vor Regressionen

**Priorität: P0**

## Aktueller Stand

- 🟢 Der Code besitzt eine breite automatisierte Testsuite.
- 🟡 Viele Komponenten sind isoliert gut getestet, vollständige reale Sprach- und Modellpfade werden jedoch noch nicht als feste Core-Matrix abgenommen.
- 🔴 Es gibt keine kleine verbindliche Core-Smoke-Suite, die nach jeder grundlegenden Änderung praktisch ausgeführt und dokumentiert wird.
- 🔴 Langlauf-, Konkurrenz-, Datenschutz- und Modellwechseltests decken die reale App noch nicht vollständig ab.

## Verbindliche Core-Smoke-Suite

- „Wie heiße ich?“ verwendet das autoritative Profil und kein Modellraten.
- „Was weißt du über mich?“ trennt Profil, Session und Langzeit-Memory nachvollziehbar.
- „Öffne Spotify“ erzeugt genau eine feste Fortschrittsmeldung und einen korrelierten Toollauf.
- „Mach Spotify etwas leiser“ verwendet die richtige relative Aktion.
- Eine normale Wissensfrage wird vom lokalen Worker beantwortet, niemals frei vom Router.
- Eine Browser-Suche erzeugt ihre Zusammenfassung ebenfalls niemals mit dem Router-Provider.
- Eine Folgefrage verwendet den passenden Session-Kontext.
- Ein Themenwechsel lädt keine irrelevanten Profildaten oder Erinnerungen in die Antwort.
- Ein unbekannter Slash-Command wird nicht an ein Modell oder Tool durchgereicht.
- Ein Custom-Command durchläuft dieselben Action- und Security-Regeln wie eine normale Anfrage.
- Eine Inkognito-Nachricht hinterlässt nachweislich keine persistierten Inhalte oder Ableitungen.
- Push-to-Talk überträgt ohne bewusst aktivierte Pre-Roll keine Sprache von vor dem Tastendruck; Stumm und Voice-Aus halten beziehungsweise übertragen keine Audiodaten.
- Eine Unterbrechung erzeugt keine verspätete oder doppelte Antwort.
- Ein absichtlich doppelt gesendeter Action-Request löst den Seiteneffekt genau einmal aus.
- Zwei parallele Konfigurationsänderungen bleiben beide erhalten; ein simulierter Speicher- oder Apply-Fehler wird nicht als `Gespeichert!` angezeigt.
- Ein simulierter Service-Teilstart zeigt einen korrekten Degraded-Zustand und lässt sich vollständig herunterfahren.
- Vertragstests gleichen Preload, Main-Handler, IPC-/Bus-Typen und Runtime-Schemas ab.
- Ein simulierter Router-, Worker-, Tool- und TTS-Fehler wird jeweils korrekt klassifiziert und beendet den nächsten Turn nicht dauerhaft.

## Fundament gilt als tragfähig, wenn

- alle P0-Punkte mindestens praktisch und automatisiert abnahmefähig sind,
- keine Datenschutz- oder Sicherheitsbehauptung nur im Prompt beziehungsweise in der UI existiert,
- Router, Worker, Actions, Memory und Output eindeutige Zuständigkeiten besitzen,
- die Core-Smoke-Suite reproduzierbar bestanden wird,
- neue Features an stabile Services und Verträge anschließen können, ohne eigene Parallelwege zu bauen.

---

# Empfohlene Bearbeitungsreihenfolge

1. **Automatisiert umgesetzt, praktisch offen:** tag-only Router, Worker-only Browser-Zusammenfassung, feste Action-Rückmeldungen, Namensantwort und Custom-Command-Makros praktisch abnehmen.
2. **Automatisiert umgesetzt, praktisch offen:** App-/Service-Lifecycle und wahrheitsgemäße Ready-/Degraded-Zustände mit der Windows-Matrix abnehmen.
3. IPC-/Event-Verträge, Turn-IDs und Listener-Fehlerisolation als gemeinsame Systemgrenzen festziehen.
4. Turn-Steuerung, einheitliche Eingangsschicht und Unterbrechung als vollständigen End-to-End-Abbruch stabilisieren.
5. Mikrofon-Aktivierungsgrenze, Persistence-Policy, `memoryAllowed` und echten Inkognito-Modus umsetzen.
6. Gemeinsamen Action-Ergebnisvertrag, frühe Parameterprüfung, Request-Deduplizierung und Runtime-State aufbauen.
7. Zentrale Risk-/Permission-/Confirmation-Policy fertigstellen.
8. Atomare Konfigurationsänderungen sowie Modell-Lifecycle und Apply-/Restart-Verträge vereinheitlichen.
9. Fehler-Taxonomie, Korrelation, Recovery und redigierte Beobachtbarkeit aufbauen.
10. Autoritative Profilabfragen und Promptprioritäten vervollständigen.
11. Arbeitsgedächtnis, rohe Sessiondaten und Recall sauber trennen.
12. Memory-Datenmodell, Memory-Autor, Merge-Regeln und Retrieval umsetzen.
13. Storage-Integrität, Schlüssel- und Degraded-State-Verhalten absichern.
14. Core-Smoke-Suite vollständig automatisieren und praktisch abnehmen.
15. Erst danach neue Feature-Säulen wieder regulär aufbauen.
