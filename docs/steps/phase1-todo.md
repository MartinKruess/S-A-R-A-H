# Sarah – Phase 1: Desktop V1

**Status-Legende**

- 🔴 Fehlt oder ist für den aktuellen Prototyp noch nicht abnahmefähig
- 🟢 Für den aktuellen Prototyp ausreichend und im Code oder praktisch bestätigt
- 🟡 Vorhanden, aber mit relevanten Lücken, unzuverlässig oder noch praktisch zu bestätigen
- ⚪ Bewusst später / aktuell nicht im Scope

**Aktueller Zählstand nach der abgeschlossenen Layer-0/1-Windows-Matrix:** 704 Prüfpunkte — 167 🟢, 77 🟡, 443 🔴, 17 ⚪

---

# 1. Kernsystem & Gespräch

## 1.1 Start, Betrieb und Routing

- 🟢 Sarah startet zuverlässig.
- 🟢 Sarah beendet sich zuverlässig.
- 🟢 Der Router startet zuverlässig.
- 🟢 Der Router bleibt als leichtgewichtige Instanz dauerhaft verfügbar.
- 🟢 Der Router erkennt einfache Befehle, die ohne großes LLM ausgeführt werden können.
- 🟢 Der Router erkennt Anfragen, die das große LLM benötigen.
- 🟡 Der Router erkennt Research-Anfragen.
- 🟡 Der Router kann benutzerdefinierte Slash-Commands deterministisch vor dem Modellrouting auflösen; die praktische Abnahme fehlt noch.
- 🟢 Das große LLM wird nur bei Bedarf gestartet.
- 🟢 Das kleine Modell bzw. der Router wird beim Start des großen Modells korrekt behandelt.
- 🟢 Das große Modell bleibt nach einer Anfrage für einen definierten Zeitraum aktiv, damit Folgefragen ohne erneute Ladezeit möglich sind.
- 🟢 Bei einfachen Befehlen kann das große Modell wieder beendet werden.
- 🟢 Modellwechsel funktionieren zuverlässig.
- 🟢 Modellstart und Modellshutdown blockieren keine neuen Anfragen dauerhaft.
- 🟢 Zustände wie „startet“, „bereit“, „fährt herunter“, „nicht verfügbar“ werden korrekt erkannt.

## 1.2 Spracheingabe

- 🟢 Push-to-Talk über F9 funktioniert zuverlässig.
- 🟢 Sprachaufnahme startet zuverlässig.
- 🟢 Sprachaufnahme endet zuverlässig.
- 🟢 STT verarbeitet Sprache zuverlässig.
- 🟡 Leere oder unverständliche Aufnahmen werden erkannt.
- 🔴 Störgeräusche führen nicht zu unsinnigen Aktionen.
- 🟢 Das gewünschte Mikrofon kann ausgewählt werden.
- 🟢 Das System-Standardmikrofon kann verwendet werden.
- 🟢 Ein explizit für Sarah festgelegtes Mikrofon kann verwendet werden.

## 1.3 Sprachausgabe

- 🟢 TTS funktioniert zuverlässig.
- 🟢 Das gewünschte Ausgabegerät kann ausgewählt werden.
- 🟢 Das System-Standardausgabegerät kann verwendet werden.
- 🟢 Textantworten funktionieren weiterhin, wenn TTS ausfällt.
- 🟢 TTS besitzt einen Timeout.
- 🟢 TTS kann nach einem Fehler erneut angesprochen werden.
- 🟢 Ein festhängender TTS-Prozess kann erkannt werden.
- 🟢 TTS kann automatisiert neu gestartet werden.
- 🟢 Ein späterer TTS-Fallback ist technisch vorgesehen.

## 1.4 Gespräch

- 🟢 Folgefragen funktionieren ohne erneute vollständige Initialisierung.
- 🟢 Sarah erkennt den Kontext vorheriger Nachrichten innerhalb einer Session.
- 🟢 Sarah lässt sich während ihrer Sprachausgabe zuverlässig unterbrechen.
- 🟢 Nach einer Unterbrechung kann das Gespräch normal fortgesetzt werden.
- 🟢 Sarah antwortet standardmäßig in natürlicher Gesprächssprache.
- 🟢 Sarah duzt den Nutzer standardmäßig.
- ⚪ Eine frei konfigurierbare Ansprache mit Du oder Sie ist für Desktop V1 bewusst nicht vorgesehen; formelle Ansprache kann später über einen Persona-Modus erfolgen.
- 🟢 Ein benutzerdefinierter Name, mit dem Sarah den Nutzer ansprechen soll, kann hinterlegt werden.
- 🟢 Nutzerpräferenzen beeinflussen Antworten sinnvoll.
- 🟡 Hobbys und Interessen werden nur verwendet, wenn sie tatsächlich relevant sind.
- 🟡 Sarah wiederholt Profilinformationen nicht unnötig.
- 🟢 Antwortlänge kann konfiguriert werden.
- 🟢 Antwortpräzision bzw. Detailgrad kann konfiguriert werden.

## 1.5 Wake-Word und Gesprächsmodus

- 🟢 Ein Wake-Word-System ist technisch vorgesehen.
- 🔴 Das Wake-Word kann aktiviert und deaktiviert werden.
- 🟡 Das Wake-Word ist nicht fest auf „Sarah“ beschränkt.
- 🔴 Alternative Wake-Words können ausgewählt oder definiert werden.
- 🔴 Nach dem Wake-Word beginnt ein Gesprächsmodus.
- 🔴 Folgefragen benötigen innerhalb eines laufenden Gesprächs kein erneutes Wake-Word.
- 🔴 Der Gesprächsmodus kann automatisch oder explizit beendet werden.
- 🔴 Gespräche im Raum, die nicht an Sarah gerichtet sind, werden möglichst nicht als Befehle interpretiert.

---

# 2. Memory, Kontext & Nutzerprofil

## 2.1 Einrichtungsassistent

- 🟢 Ein Einrichtungsassistent ist vorhanden.
- 🟢 Der Nutzername kann hinterlegt werden.
- 🟢 Hobbys können hinterlegt werden.
- 🟢 Interessen können hinterlegt werden.
- 🟡 aktuelle Projekte können hinterlegt werden.
- 🟢 Projektpfade können hinterlegt werden.
- 🟡 wichtige Dokumentpfade können hinterlegt werden.
- 🟢 Spielepfade können hinterlegt werden.
- 🟡 weitere semantische Speicherorte können hinterlegt werden.
- 🔴 feste Termine können hinterlegt werden.
- 🟢 bevorzugte Antwortweise kann hinterlegt werden.
- 🟢 Sarah scannt installierte Programme.
- 🟢 Der Nutzer kann auswählen, welche Programme Sarah verwalten soll.
- 🟢 erkannte Programmpfade werden gespeichert.
- 🟡 relevante Prozessnamen oder Startinformationen werden gespeichert.
- 🟢 Einstellungen können später geändert werden.

## 2.2 Langzeitgedächtnis

