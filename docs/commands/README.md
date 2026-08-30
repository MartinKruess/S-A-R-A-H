# S.A.R.A.H. – Befehle und Standardantworten

Stand: 30. August 2026

Diese Datei beschreibt den aktuellen Desktop-Code. Die Beispiele zeigen unterstützte Absichten und übliche Formulierungen; sie sind keine starre Sprachsyntax. Bei Timer und Erinnerung entscheidet vor allem das ausdrücklich genannte Objekt, nicht das Verb.

Platzhalter stehen in spitzen Klammern, beispielsweise `<Dauer>`, `<Inhalt>` oder `<Programm>`. Frei durch das große Sprachmodell erzeugte Gesprächsantworten sind nicht vorhersagbar und deshalb nicht als Standardantworten aufgeführt.

## Block 1: Befehle

### Timer

Timer sind laufende, nicht persistent gespeicherte Countdowns. Sie unterstützen Sekunden, Minuten und Stunden sowie zusammengesetzte Zeitangaben. Maximal fünf Timer können gleichzeitig laufen; die maximale Dauer beträgt 24 Stunden.

Timer ohne Bezeichnung:

- „Stelle einen Timer auf 10 Minuten.“
- „Erstelle einen Timer für 30 Sekunden.“
- „Starte einen Timer für anderthalb Minuten.“
- „Timer, drei Minuten.“
- „Stelle einen Timer auf 2 Minuten 36.“
- „Stelle einen Timer auf fünfeinhalb Minuten.“
- „Stelle einen Timer auf eine Dreiviertelstunde.“

Benannte Timer:

- „Stelle einen Timer für meine Brötchen auf 5 Minuten 30 Sekunden.“
- „Erstelle einen Eier-Timer für 8 Minuten.“
- „Timer, drei Minuten, Eier kochen.“
- „Stelle einen Timer auf 30 Sekunden für die Eier im Kochtopf.“

Timer abbrechen:

- „Brich den Eier-Timer ab.“
- „Lösche den Brötchen-Timer.“
- „Brich den 30-Minuten-Timer ab.“
- „Brich alle Timer ab.“

Bei mehreren gleich bezeichneten oder gleich langen Timern wird aus Sicherheitsgründen keiner geraten oder automatisch abgebrochen.

### Erinnerungen

Erinnerungen werden persistent gespeichert. Sie unterstützen relative Angaben ab einer Minute sowie absolute lokale Daten und Uhrzeiten. Sekundenangaben gehören zum Timer.

Relative Erinnerungen:

- „Erinnere mich in 30 Minuten an den Steuerberater.“
- „Erstelle eine Erinnerung in 10 Minuten für Haare schneiden.“
- „Erstelle eine neue Erinnerung in 10 Minuten: Essen.“
- „Setze eine Erinnerung in 10 Minuten: Essen.“
- „Stelle eine Erinnerung in 10 Minuten: Essen.“
- „Speichere eine Erinnerung in 10 Minuten: Essen.“
- „Erinnerung, zehn Minuten, Haare schneiden.“
- „Erinnere mich in anderthalb Stunden ans Losfahren.“
- „Erinnere mich in zwei Tagen an <Inhalt>.“
- „Erinnere mich in einer Woche an <Inhalt>.“

Absolute Erinnerungen:

- „Erinnere mich heute um 17:05 Uhr an <Inhalt>.“
- „Heute 17.05 Uhr, <Inhalt>.“
- „17.05 Uhr, <Inhalt>.“
- „Erstelle eine Erinnerung morgen um 11 Uhr: <Inhalt>.“
- „Erinnere mich übermorgen um 8:15 Uhr an <Inhalt>.“
- „Erinnere mich Freitag um 10 Uhr an <Inhalt>.“
- „Erinnere mich am 17. März um 9 Uhr an <Inhalt>.“
- „30.08.2026 um 17.06 Uhr: <Inhalt>.“

