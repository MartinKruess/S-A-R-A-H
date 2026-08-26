Phase 1 – Sarah Desktop

Das wäre für mich inzwischen ungefähr diese Struktur:

1. Kernsystem & Gespräch
   Sarah startet und beendet zuverlässig.
   Router funktioniert zuverlässig.
   kleines/großes Modell werden korrekt gewählt.
   Sprachaufnahme funktioniert stabil.
   TTS funktioniert stabil.
   Unterbrechen funktioniert zuverlässig.
   Folgefragen funktionieren.
   Session-Kontext funktioniert.
   Langzeit-Memory funktioniert.
   Inkognito-/Nicht-speichern-Modus funktioniert.
   Nutzerprofil beeinflusst Antworten sinnvoll, aber nicht aufdringlich.
   Anrede/Sprachstil werden korrekt eingehalten.
   später Wake-Word + Gesprächsmodus.
2. Security & Berechtigungen

Das würde ich vor den wirklich mächtigen PC-Funktionen abschließen.

klare Aktionsklassen: Lesen / Verändern / verbindlich.
Secrets werden nicht dauerhaft gespeichert.
Zahlungsdaten werden nicht von Sarah verarbeitet/gespeichert.
externe/verbindliche Aktionen benötigen explizite Freigabe.
Kaufen/Buchen hat immer eine finale Bestätigung.
E-Mail-Versand hat finale Bestätigung.
Löschen hat Bestätigung.
endgültiges Löschen hat noch einmal eine eigene höhere Freigabe.
Webseiten-/Dateiinhalte können die Sicherheitsregeln nicht überschreiben.
Prompt-Injection-Schutz.
Tool-Rechte können nicht einfach vom LLM umgangen werden.
Aktionen werden protokolliert.

Gerade dein Beispiel würde ich exakt unterscheiden:

„Löschen“
→ Datei landet im Papierkorb.

„Endgültig löschen“
→ Papierkorb umgehen oder anschließend leeren.

Das sind zwei verschiedene Sicherheitsstufen.

Und „Papierkorb leeren“ sollte niemals automatisch aus „lösche die Dateien“ folgen.

3. Dateisystem & Storage

Das ist inzwischen ein eigener großer Sarah-Baustein.

Basis
Dateien finden.
Dateien öffnen.
Ordner öffnen.
Dateien erstellen.
Dateien kopieren.
Dateien verschieben.
Dateien umbenennen.
Ordner erstellen.
Dateien in Papierkorb verschieben.
endgültig löschen nach Freigabe.
Verständnis
Dateitypen erkennen.
Standardprogramme zuordnen.
Dokumente/Bilder/Videos/Audio/Installer/Archive unterscheiden.
Versionen anhand Dateinamen/Metadaten erkennen.
Dubletten erkennen.
alte Installer erkennen.
prüfen, ob dazugehörige Software bereits installiert ist.
große Dateien/Ordner identifizieren.
Nutzerverhalten lernen

Das finde ich bei deinem Beispiel besonders wichtig.

Wenn fünfmal passiert:

Videos → komprimieren → Videoordner

soll Sarah irgendwann verstehen:

„Videos werden bei Martin normalerweise vor dem Ablegen komprimiert.“

Aber ich würde hier noch eine Schutzstufe einbauen:

Beim ersten Erkennen:

„Mir ist aufgefallen, dass du Videos normalerweise vor dem Archivieren komprimierst. Soll ich das künftig automatisch machen?“

Dann wird daraus eine explizit bestätigte Regel.

Danach darf Sarah das automatisch tun.

Das verhindert, dass sie aus drei zufälligen Aktionen plötzlich eine permanente Regel konstruiert.

Downloads aufräumen

Das könnte später sogar ein eigener Abnahmetest werden:

„Sarah, räum meinen Downloads-Ordner auf.“

Sarah muss dann:

Inhalt analysieren.
Dateien kategorisieren.
bekannte Zielpfade berücksichtigen.
bekannte Regeln anwenden.
eindeutige Dateien selbstständig verschieben.
unsichere Fälle separat behandeln.
Löschkandidaten sammeln.
Ergebnis zusammenfassen.
Freigabe für Löschkandidaten einholen.
erst danach löschen.

Wenn Sarah diesen Test zuverlässig schafft, ist Dateiverwaltung schon ziemlich weit.

4. Programme & Systemsteuerung

Hier würde ich später nicht „Sarah muss jedes Programm können“ verlangen.

Stattdessen:

Betriebssystem
Programme starten.
Programme schließen.
laufende Programme erkennen.
aktives Fenster erkennen.
Prozesse überwachen.
hängende Programme erkennen.
Prozess nach Freigabe beenden.
CPU/RAM/GPU verstehen.
Speicherplatz analysieren.
Netzwerkstatus analysieren.
Audioein-/ausgabe erkennen.
Geräteinformationen abrufen.
Programme bedienen

Dann eine Referenzsuite, zum Beispiel 10 verbreitete Programme.

Nicht 500.

Beispielsweise:

Browser
Word/Writer
Excel/Calc
PowerPoint/Impress
PDF-Reader
VS Code
Dateimanager
Mailclient
Mediaplayer
vielleicht Editor/Notepad

Und pro Programm nur typische Standardaufgaben.

5. Office-Bedienung

Genau deine Idee.

Nicht:

„Sarah muss Excel vollständig beherrschen.“

Sondern:

Word / Writer
neues Dokument.
Text schreiben.
Überschriften.
Absätze.
fett/kursiv.
Listen.
einfache Tabellen.
speichern.
PDF exportieren.
drucken.
Excel / Calc
Tabelle erstellen.
Daten eintragen.
einfache Formatierung.
einfache Formeln.
sortieren/filtern.
speichern/exportieren.
PowerPoint / Impress
Präsentation erstellen.
Titel-/Inhaltsfolien.
Text/Bilder einfügen.
einfache Struktur.
speichern.
PDF exportieren.

Das reicht für Sarah V1 vollkommen.

6. Browser & Research

Hier würde ich sogar zwei Checklisten machen.

Browserbedienung
Seite öffnen.
Navigation.
Links verfolgen.
Formulare erkennen.
Felder ausfüllen.
Tabs verwalten.
Downloads.
Login mit bereits hinterlegter Session.
Aktionen sicher bestätigen.
Research
Suchauftrag verstehen.
gewünschte Anzahl Ergebnisse respektieren.
Zeitraum respektieren.
Preis-/Ort-/Eigenschaftsfilter respektieren.
mehrere Quellen prüfen.
Informationen vergleichen.
Widersprüche erkennen.
Quellenaktualität berücksichtigen.
Ergebnisse verdichten.

Und ganz wichtig:

Sarah soll standardmäßig die passende Informationsdichte wählen.

Bei:

„Such drei Hotels.“

nicht 4.000 Wörter vorlesen.

Sondern etwa:

„Ich habe drei passende Hotels gefunden. Sie liegen zwischen 92 und 138 Euro pro Nacht. Zwei haben Frühstück inklusive. Hotel 2 liegt am nächsten zum Hauptbahnhof.“

Dann:

„Soll ich dir die drei einzeln zeigen?“

Das wäre für mich ein eigener Abnahmepunkt:

Sarah liest Research-Ergebnisse nicht einfach roh vor. 7. Bildschirmverständnis & UI-Steuerung

Das ist wahrscheinlich einer der großen Schritte von „Alexa am PC“ zu „Jarvis“.

aktives Fenster erkennen.
Screenshot erfassen.
sichtbare UI verstehen.
Buttons/Felder erkennen.
Fehlermeldungen erkennen.
Bildschirmtext verstehen.
UI-Elemente bedienen.
Erfolg der Aktion visuell überprüfen.
bei veränderter UI neu orientieren.

Das wird vermutlich einer der technisch anspruchsvolleren Phase-1-Blöcke.

8. Aufgabenplanung / Agentic Work

Hier kommt dann dein:

„Räum meinen Downloads-Ordner auf.“

statt:

„Verschiebe Datei A nach B.“

Ziel erkennen.
Teilaufgaben erstellen.
passende Tools wählen.
Aktionen ausführen.
Ergebnis überprüfen.
Fehler behandeln.
Alternativen versuchen.
Sicherheitsgrenzen berücksichtigen.
nur bei tatsächlicher Unsicherheit nachfragen.
abschließend Ergebnis berichten. 9. Proaktivität
Timer.
Reminder.
Termine.
relevante E-Mail erkannt.
Download fertig.
Prozess fertig/fehlgeschlagen.
sinnvolle Folgeaktionen anbieten.
Nutzer kann Proaktivität konfigurieren.
Sarah nervt nicht wegen belanglosen Ereignissen. 10. Routinen & gelernte Verhaltensweisen
Slash-Commands.
eigene Commands anlegen.
Routinen speichern.
Routinen bearbeiten.
Routinen löschen.
Verhalten aus Wiederholungen erkennen.
vorgeschlagene Gewohnheiten vom Nutzer bestätigen lassen.
bestätigte Gewohnheiten automatisch anwenden.
geräte-/kontextabhängige Skills unterstützen.

Das könnte beispielsweise später sein:

„Projekt Novari starten“

→ VS Code
→ Projektordner
→ Terminal
→ benötigte Services
→ Docker
→ prüfen
→ Status melden.

11. Recovery & Selbstdiagnose

Das darf nicht unterschätzt werden.

Tool-Timeout.
Tool-Neustart.
TTS-Fallback.
STT-Fallback.
Modell-Fallback.
Browser-Fallback.
Dienst nicht erreichbar.
Internet fehlt.
Datei fehlt.
Programm fehlt.
Programm hängt.
Aktion fehlgeschlagen.
Sarah kann unterscheiden: „weiß ich nicht“ vs. „technischer Fehler“.

Später:

„Ich komme bis zum Router, aber nicht ins Internet.“

Das wäre dann schon die sehr schöne Jarvis-Stufe.

12. Phase-1-Abnahmetests

Und das würde ich ganz am Ende noch darüberlegen.

Nicht nur 300 Checkboxen, sondern vielleicht 20 echte Alltagsszenarien.

Beispielsweise:

„Sarah, räum Downloads auf.“

„Sarah, recherchiere drei Hotels in Köln für das Wochenende und vergleiche sie.“

„Sarah, erstelle aus diesen Notizen ein ordentliches Word-Dokument und exportiere es als PDF.“

„Sarah, starte mein Projekt und sag mir, wenn ein Dienst nicht läuft.“

„Sarah, diese 37 Bilder können weg.“

Und dann wird geprüft, ob Sarah die Aufgabe von Anfang bis Ende schafft.

Das wäre für mich letztlich der entscheidende Punkt:

Phase 1 ist nicht fertig, wenn alle Funktionen irgendwo vorhanden sind. Phase 1 ist fertig, wenn Sarah komplette Alltagsszenarien zuverlässig schafft.

Phase 2 Mobile und 3 Smart Home würde ich danach genauso untergliedern, aber wesentlich kompakter beginnen. Erst müssen wir Phase 1 vollständig definieren.