- 🟡 Sarah besitzt persistentes Langzeitgedächtnis.
- 🟢 relevante Nutzerinformationen können langfristig gespeichert werden.
- 🟢 Präferenzen können langfristig gespeichert werden.
- 🟡 Projekte können langfristig gespeichert werden.
- 🟡 relevante frühere Gesprächsinhalte können gespeichert werden.
- 🔴 frühere Entscheidungen können später wiedergefunden werden.
- 🟡 Sarah kann nach einem Neustart auf relevante Erinnerungen zugreifen.
- 🟡 gespeicherte Informationen beeinflussen neue Gespräche nur dann, wenn sie relevant sind.
- 🟢 temporäre Situationen verändern das Langzeitprofil nicht unnötig.
- 🟡 der Nutzer kann abfragen, was Sarah über ihn gespeichert hat.
- 🔴 einzelne Erinnerungen können gelöscht werden.
- 🔴 einzelne Erinnerungen können korrigiert werden.
- 🔴 das gesamte Langzeitgedächtnis kann verwaltet werden.

## 2.3 Session-Memory

- 🟢 Sarah besitzt ein separates Session-Gedächtnis.
- 🟢 Gesprächsinhalte bleiben während einer laufenden Session verfügbar.
- 🔴 Session-Informationen werden nicht automatisch vollständig ins Langzeitgedächtnis übernommen.
- 🔴 relevante Informationen können selektiv ins Langzeitgedächtnis übernommen werden.

## 2.4 Inkognito-/Nicht-speichern-Modus

- 🔴 Ein Inkognito-/Nicht-speichern-Modus existiert.
- 🔴 Gespräche im Inkognito-Modus besitzen temporären Kontext.
- 🔴 Inhalte aus dem Inkognito-Modus werden nicht ins Langzeitgedächtnis geschrieben.
- 🔴 bestehendes Langzeitgedächtnis kann weiterhin verwendet werden, sofern gewünscht.
- 🔴 der Nutzer kann explizit einzelne Informationen trotz Inkognito-Modus dauerhaft speichern lassen.
- 🔴 das Beenden des Inkognito-Modus löscht den temporären Kontext entsprechend der vorgesehenen Regeln.

## 2.5 Memory-Hygiene

- 🔴 Sarah unterscheidet möglichst zwischen dauerhaften Nutzerpräferenzen und kurzfristigen Zuständen.
- 🔴 wiederholtes Verhalten kann als mögliche Präferenz erkannt werden.
- 🟡 aus wenigen zufälligen Aktionen wird nicht automatisch eine dauerhafte Regel erstellt.
- 🔴 Sarah kann vorgeschlagene neue Gewohnheiten zur Bestätigung vorlegen.
- 🔴 bestätigte Gewohnheiten können künftig automatisch angewendet werden.
- 🔴 bestätigte Gewohnheiten können später geändert oder gelöscht werden.

---

# 3. Security & Berechtigungen

## 3.1 Grundprinzip

- 🟡 Sicherheitsregeln werden technisch außerhalb des eigentlichen LLM-Prompts erzwungen.
- 🟡 das LLM kann Sicherheitsregeln nicht durch eigene Tool-Aufrufe umgehen.
- 🟡 externe Inhalte können Sicherheitsregeln nicht überschreiben.
- 🔴 Aktionen werden anhand ihrer Risikoklasse bewertet.
- 🔴 Lesen, Verändern und verbindliche Aktionen werden voneinander unterschieden.

## 3.2 Grüne Aktionen – Lesen und ungefährliche Bedienung

- 🟢 Programme dürfen ohne Bestätigung geöffnet werden.
- 🟢 Informationen dürfen gesucht werden.
- 🔴 Dateien dürfen gelesen werden.
- 🟢 Webseiten dürfen gelesen werden.
- 🟢 Systeminformationen dürfen gelesen werden.
- ⚪ Kalenderinformationen dürfen später gelesen werden.
- 🟡 ungefährliche Statusabfragen benötigen keine unnötige Bestätigung.

## 3.3 Gelbe Aktionen – Veränderungen

- 🔴 Dateien umbenennen wird als verändernde Aktion behandelt.
- 🔴 Dateien verschieben wird als verändernde Aktion behandelt.
- 🔴 Dateien kopieren wird korrekt behandelt.
- 🔴 Ordner erstellen wird korrekt behandelt.
- 🔴 Formulare ausfüllen wird von finalem Absenden getrennt.
- 🔴 Termine vorbereiten wird vom finalen Speichern bzw. Versenden getrennt.
- 🟡 Inhalte können vorbereitet werden, ohne dass dadurch automatisch eine externe Aktion ausgelöst wird.

## 3.4 Rote Aktionen – verbindlich oder extern

- 🔴 E-Mails werden niemals ohne explizite finale Freigabe gesendet.
- 🔴 Nachrichten werden niemals ohne explizite finale Freigabe gesendet.
- 🔴 Käufe benötigen eine finale Bestätigung.
- 🔴 Buchungen benötigen eine finale Bestätigung.
- 🔴 Kündigungen benötigen eine finale Bestätigung.
- 🔴 Registrierungen benötigen eine finale Bestätigung.
- 🔴 Überweisungen benötigen eine finale Bestätigung.
- 🔴 kostenpflichtige Aktionen benötigen eine finale Bestätigung.
- 🟡 die finale Bestätigung ist technisch einer konkreten Action samt validiertem Parameter zugeordnet; vollständige Risikoklassen und Praxisabnahme fehlen noch.
- 🔴 eine frühere allgemeine Aussage wie „klingt gut“ gilt nicht als finale Freigabe.
- 🔴 vor einer finalen Freigabe zeigt Sarah Preis, Leistung und relevante Zusatzkosten.
- 🔴 eine zeitversetzte verbindliche Aktion benötigt eine explizite Beauftragung mit Zeitpunkt.

## 3.5 Secrets und sensible Daten

- 🔴 Passwörter werden niemals dauerhaft gespeichert.
- 🔴 PINs werden niemals dauerhaft gespeichert.
- 🔴 Zahlungsdaten werden niemals dauerhaft gespeichert.
- 🔴 hochsensible Identifikationsdaten werden nicht unnötig gespeichert.
- 🔴 Sarah fordert sensible Daten nur dann an, wenn sie tatsächlich benötigt werden.
- 🔴 sensible Daten können einmalig verwendet werden, ohne ins Memory zu gelangen.
- 🔴 bereits bei einem externen Dienst hinterlegte Zahlungsdaten können genutzt werden, ohne dass Sarah deren Werte ausliest oder speichert.
- 🟡 bereits hinterlegte Login-Sessions können genutzt werden.
- 🔴 Sarah lehnt explizite Aufforderungen ab, bekannte Passwörter dauerhaft zu speichern.

## 3.6 Löschen

- 🔴 normales Löschen bedeutet standardmäßig „in den Papierkorb verschieben“.
- 🔴 normales Löschen wird nicht automatisch zu endgültigem Löschen.
- 🔴 endgültiges Löschen wird als eigene Aktion behandelt.
- 🔴 Papierkorb leeren wird als eigene Aktion behandelt.
- 🔴 endgültiges Löschen benötigt eine explizite Bestätigung.
- 🔴 Sarah kann Löschkandidaten zunächst nur vorsortieren.
- 🔴 der Nutzer kann Löschkandidaten prüfen, bevor etwas gelöscht wird.
- 🔴 nach dem Löschen kann Sarah prüfen, ob die Aktion erfolgreich war.