Eine Uhrzeit ohne Tag meint das nächste Auftreten dieser Uhrzeit: heute, falls sie noch bevorsteht, sonst morgen. Ein ausdrücklich genannter vergangener Zeitpunkt wird abgelehnt.

Erinnerungen auflisten:

- „Welche Erinnerungen stehen heute an?“ – nur heute.
- „Welche Termine stehen heute an?“ – derzeit ebenfalls nur heutige Erinnerungen; eine Kalenderintegration existiert noch nicht.
- „Aktive Erinnerung.“ – alle offenen Erinnerungen.
- „Aktive Erinnerungen.“ – alle offenen Erinnerungen.
- „Alle Erinnerungen.“ – alle offenen Erinnerungen.
- „Zeige mir die aktiven Erinnerungen.“ – alle offenen Erinnerungen.

Erinnerungen abbrechen:

- „Lösche die Erinnerung Essen.“
- „Brich die Erinnerung Steuerberater anrufen ab.“
- „Brich die Erinnerung heute um 17:05 Uhr ab.“
- „Brich die Erinnerung heute um 17:05 Uhr an Essen ab.“
- „Brich alle Erinnerungen ab.“

Auswahl nach einer mehrdeutigen Abbruchanfrage:

- „Eins.“, „die erste“ oder „1“.
- „Zwei.“, „die zweite“ oder „2“.
- „17 Uhr 15.“
- „17.15 Uhr.“
- „17.15 Uhr Essen.“
- „Die um 17.15 Uhr.“

Eine falsche Nummer oder Uhrzeit lässt die Auswahl für einen weiteren Versuch offen. Eine andere, nicht als Auswahl erkennbare Nachricht beendet diesen Auswahlzustand.

Wichtig: „Alle Erinnerungen“ listet offene Erinnerungen auf. Erst ein Abbruchverb wie in „Lösche alle Erinnerungen“ löscht sie.

### Programme öffnen

- „Öffne <Programm>.“
- „Starte <Programm>.“

Der Programmname kann ein hinterlegter Name oder Alias sein. Bei mehreren Treffern fragt Sarah nach; ein nicht verifizierter, widersprüchlicher oder veralteter Programmeintrag wird nicht gestartet.

### Websuche und Suchergebnisse

- „Suche <Suchanfrage>.“
- „Such Hotels in Kiel.“
- „Google <Suchanfrage>.“
- Nach einer Suche: „Öffne das erste Ergebnis.“
- Nach einer Suche: „Zeige Ergebnis zwei.“
- Nach einer Suche: Ergebnis über ein eindeutiges Titelstichwort auswählen.

Die Suche kann durch Berechtigungen oder eine deaktivierte Browserfreigabe blockiert sein.

### Mediensteuerung

- „Pause.“ / „Pausiere die Wiedergabe.“
- „Weiter.“ / „Setze die Wiedergabe fort.“
- „Musik starten.“
- „Nächstes Lied.“ / „Skip.“ / „Ein Lied vor.“
- „Vorheriges Lied.“ / „Ein Lied zurück.“
- Optional mit Zielprogramm, beispielsweise „Pausiere Spotify.“

Die allgemeine Mediensteuerung verwendet die aktive Windows-Mediensitzung. Spotify-Lautstärke ist davon getrennt.

### Lautstärke

Systemlautstärke:

- „Stelle die Systemlautstärke auf 30 Prozent.“
- „Setze die Lautstärke auf 50 Prozent.“

Spotify-Lautstärke:

- „Stelle Spotify auf 30 Prozent.“
- „Mach Spotify lauter.“
- „Mach die Musik etwas leiser.“

„Etwas lauter/leiser“ entspricht derzeit einer Änderung um 5 Prozentpunkte, „lauter/leiser“ ohne Abschwächung 25 Prozentpunkten.

### Bildschirm

- „Sperre den Bildschirm.“

### Sprache und laufende Ausgabe

