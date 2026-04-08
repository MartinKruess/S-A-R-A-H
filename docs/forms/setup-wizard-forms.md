# 🧩 Onboarding-Datenstruktur (KI-Assistent)

## 1. Pflichtfelder (Formular Seite 1)

| Feld              | Frage im UI                | Typ          | Beispiel              | Zweck                       |
| ----------------- | -------------------------- | ------------ | --------------------- | --------------------------- |
| Anzeigename       | Wie soll ich dich nennen?  | Text         | Martin                | Ansprache im System         |
| Stadt             | In welcher Stadt bist du?  | Text         | Hamburg               | Lokale Infos (Wetter, Orte) |
| Verwendungszwecke | Wobei soll ich dir helfen? | Multi-Select | Dateien, Organisation | Kernfunktion steuern        |

---

## 2. Optionale Angaben (Formular Seite 1–2)

| Feld        | Frage im UI                           | Typ     | Beispiel            | Zweck                  |
| ----------- | ------------------------------------- | ------- | ------------------- | ---------------------- |
| Nachname    | Möchtest du deinen Nachnamen angeben? | Text    | Mustermann          | Dokumente / Formalität |
| Adresse     | Möchtest du deine Adresse speichern?  | Text    | Musterstraße 1      | selten benötigt        |
| Hobbys      | Was sind deine Interessen?            | Tags    | Fitness, Coding     | Personalisierung       |
| Beruf       | Was machst du beruflich?              | Text    | Entwickler          | Kontext                |
| Tätigkeiten | Was machst du häufig?                 | Text    | Rechnungen, Planung | bessere Vorschläge     |
| Antwortstil | Wie soll ich antworten?               | Auswahl | kurz                | UX                     |
| Tonfall     | Wie soll ich klingen?                 | Auswahl | direkt              | UX                     |

---

## 3. Erweiterte Optionen (Formular Seite 2)

| Feld                | Frage im UI                       | Typ          | Beispiel        | Zweck           |
| ------------------- | --------------------------------- | ------------ | --------------- | --------------- |
| E-Mails             | Möchtest du E-Mails speichern?    | Liste        | Arbeit / Privat | Zuordnung       |
| Wichtige Programme  | Welche Programme nutzt du oft?    | Tags         | Word, VS Code   | Automationen    |
| Bevorzugte Links    | Gibt es Seiten, die du oft nutzt? | Liste        | Gmail, Drive    | Quick Access    |
| Wichtige Ordner     | Welche Ordner sind wichtig?       | Pfad-Auswahl | D:\Dokumente    | File-Handling   |
| PDF-Ablage          | Wo speicherst du PDFs?            | Pfad         | D:\PDF          | Automatisierung |
| Bilderordner        | Wo liegen deine Bilder?           | Pfad         | D:\Bilder       | Sortierung      |
| Installationsordner | Wo installierst du Programme?     | Pfad         | D:\Apps         | Systemsteuerung |

---

## 4. Dynamische Fragen (abhängig von Auswahl)

| Bedingung                    | Zusatzfrage                          | Typ     | Beispiel        | Zweck               |
| ---------------------------- | ------------------------------------ | ------- | --------------- | ------------------- |
| Wenn „Programmieren“ gewählt | Wie ist dein Level im Programmieren? | Auswahl | Anfänger        | Anpassung Antworten |
| Wenn „Bildbearbeitung“       | Wie gut kennst du dich damit aus?    | Auswahl | Mittel          | Anpassung           |
| Wenn „Office“                | Wie sicher bist du mit Office?       | Auswahl | Fortgeschritten | Anpassung           |

> Hinweis: Diese Fragen nur anzeigen, wenn der jeweilige Bereich ausgewählt wurde.

---

## 5. Automatisch erkannte Daten (kein Formular)

| Feld                   | Anzeige im UI            | Beispiel      | Zweck          |
| ---------------------- | ------------------------ | ------------- | -------------- |
| Betriebssystem         | Windows erkannt          | Windows 11    | Commands       |
| Sprache                | Systemsprache erkannt    | Deutsch       | Antwortsprache |
| Zeitzone               | Automatisch erkannt      | Europe/Berlin | Zeitlogik      |
| Standardordner         | Dokumente gefunden       | C:\Users\...  | Filezugriff    |
| Downloads              | Download-Ordner erkannt  | C:\Downloads  | Automationen   |
| Bilder                 | Bilderordner erkannt     | C:\Pictures   | Sortierung     |
| Desktop                | Desktop erkannt          | C:\Desktop    | Zugriff        |
| Shell                  | Standard-Konsole erkannt | PowerShell    | Execution      |
| Installierte Programme | Apps erkannt             | Chrome, Word  | Integration    |

---

## 6. Vertrauen / Kontrolle

| Feld              | Frage im UI                         | Typ     | Beispiel     | Zweck      |
| ----------------- | ----------------------------------- | ------- | ------------ | ---------- |
| Speicher erlauben | Darf ich mir Dinge merken?          | Toggle  | Ja           | Memory     |
| Datei-Zugriff     | Darf ich Dateien analysieren?       | Auswahl | Nur Ordner X | Sicherheit |
| Hinweis           | Alle Daten werden lokal gespeichert | Text    | —            | Vertrauen  |

---

## 🧠 UI-Struktur (Übersicht)

### Seite 1

- Name
- Stadt
- Verwendungszwecke

### Seite 2

- Personalisierung
- Hobbys / Beruf
- Stil / Ton

### Seite 3

- Dateien / Ordner
- Programme / Links

### Hintergrund (automatisch)

- Systemdaten erkennen und anzeigen

---

## 📌 Design-Regel

> Frage nur das, was der Assistent nicht selbst erkennen kann.