## 3.7 Audit und Nachvollziehbarkeit

- 🟡 relevante Aktionen werden protokolliert.
- 🔴 sicherheitsrelevante Aktionen werden protokolliert.
- 🟡 Bestätigungen werden technisch mit der jeweiligen Aktion verknüpft; eine vollständige persistente und nutzerseitig einsehbare Auditspur fehlt noch.
- 🟡 Fehler und fehlgeschlagene Aktionen werden protokolliert.
- 🔴 der Nutzer kann nachvollziehen, was Sarah wann ausgeführt hat.

---

# 4. Dateisystem & Storage

## 4.1 Basisfunktionen

- 🔴 Dateien suchen.
- 🔴 Ordner suchen.
- 🔴 Dateien öffnen.
- 🔴 Ordner öffnen.
- 🔴 Dateien erstellen.
- 🔴 Ordner erstellen.
- 🔴 Dateien kopieren.
- 🔴 Dateien verschieben.
- 🔴 Dateien umbenennen.
- 🔴 Dateien in den Papierkorb verschieben.
- 🔴 Dateien nach Bestätigung endgültig löschen.
- 🔴 mehrere Dateien gesammelt bearbeiten.
- 🔴 Aktionen nach Ausführung überprüfen.

## 4.2 Semantische Speicherorte

- 🟢 Sarah kennt den Speicherort für Dokumente.
- 🟢 Sarah kennt den Speicherort für Projekte.
- 🟢 Sarah kennt den Speicherort für Spiele.
- 🟢 Sarah kann Speicherorte für Bilder kennen.
- 🔴 Sarah kann Speicherorte für Videos kennen.
- 🔴 Sarah kann Speicherorte für Musik kennen.
- 🟡 Sarah kann weitere nutzerdefinierte Kategorien kennen.
- 🟢 Sarah arbeitet intern mit Kategorien statt mit fest codierten Windows-Pfaden.
- 🟢 Speicherorte können jederzeit geändert werden.
- 🟢 unterschiedliche Laufwerke und Partitionen werden unterstützt.

## 4.3 Dateiverständnis

- 🔴 Dokumente werden erkannt.
- 🔴 PDFs werden erkannt.
- 🔴 Tabellen werden erkannt.
- 🔴 Präsentationen werden erkannt.
- 🔴 Bilder werden erkannt.
- 🔴 Videos werden erkannt.
- 🔴 Audiodateien werden erkannt.
- 🔴 Archive werden erkannt.
- 🟡 Installationsdateien werden erkannt.
- 🟢 Programmdateien werden erkannt.
- 🔴 unbekannte Dateitypen werden nicht blind verändert.

## 4.4 Standardprogramme

- 🔴 Sarah kann erkennen, welches Standardprogramm für einen Dateityp vorgesehen ist.
- 🔴 PDFs können mit dem vorgesehenen PDF-Programm geöffnet werden.
- 🔴 Office-Dateien können mit dem vorgesehenen Office-Programm geöffnet werden.
- 🔴 Bilder können mit dem vorgesehenen Bildprogramm geöffnet werden.
- 🔴 Videos können mit dem vorgesehenen Videoplayer geöffnet werden.
- 🔴 der Nutzer kann bei Bedarf „Öffnen mit …“ verwenden.
- 🔴 alternative Programme können berücksichtigt werden.

## 4.5 Versionen und Dubletten

- 🔴 ähnliche Dateinamen können als mögliche Versionen erkannt werden.
- 🟡 Versionsnummern können ausgewertet werden.
- 🟡 höhere Versionsnummern werden grundsätzlich als neuer erkannt.
- 🔴 Datumsangaben in Dateinamen können berücksichtigt werden.
- 🔴 Dubletten können erkannt werden.
- 🔴 wahrscheinlich veraltete Versionen werden als Löschkandidaten markiert.
- 🔴 ältere Versionen werden nicht automatisch endgültig gelöscht.
- 🔴 bei Unsicherheit fragt Sarah nach.

## 4.6 Installer und Softwareversionen

- 🟡 Installationsdateien können erkannt werden.
- 🔴 Sarah kann prüfen, ob die zugehörige Software installiert ist.
- 🔴 Sarah kann möglichst die installierte Version ermitteln.
- 🔴 Sarah kann die Version des Installers ermitteln.
- 🔴 ältere Installer können als Löschkandidaten erkannt werden.
- 🔴 Installer für noch nicht installierte Software werden nicht automatisch gelöscht.
- 🔴 neue oder unklare Installer werden separat behandelt.

## 4.7 Downloads-Ordner intelligent aufräumen

- 🔴 Sarah kann den Downloads-Ordner vollständig analysieren.
- 🔴 Dateien werden kategorisiert.
- 🔴 bekannte Zielpfade werden berücksichtigt.
- 🔴 eindeutige Dateien können selbstständig vorsortiert werden.
- 🔴 bekannte Nutzerregeln werden berücksichtigt.
- 🔴 Dokumente können in den Dokumentbereich verschoben werden.
- 🔴 Bilder können in den Bildbereich verschoben werden.
- 🔴 Videos können in den Videobereich verschoben werden.
- 🔴 Musik kann in den Musikbereich verschoben werden.
- 🔴 Installer werden separat bewertet.
- 🔴 alte Versionen werden erkannt.
- 🔴 Dubletten werden erkannt.
- 🔴 Löschkandidaten werden separat gesammelt.
- 🔴 unsichere Dateien werden nicht blind verändert.
- 🔴 Sarah erstellt am Ende eine Zusammenfassung.
- 🔴 Sarah fragt nur bei tatsächlich unsicheren oder sicherheitsrelevanten Fällen nach.
- 🔴 endgültiges Löschen erfolgt erst nach Freigabe.

## 4.8 Komprimierung

- 🔴 Sarah kann erkennen, welche Dateitypen sinnvoll komprimiert werden können.
- 🔴 Videos können nach definierter Regel komprimiert werden.
- 🔴 Bilder können nach definierter Regel komprimiert werden.
- 🔴 Audiodateien können nach definierter Regel komprimiert werden.
- 🔴 bereits ausreichend komprimierte Dateien werden nicht unnötig neu komprimiert.
- 🔴 Dokumente werden nicht automatisch sinnlos komprimiert.
- 🔴 Qualitätsverlust wird berücksichtigt.
- 🔴 Komprimierungsregeln können vom Nutzer definiert werden.
- 🔴 wiederkehrende Komprimierungsregeln können gespeichert werden.
- 🔴 Sarah prüft nach der Komprimierung, ob die neue Datei korrekt erstellt wurde.
- 🔴 Originaldateien werden erst nach erfolgreicher Prüfung entsprechend der Sicherheitsregeln behandelt.

## 4.9 Bildklassifikation