- `F9` gedrückt halten: Push-to-talk aufnehmen; Loslassen startet die Verarbeitung.
- `F9` während einer normalen Ausgabe: aktuelle Ausgabe beziehungsweise Verarbeitung unterbrechen und neue Spracheingabe beginnen.
- „Wieder da.“ / „Ich bin wieder da.“: nach einer priorisierten Timer- oder Erinnerungsansage die pausierte normale Ausgabe fortsetzen.
- „Sarah stop.“
- „Danke Sarah.“
- „Sarah aus.“
- „Sarah, du bist nicht gemeint.“

Die letzten vier Sprachphrasen beenden das aktuelle Sprachfenster. Leeres Drücken und Loslassen von `F9` sollte still enden; der Praxisbefund „Spracherkennung ist nicht aktiv“ ist ein bekannter kleiner UX-Fehler.

### Sicherheitsbestätigungen

Wenn die konfigurierte Sicherheitsstufe eine Bestätigung verlangt:

- „Bestätigen.“
- „Ja.“ / „Ja bitte.“ / „Okay.“ / „OK.“
- „Ich bestätige das.“
- „Du darfst das ausführen.“
- „Mach das.“ / „Führe die Aktion aus.“
- Im Textchat: `/confirm <Bestätigungs-ID>`.

Abbrechen:

- „Nein.“
- „Abbruch.“ / „Abbrechen.“ / „Stopp.“
- „Doch nicht.“ / „Lieber nicht.“
- „Lass es sein.“

Diese kurzen Antworten gelten nur, solange genau eine Sicherheitsbestätigung offen ist.

### Profil

- „Wie heiße ich?“
- „Wie ist mein Name?“
- „Was ist mein Name?“
- „Kennst du meinen Namen?“

### Kuratiertes Gedächtnis

Das kuratierte Gedächtnis ist technisch von zeitgesteuerten Erinnerungen getrennt.

Natürliche Speicherbefehle:

- „Merk dir: <Inhalt>.“
- „Behalte das: <Inhalt>.“
- „Speichere dir als Erinnerung: <Inhalt>.“

Technische Slash-Commands:

- `/anonymous` – Anonymous-Modus ein- oder ausschalten.
- `/anonymous <Nachricht>` – einzelne private Nachricht.
- `/showcontext` – kuratierte Erinnerungen einschließlich ausgeblendeter Einträge anzeigen.
- `/exportmemory` – kuratierte Erinnerungen als JSON ausgeben.
- `/remember <Inhalt>` – Inhalt ausdrücklich speichern.
- `/correctmemory <ID> <neuer Inhalt>` – Eintrag korrigieren.
- `/forget <ID>` – Eintrag ausblenden.
- `/deletememory <ID>` – Eintrag endgültig löschen.
- `/deletememory all` – Löschung aller kuratierten Einträge anfordern.
- `/deletememory all bestätigen` – angeforderte Gesamtlöschung bestätigen.
- `/deletememory all abbrechen` – angeforderte Gesamtlöschung abbrechen.
- `/confirm <ID>` – offene Sicherheitsaktion bestätigen.

`/quietmode` ist reserviert, aber noch nicht verfügbar. Zusätzlich können in den Einstellungen eigene Slash-Command-Makros angelegt sein; deren Namen und Inhalte sind installationsabhängig.

## Block 2: Fest programmierte Standardantworten

### Aktionsbestätigungen während der Ausführung

Programme, Suche und System:

- `Ich öffne <Programm>.`
- `Ich suche danach.`
- `Ich öffne das Ergebnis.`
- `Ich stelle die Systemlautstärke auf <Wert> Prozent.`
- `Ich sperre den Bildschirm.`

Spotify und Medien:

- `Ich stelle Spotify auf <Wert> Prozent.`
- `Ich mache Spotify etwas leiser.` / `Ich mache Spotify leiser.`
- `Ich mache Spotify etwas lauter.` / `Ich mache Spotify lauter.`
- `Ich pausiere die Wiedergabe.`
- `Ich starte die Wiedergabe.`
- `Ich wechsle den Wiedergabestatus.`
- `Ich springe zum nächsten Titel.`
- `Ich springe zum vorherigen Titel.`