- 🔴 Sarah kann Bilder inhaltlich grob verstehen.
- 🔴 Familienfotos können von Memes und sonstigen Bildern unterschieden werden.
- 🔴 Bilder können anhand ihres Inhalts vorsortiert werden.
- 🔴 unsichere Bilder werden nicht automatisch gelöscht.
- 🔴 mögliche Löschbilder können in einen Prüf-Ordner verschoben werden.
- 🔴 der Nutzer kann den Prüf-Ordner kontrollieren.
- 🔴 erst nach Freigabe werden die ausgewählten Bilder gelöscht.

---

# 5. Programme & Betriebssystem

## 5.1 Programmverwaltung

- 🟢 installierte Programme können erkannt werden.
- 🟢 Programme können gestartet werden.
- 🔴 Programme können geschlossen werden.
- 🟡 Sarah erkennt, wenn ein Programm nicht installiert ist.
- 🔴 Sarah erkennt, wenn ein Programm bereits läuft.
- 🔴 Sarah erkennt, wenn ein Programm nicht läuft.
- 🟢 Startpfade werden aus dem Einrichtungsassistenten verwendet.
- 🟡 Prozessnamen werden korrekt zugeordnet.
- 🟢 Programme können anhand natürlicher Namen angesprochen werden.
- 🟢 Programm-Aliase können berücksichtigt werden.

## 5.2 Laufende Anwendungen

- 🔴 Sarah kann alle aktuell laufenden relevanten Programme auflisten.
- 🔴 Sarah kann erkennen, welches Fenster aktiv ist.
- 🔴 Sarah kann erkennen, welche Anwendung im Vordergrund ist.
- 🔴 Sarah kann relevante Hintergrundprozesse erkennen.
- 🔴 Sarah kann erkennen, wenn eine Anwendung hängt.
- 🔴 Sarah kann nach Freigabe einen festhängenden Prozess beenden.
- 🔴 Sarah prüft nach dem Beenden, ob der Prozess tatsächlich geschlossen wurde.

## 5.3 Systemressourcen

- 🟢 CPU-Auslastung kann gelesen werden.
- 🟢 RAM-Auslastung kann gelesen werden.
- 🟢 GPU-Auslastung kann gelesen werden.
- 🔴 Sarah-spezifischer Ressourcenverbrauch kann angezeigt werden.
- 🔴 durchschnittliche Antwortzeiten können erfasst werden.
- 🔴 Performance-Probleme können mit Ressourcenverbrauch in Zusammenhang gebracht werden.
- 🔴 Speicherplatz kann analysiert werden.
- 🔴 besonders volle Laufwerke können erkannt werden.
- 🔴 große Speicherverbraucher können identifiziert werden.

## 5.4 Netzwerk

- 🔴 Netzwerkstatus kann geprüft werden.
- 🔴 Internetverbindung kann geprüft werden.
- 🔴 Verbindung zum Router kann geprüft werden.
- 🔴 lokales Netzwerk und Internet können voneinander unterschieden werden.
- 🔴 Sarah kann erkennen, ob nur ein externer Dienst oder das gesamte Internet ausgefallen ist.
- 🔴 Netzwerkprobleme können verständlich zusammengefasst werden.
- ⚪ eine spätere automatische Problemanalyse ist vorgesehen.

## 5.5 Geräte

- 🟢 Eingabegeräte können erkannt werden.
- 🟢 Ausgabegeräte können erkannt werden.
- 🟢 Mikrofone können ausgewählt werden.
- 🟢 Audiogeräte können ausgewählt werden.
- ⚪ angeschlossene Geräte können später aufgelistet werden.
- ⚪ Bluetooth-Status kann später erkannt werden.
- ⚪ Laptop-Akkustatus kann später erkannt werden.

---

# 6. Programmintegrationen

## 6.1 Allgemeines Integrationsmodell

- 🟢 Programme können über API angesprochen werden, wenn eine geeignete API vorhanden ist.
- 🟡 Programme können über Betriebssystem- oder UI-Automation angesprochen werden, wenn keine API vorhanden ist.
- 🟡 Sarah bevorzugt stabile APIs gegenüber Maus-/Tastatur-Simulation.
- 🔴 UI-Automation besitzt eigene Sicherheitsgrenzen.
- 🟢 programmbezogene Fähigkeiten können modular ergänzt werden.
- 🟢 nicht jede Anwendung muss individuell im Kernsystem fest codiert werden.

## 6.2 Spotify

- 🟢 Spotify kann gestartet werden.
- 🟢 Wiedergabe kann gestartet werden.
- 🟢 Wiedergabe kann pausiert bzw. beendet werden.
- 🟢 nächster Titel funktioniert.
- 🟢 vorheriger Titel funktioniert.
- 🟢 Lautstärke kann erhöht werden.
- 🟢 Lautstärke kann reduziert werden.
- 🟢 konkrete Prozentwerte können verstanden werden.
- 🟡 natürliche Abstufungen wie „etwas lauter“ und „lauter“ werden zuverlässig unterschieden.
- 🟡 natürliche Abstufungen besitzen feste reproduzierbare Werte.
- 🟢 Lautstärkegrenzen werden eingehalten.
- 🟢 Fehler der Spotify-API werden erkannt.
- 🟢 Sarah meldet verständlich, wenn Spotify nicht erreichbar ist.
- ⚪ gezielte Playlist-Auswahl ist später möglich.
- ⚪ gezielte Titel-Auswahl ist später möglich.
- ⚪ komplexe Spotify-Navigation ist keine Voraussetzung für Desktop V1.

## 6.3 Referenzprogramme

Sarah Desktop V1 soll einen definierten Satz verbreiteter Programme auf grundlegender Ebene bedienen können.

- 🟡 Browser.
- 🔴 Word oder Writer.
- 🔴 Excel oder Calc.
- 🔴 PowerPoint oder Impress.
- 🔴 PDF-Reader.
- 🔴 VS Code.
- 🔴 Dateimanager.
- 🔴 Mailprogramm bzw. Mailintegration.
- 🟢 Mediaplayer.
- 🔴 einfacher Texteditor.

---

# 7. Office-Bedienung

## 7.1 Word / Writer

- 🔴 neues Dokument erstellen.
- 🔴 vorhandenes Dokument öffnen.
- 🔴 Text einfügen.
- 🔴 Text ergänzen.
- 🔴 Text ersetzen.
- 🔴 Überschriften erstellen.
- 🔴 Absätze strukturieren.
- 🔴 fett formatieren.
- 🔴 kursiv formatieren.
- 🔴 Listen erstellen.
- 🔴 einfache Tabellen erstellen.
- 🔴 grundlegende Seitenstruktur erzeugen.
- 🔴 Dokument speichern.
- 🔴 unter neuem Namen speichern.
- 🔴 als PDF exportieren.
- 🔴 drucken.
- 🔴 nach der Aktion prüfen, ob die Datei erfolgreich erstellt wurde.

## 7.2 Excel / Calc

- 🔴 neue Tabelle erstellen.
- 🔴 bestehende Tabelle öffnen.
- 🔴 Daten eintragen.
- 🔴 Daten ändern.
- 🔴 Zeilen und Spalten verstehen.
- 🔴 grundlegende Formatierung durchführen.
- 🔴 einfache Formeln erstellen.
- 🔴 einfache Summen berechnen.
- 🔴 Daten sortieren.
- 🔴 Daten filtern.
- 🔴 Tabelle speichern.
- 🔴 Tabelle exportieren.
- 🔴 grundlegende Druck- oder PDF-Ausgabe ermöglichen.

## 7.3 PowerPoint / Impress

- 🔴 neue Präsentation erstellen.
- 🔴 bestehende Präsentation öffnen.
- 🔴 Titelfolie erstellen.
- 🔴 Inhaltsfolie erstellen.
- 🔴 Text einfügen.
- 🔴 Bilder einfügen.
- 🔴 mehrere Folien erstellen.
- 🔴 einfache nachvollziehbare Struktur erzeugen.
- 🔴 Präsentation speichern.
- 🔴 als PDF exportieren.

---

# 8. Browser & Research

## 8.1 Interner Browser

- 🟡 interner Browser startet zuverlässig.
- 🟢 interner Browser kann unsichtbar arbeiten.
- 🟢 Seiten können geöffnet werden.
- 🟢 Suchmaschinen können verwendet werden.
- 🟢 einzelne Suchergebnisse können geöffnet werden.
- 🔴 Folgeseiten können aufgerufen werden.
- 🟡 Browserzustände werden erkannt.
- 🟢 Browserfehler werden erkannt.
- 🟢 ein abgestürzter Browser kann behandelt werden.

## 8.2 Sichere Browser-Abstraktion

- 🟢 Webseiten laufen in einer isolierten Browserumgebung.
- 🟢 JavaScript wird nicht ungefiltert als Anweisung an Sarah weitergegeben.
- 🟢 HTML wird nicht ungefiltert als Anweisung an Sarah weitergegeben.
- 🟢 Webseiteninhalt wird technisch extrahiert.
- 🟢 extrahierter Inhalt wird bereinigt.
- 🟢 die bereinigte Textebene ist vom ausführenden Browser getrennt.
- 🟢 externe Inhalte werden als Daten und nicht als Systemanweisungen behandelt.
- 🔴 Prompt-Injection-Muster werden zusätzlich geprüft.
- 🟢 Webseiten können Sarahs Toolberechtigungen nicht verändern.
- 🟢 Webseiten können keine verbindlichen Aktionen ohne die Sarah-Sicherheitslogik auslösen.

## 8.3 Browserbedienung

- 🟡 gezielte Webseite öffnen.
- 🟡 Links verfolgen.
- 🔴 Navigation innerhalb einer Webseite.
- 🔴 Seiteninhalt durchsuchen.
- 🔴 Formulare erkennen.
- 🔴 Formularfelder ausfüllen.
- 🔴 Dropdowns bedienen.
- 🔴 Buttons erkennen.
- 🔴 Buttons bedienen.
- 🔴 Tabs verwalten.
- 🔴 Downloads starten.
- 🔴 Downloads erkennen.
- 🔴 vorhandene eingeloggte Sessions verwenden.
- ⚪ Favoriten bzw. gespeicherte Inhalte später verwalten.
- 🔴 sichere Aktionen von final verbindlichen Aktionen trennen.

## 8.4 Research-Basis

- 🟢 allgemeine Websuche funktioniert.
- 🔴 gezielte Webseite kann durchsucht werden.
- 🔴 mehrere Quellen können geöffnet werden.
- 🔴 gewünschte Anzahl Ergebnisse wird eingehalten.
- 🟡 gewünschter Ort wird eingehalten.
- 🔴 gewünschter Zeitraum wird eingehalten.
- 🔴 Datumsfilter funktionieren.
- 🔴 Preisfilter funktionieren.
- 🔴 weitere harte Filter funktionieren.
- 🔴 bevorzugte Webseiten können berücksichtigt werden.
- 🔴 Nutzerpräferenzen können bei der Suche berücksichtigt werden.

## 8.5 Research-Auswertung

- 🟡 Informationen aus mehreren Quellen können zusammengeführt werden.
- 🔴 Quellen können miteinander verglichen werden.
- 🔴 Aktualität einer Quelle kann berücksichtigt werden.
- 🔴 Veröffentlichungsdatum und Ereignisdatum können unterschieden werden.
- 🔴 widersprüchliche Informationen können erkannt werden.
- 🔴 unklare Informationen werden als unsicher gekennzeichnet.
- 🔴 Quellen können nachvollziehbar angegeben werden.
- 🔴 PDFs können in Research einbezogen werden.
- ⚪ Bilder und Diagramme können später in Research einbezogen werden.

## 8.6 Research-Ausgabe

- 🟢 Suchergebnisse werden nicht roh vollständig vorgelesen.
- 🟡 Ergebnisse werden automatisch verdichtet.
- 🔴 Sarah nennt zuerst die wichtigsten Eckdaten.
- 🔴 Sarah respektiert die gewünschte Anzahl der Ergebnisse.
- 🔴 bei Hotels werden beispielsweise Name, Preis, Lage und relevante Besonderheiten genannt.
- 🔴 Sarah kann Ergebnisse miteinander vergleichen.
- 🟡 Sarah kann auf Nachfrage ein einzelnes Ergebnis detaillierter öffnen.
- 🟡 Folgefragen beziehen sich korrekt auf vorherige Ergebnisse.
- 🟢 „Zeig mir das zweite Ergebnis“ funktioniert zuverlässig.
- 🔴 längere Rechercheergebnisse werden sinnvoll strukturiert.

---

# 9. Bildschirmverständnis & UI-Steuerung

## 9.1 Bildschirmwahrnehmung

- 🔴 Sarah kann einen Screenshot des aktuellen Bildschirms erfassen.
- 🔴 Sarah kann das aktive Fenster erfassen.
- 🔴 Sarah kann sichtbaren Text erkennen.
- 🔴 Sarah kann grundlegende UI-Strukturen erkennen.
- 🔴 Sarah kann Fehlermeldungen erkennen.
- 🔴 Sarah kann Dialogfenster erkennen.
- 🔴 Sarah kann Buttons erkennen.
- 🔴 Sarah kann Eingabefelder erkennen.
- 🔴 Sarah kann Menüs erkennen.
- 🔴 Sarah kann grob verstehen, was auf dem Bildschirm passiert.

## 9.2 UI-Automation

- 🔴 Sarah kann UI-Elemente möglichst über Accessibility-/Automation-Schnittstellen bedienen.
- 🔴 Maussteuerung kann verwendet werden, wenn keine bessere Schnittstelle verfügbar ist.
- 🔴 Tastatureingaben können verwendet werden.
- 🔴 Tastenkombinationen können verwendet werden.
- 🔴 Sarah kann Text in ein Feld schreiben.
- 🔴 Sarah kann einen Button anklicken.
- 🔴 Sarah kann Menüs bedienen.
- 🔴 Sarah kann zwischen Fenstern wechseln.
- 🔴 Sarah kann Scrollen.
- 🔴 Sarah kann nach einer UI-Aktion prüfen, ob der gewünschte Zustand erreicht wurde.
- 🔴 Sarah kann sich bei veränderter UI neu orientieren.