Timer:

- `Ich stelle einen Timer auf <Dauer>.`
- `Ich stelle den <Bezeichnung>-Timer auf <Dauer>.`
- `Ich stelle den Timer.` – interner Fallback bei ungültigem Parameter.
- `Ich prüfe die laufenden Timer.`
- `Ich prüfe den <Bezeichnung>-Timer.`
- `Ich prüfe die Timer mit <Dauer> Laufzeit.`
- `Ich prüfe den Timer.` – interner Fallback.

Erinnerungen:

- `Ich speichere die Erinnerung.`
- `Ich prüfe die Erinnerung.` – interner Fallback.
- `Ich schaue nach den heutigen Erinnerungen.`
- `Ich schaue nach deinen offenen Erinnerungen.`
- `Ich prüfe alle offenen Erinnerungen.`
- `Ich prüfe die passende Erinnerung.`

### Timer-Ergebnisse und Meldungen

- `Dein <Bezeichnung>-Timer ist abgelaufen.`
- `Dein <Dauer>-Timer ist abgelaufen.`
- `Der <Bezeichnung>-Timer wurde abgebrochen.`
- `Der <Dauer>-Timer wurde abgebrochen.`
- `Der laufende Timer wurde abgebrochen.`
- `Alle laufenden Timer wurden abgebrochen.`
- `Es laufen keine Timer.`
- `Ich habe schon 5 Timer laufen.`
- `Die Timerdauer ist ungültig.`
- `Die Timerbezeichnung ist ungültig.`
- `Ich finde keinen laufenden <Bezeichnung-oder-Dauer>-Timer.`
- `Es laufen mehrere passende <Bezeichnung-oder-Dauer>-Timer. Ich habe keinen Timer abgebrochen.`
- `Diesen Timer kann ich nicht eindeutig zuordnen.`

### Erinnerungs-Ergebnisse und Meldungen

Erstellen und Auslösen:

- `Ich erinnere dich am <Tag>.<Monat>.<Jahr> um <HH:MM> Uhr: <Inhalt>.`
- `Erinnerung: <Inhalt>.`
- `Überfällige Erinnerung: <Inhalt>.`

Listen:

- `Heute stehen keine Erinnerungen an.`
- `Es gibt keine offenen Erinnerungen.`
- `Heute steht eine Erinnerung an. 1. <Datum und Uhrzeit>: <Inhalt>.`
- `Heute stehen <Anzahl> Erinnerungen an. 1. ... 2. ...`
- `Eine Erinnerung ist offen. 1. <Datum und Uhrzeit>: <Inhalt>.`
- `<Anzahl> Erinnerungen sind offen. 1. ... 2. ...`

Abbrechen und Auswählen:

- `Die Erinnerung „<Inhalt>“ wurde abgebrochen.`
- `Die Erinnerung wurde abgebrochen.`
- `Die offene Erinnerung wurde abgebrochen.`
- `Alle <Anzahl> offenen Erinnerungen wurden abgebrochen.`
- `<Anzahl> Erinnerungen wurden abgebrochen. <Anzahl> waren bereits fällig.`
- `Ich finde keine passende offene Erinnerung.`
- `Die passende Erinnerung ist bereits fällig und wird gerade ausgegeben.`
- `Es gibt mehrere passende Erinnerungen. Bitte nenne zusätzlich den Zeitpunkt, zum Beispiel: Die um 17:05 Uhr. <Liste>`
- `Es gibt keine Erinnerung mit der Nummer <Nummer> in dieser Auswahl.`
- `Zu dieser Uhrzeit finde ich unter den genannten Erinnerungen keine passende.`
- `Zu dieser Uhrzeit gibt es weiterhin mehrere passende Erinnerungen.`