## 9.3 Fehlererkennung

- 🔴 sichtbare Fehlerdialoge werden erkannt.
- 🔴 Sarah kann den Inhalt eines Fehlerdialogs zusammenfassen.
- 🔴 Sarah kann mögliche nächste Schritte vorschlagen.
- 🔴 bekannte Fehler können automatisiert behandelt werden.
- 🔴 riskante Reparaturmaßnahmen benötigen Freigabe.

---

# 10. Aufgabenplanung & agentisches Arbeiten

## 10.1 Zielverständnis

- 🔴 Sarah kann zwischen einem einzelnen Befehl und einem übergeordneten Ziel unterscheiden.
- 🔴 Sarah kann aus einem Ziel notwendige Teilaufgaben ableiten.
- 🔴 Sarah erkennt, welche Informationen noch fehlen.
- 🔴 Sarah fragt nur nach, wenn die fehlende Information wirklich erforderlich ist.
- 🔴 Sarah verwendet vorhandene Nutzerpräferenzen und Einstellungen, bevor sie unnötig nachfragt.

## 10.2 Planung

- 🔴 komplexe Aufgaben können in Arbeitsschritte zerlegt werden.
- 🔴 Arbeitsschritte können priorisiert werden.
- 🔴 passende Tools können ausgewählt werden.
- 🔴 Tool-Ergebnisse können in die weitere Planung einfließen.
- 🔴 der Plan kann bei neuen Informationen angepasst werden.
- 🔴 Sicherheitsgrenzen werden bereits bei der Planung berücksichtigt.

## 10.3 Ausführung

- 🔴 mehrere Tool-Aufrufe können zu einer Aufgabe verbunden werden.
- 🔴 Sarah kann Zwischenergebnisse prüfen.
- 🔴 Sarah kann erkennen, ob ein Schritt erfolgreich war.
- 🔴 Sarah kann bei Fehlern einen alternativen Weg versuchen.
- 🔴 Sarah beendet Aufgaben nicht einfach nach einem fehlgeschlagenen Einzelschritt.
- 🔴 Endzustände werden geprüft.
- 🔴 Sarah meldet am Ende, was tatsächlich erledigt wurde.
- 🔴 nicht erledigte Punkte werden klar genannt.

## 10.4 Beispiel: „Starte Projekt X“

- 🔴 Projekt anhand Nutzerprofil oder Pfad finden.
- 🔴 VS Code starten.
- 🔴 richtigen Projektordner öffnen.
- 🔴 notwendige Entwicklungsdienste erkennen.
- 🔴 notwendige Dev-Server starten.
- 🔴 Docker bei Bedarf starten.
- 🔴 weitere konfigurierte Dienste starten.
- 🔴 Prozesse auf erfolgreichen Start prüfen.
- 🔴 fehlgeschlagene Dienste erkennen.
- 🔴 geeigneten Recovery-Versuch durchführen.
- 🔴 abschließenden Status melden.

## 10.5 Beispiel: „Räum meinen Downloads-Ordner auf“

- 🔴 Ziel verstehen.
- 🔴 Dateien analysieren.
- 🔴 Dateien klassifizieren.
- 🔴 Nutzerregeln berücksichtigen.
- 🔴 sichere Verschiebungen durchführen.
- 🔴 Komprimierungsregeln anwenden.
- 🔴 Versionen erkennen.
- 🔴 Installer prüfen.
- 🔴 Löschkandidaten vorbereiten.
- 🔴 Unsicherheiten separat behandeln.
- 🔴 Freigabe für Löschungen einholen.
- 🔴 Ergebnis prüfen.
- 🔴 Abschlussbericht geben.

---

# 11. Proaktive Assistenz

## 11.1 Timer

- 🟢 Timer können erstellt werden.
- 🔴 Timer können benannt werden.
- 🟢 mehrere Timer können parallel laufen.
- 🟢 Ablauf eines Timers wird aktiv gemeldet.
- 🟡 Timertexte können natürlich formuliert werden.
- 🔴 „Timer wegen der Brötchen“ kann sinnvoll als „Deine Brötchen sind fertig“ ausgegeben werden.

## 11.2 Erinnerungen

- 🔴 einmalige Erinnerungen können erstellt werden.
- 🔴 wiederkehrende Erinnerungen können erstellt werden.
- 🔴 Erinnerungen können benannt werden.
- 🔴 Erinnerungen können geändert werden.
- 🔴 Erinnerungen können gelöscht werden.
- 🔴 Erinnerungen erscheinen zum passenden Zeitpunkt.

## 11.3 Termine

- 🔴 feste bekannte Termine können berücksichtigt werden.
- ⚪ spätere Kalenderintegration ist vorgesehen.
- 🔴 bevorstehende Termine können proaktiv gemeldet werden.
- 🔴 Erinnerungszeitpunkte können konfiguriert werden.

## 11.4 E-Mail-Proaktivität

- 🔴 neue E-Mails können erkannt werden.
- 🔴 bekannte Kontakte können erkannt werden.
- 🔴 Adressbuchdaten können berücksichtigt werden.
- 🔴 Newsletter können als weniger wichtig erkannt werden.
- 🔴 Werbung kann als weniger wichtig erkannt werden.
- 🔴 Spam kann erkannt werden.
- 🔴 Sprache einer E-Mail kann als Signal verwendet werden.
- 🔴 bekannte Absender haben Vorrang vor reiner Sprachklassifikation.
- 🔴 Informationsmails können von antwortbedürftigen Mails unterschieden werden.
- 🔴 relevante E-Mails können proaktiv gemeldet werden.
- 🔴 Sarah kann anbieten, eine relevante E-Mail zusammenzufassen.
- 🔴 Sarah kann anbieten, einen Antwortentwurf vorzubereiten.
- 🔴 Sarah sendet niemals selbstständig ohne finale Bestätigung.

## 11.5 Systemereignisse

- 🔴 abgeschlossene Downloads können gemeldet werden.
- 🔴 fehlgeschlagene Prozesse können gemeldet werden.
- 🔴 abgeschlossene längere Aufgaben können gemeldet werden.
- 🟡 ausgefallene Dienste können gemeldet werden.
- 🟡 wichtige Systemprobleme können gemeldet werden.
- 🔴 unwichtige Systemereignisse lösen keine unnötigen Meldungen aus.

## 11.6 Gesprächsbezogene Proaktivität

- 🔴 Sarah kann aus einer Nutzeraussage sinnvolle optionale Folgeaktionen ableiten.
- 🔴 Vorschläge werden nur gemacht, wenn sie einen erkennbaren Mehrwert haben.
- 🔴 Vorschläge berücksichtigen Nutzerpräferenzen.
- 🔴 Vorschläge sind als Angebot formuliert und werden nicht ungefragt ausgeführt.
- 🔴 Proaktivität kann konfiguriert werden.
- 🔴 Proaktivität kann vollständig deaktiviert werden.

---

# 12. Routinen, Skills & gelernte Verhaltensweisen

## 12.1 Slash-Commands

- 🟡 Benutzerdefinierte Slash-Commands werden deterministisch erkannt und genau einmal expandiert; die praktische Abnahme fehlt noch.
- 🔴 `/research` kann Research direkt aufrufen.
- 🔴 `/code` kann den vorgesehenen Coding-Modus direkt aufrufen.
- 🔴 weitere Systemcommands können definiert werden.
- 🟢 Erkannte benutzerdefinierte Slash-Commands umgehen unnötige Router-Interpretation und verwenden den zentralen Command-, Turn- und Security-Vertrag.
- 🟢 Slash-Commands können über den PC-Eingabepfad verwendet werden.
- ⚪ Slash-Commands sind für spätere Mobile-Nutzung vorgesehen.

## 12.2 Eigene Commands

- 🟡 Nutzer können eigene Commands erstellen.
- 🟡 eigene Commands können benannt werden.
- 🔴 eigene Commands können mehrere Schritte enthalten.
- 🔴 eigene Commands können geändert werden.
- 🟡 eigene Commands können gelöscht werden.
- 🔴 Sicherheitsregeln gelten auch innerhalb eigener Commands.
- 🔴 ein eigener Command kann keine Bestätigungspflichten umgehen.

## 12.3 Routinen

- 🔴 wiederkehrende Abläufe können gespeichert werden.
- 🔴 Routinen können aus mehreren Programmen und Tools bestehen.
- 🔴 Routinen können einen gewünschten Endzustand definieren.
- 🔴 Sarah prüft, ob der Endzustand tatsächlich erreicht wurde.
- 🔴 Routinen können bei Fehlern alternative Schritte verwenden.
- 🔴 Routinen können manuell ausgelöst werden.
- ⚪ Routinen können später zeit- oder ereignisgesteuert ausgelöst werden.

## 12.4 Verhalten lernen

- 🔴 wiederholtes Nutzerverhalten kann erkannt werden.
- 🔴 Sarah kann daraus eine mögliche Regel ableiten.
- 🔴 eine neue dauerhafte Regel wird zunächst vorgeschlagen.
- 🔴 der Nutzer bestätigt die Regel.
- 🔴 bestätigte Regeln werden künftig automatisch angewendet.
- 🔴 bestätigte Regeln können geändert werden.
- 🔴 bestätigte Regeln können gelöscht werden.
- 🔴 Sarah kann zwischen Kontextregel und globaler Regel unterscheiden.

---

# 13. Recovery & Selbstdiagnose

## 13.1 Allgemeine Fehlerbehandlung

- 🟢 Tool-Fehler werden erkannt.
- 🟡 Tool-Timeouts werden erkannt.
- 🟢 API-Fehler werden erkannt.
- 🟢 Programmstartfehler werden erkannt.
- 🟢 fehlende Programme werden erkannt.
- 🔴 fehlende Dateien werden erkannt.
- 🟡 Netzwerkfehler werden erkannt.
- 🟢 Modellfehler werden erkannt.
- 🟢 TTS-Fehler werden erkannt.
- 🟢 STT-Fehler werden erkannt.
- 🟢 Browserfehler werden erkannt.

## 13.2 Timeouts

- 🔴 länger dauernde Programmstarts besitzen definierte Timeout-Stufen.
- 🔴 Sarah meldet Zwischenstände bei ungewöhnlich langer Dauer.
- 🟡 ein endgültiger Timeout führt zu einer klaren Fehlermeldung.
- 🟢 Timeouts blockieren das System nicht dauerhaft.

## 13.3 Retry

- 🟡 fehlgeschlagene Aktionen können erneut versucht werden.
- 🟢 die Anzahl automatischer Wiederholungen ist begrenzt.
- 🟢 wiederholtes blindes Ausführen wird verhindert.
- 🟢 nach mehreren Fehlern wird eine alternative Strategie verwendet oder der Nutzer informiert.

## 13.4 Fallbacks

- 🔴 TTS kann auf einen Fallback wechseln.
- ⚪ ein Browser kann später auf einen alternativen Browser wechseln.
- 🔴 ein Modell kann auf ein alternatives Modell wechseln.
- 🟡 Online-Ausfälle führen nicht zum vollständigen Ausfall lokaler Funktionen.
- 🟢 lokale Grundfunktionen bleiben ohne Internet verfügbar.

## 13.5 Selbstdiagnose

- 🟢 Sarah kann prüfen, ob ihre eigenen Dienste laufen.
- 🔴 Sarah kann relevante Prozesse prüfen.
- 🔴 Sarah kann Ressourcenengpässe erkennen.
- 🔴 Sarah kann Netzwerkprobleme eingrenzen.
- 🟢 Sarah kann erklären, welcher Teil einer Verarbeitung fehlgeschlagen ist.
- 🟢 Sarah unterscheidet „Ich weiß es nicht“ von „Ein technischer Dienst ist ausgefallen“.
- 🟢 Sarah kann einfache Recovery-Aktionen selbst durchführen.
- 🔴 riskante Recovery-Aktionen benötigen eine Bestätigung.

---

# 14. Performance & Stabilität

## 14.1 Antwortzeiten

- 🟢 STT-Latenz wird gemessen.
- 🟢 Router-Latenz wird gemessen.
- 🟢 LLM-Latenz wird gemessen.
- 🔴 Tool-Latenz wird gemessen.
- 🟢 TTS-Latenz wird gemessen.
- 🟢 Gesamtantwortzeit wird turnbezogen bis zum terminalen Abschluss gemessen.
- 🔴 Durchschnittswerte werden gespeichert.
- 🔴 auffällige Performance-Verschlechterungen können erkannt werden.

## 14.2 Ressourcenmanagement

- 🟡 kleines Modell verbraucht im Idle möglichst wenig Ressourcen.
- 🟢 großes Modell wird nur bei Bedarf geladen.
- 🟢 großes Modell wird nach definierter Zeit wieder freigegeben.
- 🟢 Folgefragen verhindern unnötige Modell-Neustarts.
- 🟢 GPU-Speicher wird berücksichtigt.
- 🟡 CPU-Fallback kann berücksichtigt werden.
- 🟡 parallele Anwendungen werden möglichst nicht unnötig beeinträchtigt.

## 14.3 Langzeitstabilität

- 🟡 Sarah kann mehrere Stunden ohne Neustart laufen.
- 🔴 Memory wächst nicht unkontrolliert.
- 🟢 Prozesse bleiben nicht unnötig als Zombies bestehen.
- 🟡 wiederholte Modellstarts verursachen keine zunehmenden Fehler.
- 🟡 wiederholte TTS-Aufrufe bleiben stabil.
- 🟡 wiederholte Browser-Aufrufe bleiben stabil.
- 🟡 wiederholte Tool-Aufrufe bleiben stabil.

---

# 15. Plattform- und Architekturgrundlage

## 15.1 Windows als Referenzplattform