Validierung und Verfügbarkeit:

- `Bitte nenne den vollständigen Erinnerungswunsch mit eindeutigem Zeitpunkt und Inhalt.`
- `Ich konnte den Inhalt der Erinnerung nicht eindeutig aus deiner Anfrage übernehmen. Bitte nenne Zeitpunkt und Inhalt noch einmal zusammen.`
- `Ich konnte den genannten Zeitpunkt nicht sicher zuordnen. Bitte nenne Zeitpunkt und Inhalt noch einmal zusammen.`
- `Der genannte Zeitpunkt liegt bereits in der Vergangenheit. Bitte nenne einen zukünftigen Zeitpunkt.`
- `Zeitpunkt und Inhalt der Erinnerung sind nicht eindeutig.`
- `Dieser Zeitpunkt liegt bereits in der Vergangenheit.`
- `Diese Erinnerung kann ich aus deiner Angabe nicht eindeutig zuordnen.`
- `Diese Erinnerung kann ich nicht eindeutig zuordnen.`
- `Dieser Erinnerungszeitpunkt ist nicht eindeutig.`
- `Diesen Zeitraum kann ich nicht auflisten.`
- `Persistente Erinnerungen sind gerade nicht verfügbar.`
- `Es sind bereits zu viele offene Erinnerungen gespeichert.`
- `Die Erinnerung kann ich gerade nicht speichern.`
- `Die Erinnerungsfunktion ist gerade nicht verfügbar.`

### Programmstart

- `Ich habe mehrere Treffer: <Programme>. Welches meinst du?`
- `Ich habe „<Programm>“ nicht gefunden. Meintest du <Vorschlag>?`
- `Der Eintrag für <Programm> zeigt auf einen Updater — ich starte den nicht.`
- `Der Eintrag für <Programm> hat widersprüchliche Startdaten — ich starte den nicht.`
- `Der Eintrag für <Programm> ist nicht verifiziert — ich starte den nicht.`
- `<Programm> ist am gespeicherten Ort nicht mehr verfügbar.`
- `Ich habe <Programm> zum Starten übergeben, konnte den Start aber nicht bestätigen.`
- `<Programm> ließ sich nicht starten — vielleicht ist die App nicht mehr installiert.`
- `<Programm> ließ sich nicht starten.`

Bei einem nachweislich erfolgreichen Programmstart folgt derzeit keine zusätzliche Erfolgsantwort nach `Ich öffne <Programm>.`.

### Suche und Browser

- `Ich habe keine passenden Suchergebnisse gefunden.`
- `Ich habe <Anzahl> Ergebnis/Ergebnisse gefunden. 1: „<Titel>“; 2: „<Titel>“ ...`
- `Moment, ich suche gerade noch.`
- `Ich habe gerade keine Suchergebnisse offen.`
- `So viele Ergebnisse habe ich nicht — es sind <Anzahl>.`
- `Dazu habe ich kein passendes Ergebnis.`
- `Meinst du <Titel> oder <Titel>?`
- `Die Seite ließ sich nicht öffnen.`
- `Meine Suche klemmt gerade.`
- `Der Browserzugriff ist in den Einstellungen deaktiviert.`

Je nach Suchpfad kann die Ergebniszusammenfassung durch ein separates Modell formuliert werden und ist dann keine feste Standardantwort.

### Medien und Spotify

- `Ich sehe gerade keine laufende Wiedergabe.`
- `Ich finde gerade keine passende Wiedergabe.`
- `Das kann der aktuelle Player nicht.`
- `Das hat gerade nicht geklappt.`
- `Das unterstützt dein System nicht.`
- `Verbinde Spotify zuerst in den Einstellungen.`
- `Spotify ist gerade nicht erreichbar. Die Verbindung bleibt gespeichert; versuche es bitte später erneut.`
- `Ich sehe gerade kein aktives Spotify-Gerät.`
- `Bitte verbinde Spotify neu.`
- `Dafür brauchst du Spotify Premium.`
- `Das hat bei Spotify gerade nicht geklappt.`