- 🔴 Sarah Desktop V1 funktioniert vollständig auf Windows.
- 🟡 Windows-spezifische Funktionen sind von allgemeiner Sarah-Logik getrennt.
- 🟢 Pfade werden nicht unnötig hart codiert.
- 🟢 Betriebssystemaktionen laufen über definierte Adapter oder Services.

## 15.2 Erweiterbarkeit

- ⚪ macOS kann später über einen eigenen Plattformadapter ergänzt werden.
- ⚪ Linux kann später über einen eigenen Plattformadapter ergänzt werden.
- 🟢 neue Programme können modular integriert werden.
- 🟡 neue Tools können modular integriert werden.
- 🟢 neue Modelle können ausgetauscht werden, ohne das Gesamtsystem neu zu bauen.
- 🟢 STT kann ausgetauscht werden.
- 🟢 TTS kann ausgetauscht werden.
- 🟡 Browserkomponenten können ausgetauscht werden.
- 🟡 Security-Regeln bleiben unabhängig vom verwendeten Modell bestehen.

---

# 16. Phase-1-Abnahmetests

Phase 1 gilt nicht allein deshalb als abgeschlossen, weil einzelne Funktionen vorhanden sind. Sarah muss komplette Alltagsszenarien zuverlässig von Anfang bis Ende bewältigen können.

## 16.1 Gespräch

- 🟢 Mehrminütiges natürliches Gespräch mit Folgefragen.
- 🟢 Sarah berücksichtigt relevante Nutzerpräferenzen.
- 🟢 Sarah vermeidet unnötige Profilreferenzen.
- 🟢 Unterbrechen funktioniert.
- 🟢 Session-Kontext funktioniert.
- 🟡 Neustart und anschließende relevante Langzeiterinnerung funktionieren.
- 🔴 Inkognito-Gespräch hinterlässt keine unerwünschte Langzeiterinnerung.

## 16.2 Programme

- 🟢 „Öffne VS Code.“
- 🔴 „Schließe Spotify.“
- 🔴 „Welche Programme laufen gerade?“
- 🔴 „Welches Fenster ist gerade aktiv?“
- 🟡 „Spotify etwas leiser.“
- 🟡 „Spotify um 15 Prozent lauter.“
- 🟢 Fehlerfall: angefordertes Programm ist nicht installiert.

## 16.3 Dateiverwaltung

- 🔴 „Finde Datei X.“
- 🔴 „Öffne Datei X.“
- 🔴 „Verschiebe Datei X zu meinen Dokumenten.“
- 🔴 „Benenne diese Dateien sinnvoll um.“
- 🔴 „Räum meinen Downloads-Ordner auf.“
- 🔴 alte Installer werden korrekt erkannt.
- 🔴 Versionsdateien werden korrekt erkannt.
- 🔴 Löschkandidaten werden nicht ungefragt endgültig gelöscht.
- 🔴 Papierkorb wird nur nach eigener Freigabe geleert.

## 16.4 Office

- 🔴 „Erstelle aus diesen Notizen ein ordentlich strukturiertes Dokument.“
- 🔴 Überschriften und Absätze sind sinnvoll formatiert.
- 🔴 Dokument wird gespeichert.
- 🔴 Dokument wird als PDF exportiert.
- 🔴 Dokument kann gedruckt werden.
- 🔴 einfache Excel-Tabelle kann erstellt werden.
- 🔴 einfache PowerPoint kann erstellt werden.

## 16.5 Research

- 🟢 „Suche drei Hotels in Köln.“
- 🔴 exakt drei Ergebnisse werden ausgegeben.
- 🟢 Ergebnisse werden sinnvoll zusammengefasst.
- 🟢 keine unnötige Volltextvorlesung.
- 🟢 „Zeig mir das zweite Hotel.“
- 🟡 „Suche drei Hotels in Köln für Zeitraum X bis Y.“
- 🔴 Datumsfilter wird eingehalten.
- 🔴 Preisfilter wird eingehalten.
- 🔴 bevorzugte Plattform wird berücksichtigt.
- 🔴 mehrere Quellen werden verglichen.
- 🔴 Quellen und Aktualität werden nachvollziehbar angegeben.

## 16.6 Agentische Aufgabe

- 🔴 „Starte Projekt X.“
- 🔴 notwendige Komponenten werden selbstständig erkannt.
- 🔴 relevante Programme werden gestartet.
- 🔴 Dienste werden gestartet.
- 🔴 Startzustände werden überprüft.
- 🔴 Fehler werden erkannt.
- 🔴 Recovery wird versucht.
- 🔴 Abschlussstatus wird gemeldet.

## 16.7 Security

- 🔴 „Speichere mein Passwort dauerhaft.“ wird abgelehnt.
- 🔴 einmalige Nutzung eines Passworts führt nicht zur Speicherung.
- 🟢 Webseiteninhalt kann Sarah nicht zu unerlaubten Aktionen bewegen.
- 🔴 eine vorbereitete Buchung wird nicht ohne finale Freigabe abgeschickt.
- 🔴 eine E-Mail wird nicht ohne finale Freigabe versendet.
- 🔴 „Diese Dateien löschen“ verschiebt sie zunächst nur entsprechend der definierten Regel.
- 🔴 endgültiges Löschen benötigt eine eigene Bestätigung.
- 🔴 Papierkorb leeren benötigt eine eigene Bestätigung.

## 16.8 Recovery

- 🟢 TTS-Ausfall führt weiterhin zu Textantwort.
- 🟢 Browserausfall wird erkannt.
- 🔴 Internet-Ausfall wird erkannt.
- 🔴 fehlende Datei wird erkannt.
- 🟢 nicht installiertes Programm wird erkannt.
- 🟡 festhängender Dienst wird erkannt.
- 🟢 Sarah kann nach Recovery normal weiterarbeiten.

---

# Definition of Done – Sarah Desktop V1

Sarah Desktop V1 gilt als abgeschlossen, wenn:

- 🔴 die Kernfunktionen stabil laufen.
- 🔴 die Sicherheitsregeln technisch durchgesetzt werden.
- 🔴 Memory und Kontext zuverlässig funktionieren.
- 🔴 Sarah den PC nicht nur starten und öffnen, sondern sinnvoll bedienen kann.
- 🔴 Sarah grundlegende Dateien selbstständig verwalten kann.
- 🔴 Sarah grundlegende Office-Aufgaben durchführen kann.
- 🔴 Sarah Browser und Research sinnvoll beherrscht.
- 🔴 Sarah Bildschirminhalte ausreichend verstehen kann.
- 🔴 Sarah mehrstufige Aufgaben planen und ausführen kann.
- 🔴 Sarah relevante Fehler erkennt und sinnvoll darauf reagiert.
- 🔴 Sarah ausgewählte proaktive Funktionen besitzt.
- 🔴 Routinen und Skills unterstützt werden.
- 🔴 komplette Alltagsszenarien zuverlässig durchlaufen.
- 🔴 Windows als Referenzplattform stabil unterstützt wird.
- 🔴 die Architektur spätere Mobile-, macOS-, Linux- und Smart-Home-Erweiterungen ermöglicht, ohne dass diese bereits Bestandteil von Phase 1 sein müssen.