### Sicherheitsbestätigungen und Berechtigungen

- `Soll ich <Aktionsbeschreibung>? Sage oder schreibe „Bestätigen“ oder „Abbrechen“. Alternativ im Textchat: /confirm <ID>`
- `Diese Bestätigung ist ungültig oder abgelaufen.`
- `Die Sprachbestätigung ist nicht eindeutig oder bereits abgelaufen. Nutze im Textchat die konkrete /confirm-ID.`
- `Die Aktion wurde abgebrochen.`
- `Es ist keine eindeutige Aktion zum Abbrechen offen.`
- `Diese Bestätigung ist ungültig.`
- `Diese Aktion wurde nicht bestätigt.`
- `Diese Aktion ist durch deine Berechtigungen gesperrt.`
- `Ich kann diese Aktion nur vorbereiten, aber nicht verbindlich ausführen.`

### Sprach- und Laufzeitmeldungen

- `Sarah ist noch nicht bereit oder der Router ist nicht verfügbar.`
- `Auf meine tieferen Gedanken kann ich gerade nicht zugreifen. Einfache Befehle funktionieren weiterhin.`
- `Meine Spracherkennung ist gerade nicht verfügbar. Du kannst mir weiterhin im Chat schreiben.`
- `Meine Sprachausgabe ist gerade nicht verfügbar. Textantworten und Spracheingabe funktionieren weiterhin.`
- `Das Mikrofon wird noch vorbereitet. Bitte versuche es gleich noch einmal.`
- `Die Spracherkennung hat zu lange gebraucht. Bitte versuche es erneut.`
- `Die Spracheingabe konnte nicht verarbeitet werden.`
- `Aktionen sind gerade nicht verfügbar. Bitte versuche es gleich noch einmal.`
- `Sarah träumt noch... Einen Moment.`
- `Sarah hat den Faden verloren... Versuch es nochmal.`
- `Sarah ist kurz weggedriftet. Einen Moment...`
- `Das kann ich noch nicht.`
- `Die Anfrage ist fehlgeschlagen.`
- `Zu viele Anfragen gleichzeitig. Bitte warte kurz.`
- `Die Lautstärke ließ sich nicht ändern.`
- `Das Sperren hat nicht geklappt.`
- `Speichern nicht möglich — diese Unterhaltung wird nach einem Neustart vergessen.`

### Aktive Füllsätze bei Modellwechseln

Beim Wechsel zu einer ausführlichen Antwort wird zufällig einer dieser Sätze verwendet:

- `Das schaue ich mir genauer an.`
- `Einen Moment, ich gehe etwas tiefer darauf ein.`
- `Lass mich das kurz durchdenken.`
- `Das ist eine interessante Frage.`
- `Ich beschäftige mich kurz damit.`
- `Lass mich eine vernünftige Antwort darauf vorbereiten.`
- `Einen Augenblick, ich ordne das kurz.`
- `Ich sehe mir das etwas genauer an.`
- `Da lohnt sich ein genauerer Blick.`
- `Moment, ich denke das einmal sauber durch.`

Beim Wechsel zurück zum Befehlsrouter:

- `Einen Moment.`
- `Sofort.`
- `Mach ich gleich.`

Der generische Fallback lautet `Einen Moment bitte.`

Weitere im Code vorbereitete, aber derzeit nicht aktiv verdrahtete Füllsatzgruppen existieren für Hintergrundaufgaben, Deep Search, Programmstart, Speicherabruf und Aufgabenabschluss. Sie sind hier nicht als aktive Standardantworten aufgeführt.

### Profil, Datenschutz und kuratiertes Gedächtnis

Profil:

- `Du heißt <Name>.`
- `Du hast mir noch keinen Namen genannt.`

Anonymous-Modus:

- `Anonymous-Modus aktiviert. Dieser Abschnitt wird nicht gespeichert. Mit /anonymous beendest du ihn wieder.`
- `Anonymous-Modus beendet. Der private Abschnitt wurde verworfen.`
- `Der Anonymous-Modus ist in den Einstellungen deaktiviert.`
- `Im Anonymous-Modus kann ich mir nichts merken. Beende ihn zuerst mit /anonymous und wiederhole dann, was ich speichern soll.`
- `In einer privaten Nachricht kann ich mir nichts merken. Wiederhole das bitte außerhalb von /anonymous.`
- `Im Anonymous-Modus kann ich Erinnerungen weder anzeigen noch verändern. Beende ihn zuerst mit /anonymous.`

Gedächtnis:

- `Erinnerung <ID> wurde gespeichert.`
- `Das kann ich nicht als Erinnerung speichern.`
- `Das kann ich nicht als Erinnerung speichern. Prüfe den Inhalt oder verlasse den Anonymous-Modus.`
- `Erinnerung <ID> wurde aktualisiert.`
- `Erinnerung <ID> wurde nicht gefunden oder konnte nicht geändert werden.`
- `Bitte gib eine gültige Erinnerungs-ID an.`
- `Ich habe derzeit keine kuratierten Erinnerungen gespeichert.`
- `Es sind keine kuratierten Erinnerungen gespeichert.`
- `Das Gedächtnis ist in den Einstellungen deaktiviert.`
- `Das Gedächtnis ist wegen eines Speicherfehlers vorübergehend gesperrt.`
- `Eine Erinnerung konnte diesmal nicht aufbereitet werden. Die verschlüsselten Ausgangsdaten bleiben für einen späteren Versuch erhalten.`
- `/showcontext ist in den Einstellungen deaktiviert.`
- `/exportmemory ist in den Einstellungen deaktiviert.`
- `Alle <Anzahl> kuratierten Erinnerungen endgültig löschen? Bestätige mit /deletememory all bestätigen oder brich mit /deletememory all abbrechen ab.`
- `Das Löschen aller Erinnerungen wurde abgebrochen.`
- `<Anzahl> kuratierte Erinnerung wurde endgültig gelöscht.` / `<Anzahl> kuratierte Erinnerungen wurden endgültig gelöscht.`
- `Es gibt keine gültige Löschanfrage. Starte sie erneut mit /deletememory all.`
- `Die Erinnerungen haben sich seit der Anfrage geändert. Es wurde nichts gelöscht. Starte /deletememory all erneut.`
- `Nutze /deletememory all, danach /deletememory all bestätigen oder /deletememory all abbrechen.`

Slash-Commands:

- `Der Slash-Command <Command> ist noch nicht verfügbar.`
- `Diesen Slash-Command kenne ich nicht: <Command>.`

## Hinweise für die spätere Sprach- und Textüberarbeitung

- Datum und Uhrzeit werden aktuell als `<Tag>.<Monat>.<Jahr> um <HH:MM> Uhr` formatiert. Diese Schreibweise ist visuell klar, wird von der aktuellen TTS-Stimme aber nicht immer natürlich ausgesprochen.
- Listen verwenden Ziffern (`1.`, `2.`), Datumszahlen und die Schreibweise `17:05`. Vor einem Wechsel auf Woka sollte geprüft werden, ob eine getrennte Anzeige- und Sprechfassung sinnvoller ist.
- Zusammengesetzte Timerbezeichnungen wie `<Bezeichnung>-Timer` können bei langen Inhalten unnatürlich klingen.
- Mehrere Antworten verwenden derzeit technische oder defensive Formulierungen wie `Das kann ich noch nicht.`. Diese sollten später kontextbezogener werden, ohne Sicherheitsgrenzen zu verwässern.
- Kuratiertes Gedächtnis und zeitgesteuerte Erinnerungen verwenden beide das deutsche Wort „Erinnerung“. In einer späteren UI-/Sprachüberarbeitung sollte diese begriffliche Doppelbelegung geprüft werden.
