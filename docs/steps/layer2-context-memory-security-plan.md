# Sarah – Layer 2: Kontext, Memory, Regeln und Berechtigungen

**Status:** Sieben Fixrunden umgesetzt; sechs unabhängige Kontrollaudits abgeschlossen; praktische Abnahme offen  
**Auditdatum:** 27.–28.08.2026  
**Scope:** Layer 2 abwärts bis Layer 0; keine eigenständige Prüfung von Layer 3 bis 6

## 1. Abgrenzung

Layer 2 entscheidet, welche Informationen Sarah in einem Turn verwenden darf, welche davon nur flüchtig bestehen, was dauerhaft gespeichert werden darf und welche Berechtigungen beziehungsweise Bestätigungen vor einer Aktion technisch gelten. Geprüft wurden deshalb nicht nur Prompt- und Memory-Dateien, sondern auch ihre Übergänge in Turn-Orchestrierung, Storage, Modellruntime, Actions, Voice-Temporärdaten und Konfigurations-Recovery.

Nicht Bestandteil dieses Audits waren neue Planungsfähigkeiten, neue Tools und eine erneute isolierte Vollprüfung von Layer 1 oder Layer 0. Untere Befunde wurden nur aufgenommen, wenn ein Layer-2-Vertrag sie konkret sichtbar machte.

## 2. Verbindlicher Kontextvertrag für dieses Audit

Die bisherigen Gespräche legen für die Bewertung folgende fachliche Trennung zugrunde:

1. **Autoritative Konfiguration:** Profil, Einstellungen, Berechtigungen und Antwortstil sind strukturierte Anwendungsdaten, keine Gesprächserinnerungen.
2. **Aktiver Gesprächskontext:** Der flüchtige Verlauf der laufenden Unterhaltung darf über mehrere Worker-Aufrufe hinweg bestehen und wird bei Bedarf komprimiert.
3. **Kurzzeitspeicher:** Persistente, noch nicht kuratierte Gesprächsabschnitte dienen als begrenzte Arbeits- und Nachholwarteschlange.
4. **Langzeitgedächtnis:** Nur kuratierte, relevante und verwaltbare Erinnerungen mit Quelle und Lebenszyklus gehören hierhin.
5. **Temporärer Aufgaben- und Fremdkontext:** Such-, Datei- und Toolinhalte sind Daten mit eigener Vertrauens- und Persistenzmarkierung.

Startkontext ist keine weitere Speicherart, sondern eine zur aktuellen Anfrage passend zusammengestellte Retrieval-Sicht. Inkognito ist ebenfalls keine Speicherart, sondern eine strikt fail-closed angewendete Policy auf einen zusammenhängenden Gesprächsabschnitt: keine Persistenz, keine Kuratierung, keine Ableitung und kein „Merk dir“-Sonderweg. Der private Abschnitt wird beim Beenden entfernt; normaler Kontext davor und danach darf bestehen bleiben.

## 3. Ergebnis des ersten vollständigen Audits

Das Audit fand **26 eigenständige, produktiv relevante Ursachen**: **2 × P0**, **21 × P1** und **3 × P2**.

| Nr. | Priorität | Primärer Bereich | Befund | Auswirkung |
|---:|:---:|---|---|---|
| 1 | P0 | Konfiguration / Privacy | Scheitert die Validierung eines beliebigen Konfigurationsfelds, ersetzt der Reparaturpfad die gesamte Konfiguration durch Defaults. Damit werden unter anderem `memoryAllowed: false` zu `true` und `confirmationLevel: maximal` zu `standard`; nach Zustimmung wird der bisherige Stand vollständig überschrieben. | Ein fachfremder Konfigurationsfehler kann Datenschutz und Bestätigungsniveau fail-open lockern und zugleich gültige Profildaten, Programme und Einstellungen löschen. |
| 2 | P0 | Secrets / Memory-Policy | Es gibt keinen technisch unveränderlichen Nicht-Memory-Vertrag für Passwörter, PINs, Zahlungs- und hochsensible Identifikationsdaten. Bei leeren Ausschlüssen wird jeder erfolgreiche normale Turn gespeichert; selbst die optionalen Kategorien erkennen etwa „Passwort“, „Kartennummer“ oder „Diabetes“ nicht zuverlässig. | Die UI-Aussage, Sarah speichere niemals Passwörter, Bank- oder Versicherungsdaten, ist technisch nicht erfüllt. Geheimnisse können dauerhaft in `messages` landen. |
| 3 | P1 | Konfigurations-Storage | `JsonStorage` schreibt die Konfiguration direkt in die Zieldatei, ohne atomaren Temp-Datei-/Rename-Vertrag oder letzte gültige Sicherung. Lese- und Parsefehler werden als leere Konfiguration behandelt, ohne `configErrors` auszulösen. | Ein Abbruch während des Schreibens kann eine gültige Konfiguration zerstören; der Folgestart verwendet unbemerkt permissive Defaults und bietet nicht einmal den sichtbaren Reparaturdialog an. |
| 4 | P1 | Verschlüsselungsgrenze | `EncryptedStorage` behandelt jeden Entschlüsselungs- oder Authentifizierungsfehler als möglichen Legacy-Klartext und gibt den rohen gespeicherten Wert weiter. Es existieren weder Formatversion noch sichere Unterscheidung zwischen Klartextmigration, falschem Schlüssel und manipuliertem Ciphertext. | Beschädigte oder manipulierte Message-Inhalte können als vermeintliche Daten in Startkontext und Modellprompt gelangen, statt quarantänisiert und sichtbar als Storage-Fehler behandelt zu werden. |
| 5 | P1 | Memory-Ausschlüsse | Ausschlüsse beruhen auf einfachen Substring-Listen. Die Reproduktion ließ „Mein Passwort ist Fuchs-17“, eine Kartennummer und „Ich habe Diabetes“ passieren, während „Wir sitzen auf einer Parkbank“ wegen `bank` fälschlich ausgeschlossen wurde. | Sensible Inhalte werden sowohl übersehen als auch harmlose Gespräche verworfen; die Policy ist weder als Datenschutzgrenze noch fachlich zuverlässig. |
| 6 | P1 | Recall-Granularität | Findet der Startkontext in nur einer Nachricht einen Ausschluss, wird die komplette `conversation_id` verworfen. Eine Conversation entspricht derzeit einem ganzen App-Lauf und besitzt keine Turn-ID im Storage. | Ein einzelner Finanz- oder Gesundheitssatz kann beim nächsten Start sämtliche unabhängigen Gespräche desselben Arbeitstags aus dem Kontext entfernen. |
| 7 | P1 | Nachträgliche Policy | Neue Ausschlüsse oder das spätere Abschalten von Memory verhindern zwar weiteren Recall beziehungsweise neue Writes, löschen oder quarantänisieren aber keine bereits gespeicherten passenden Inhalte. | „Nicht merken“ wirkt nicht rückwirkend; sensible Daten bleiben unbegrenzt in der Datenbank und erscheinen wieder, sobald eine Sperre entfernt wird. |
| 8 | P1 | Datenmodell / Retention | Erfolgreiche normale Turns werden vollständig und zeitlich unbegrenzt als Rohtranskript gespeichert. Session-Protokoll, Kurzzeitspeicher und Langzeitgedächtnis sind weiterhin dieselbe `messages`-Ablage; die vorhandenen Facts-/Rules-Tabellen besitzen keinen produktiven Lebenszyklus. | Sarah sammelt mehr Inhalt als für ein kuratiertes Gedächtnis nötig und kann Relevanz, Verfall, Zweckbindung oder Löschung nicht getrennt steuern. |
| 9 | P1 | Aktiver Kontext | `RouterService.history` wächst während eines langen App-Laufs ohne Größen-, Turn- oder Zeitgrenze. Nur der an das Modell gesendete Ausschnitt wird gekürzt. | Ganztägige Sessions erhöhen RAM- und Prüfkosten dauerhaft; es gibt keine Komprimierung und keinen kontrollierten Übergang abgeschlossener Blöcke in den Kurzzeitspeicher. |
| 10 | P1 | Startkontext / Retrieval | Beim Start werden pauschal die letzten 20 vollständigen Roh-Nachrichten mit ihren ursprünglichen User-/Assistant-Rollen geladen. Relevanz, Thema, Aktualität, Fehlerhaftigkeit und Bezug zur aktuellen Frage werden nicht bewertet. | Alte Anweisungen, falsche Sarah-Antworten und irrelevante Gesprächsteile können neue Antworten prägen; wirklich relevante ältere Informationen fehlen zugleich. |
| 11 | P1 | Session-Lifecycle | Conversations werden beim Boot angelegt, aber `ended_at`, tatsächlicher Modus, Abschlusszustand und `summary` werden nie gesetzt. Ein normaler Abschluss, Crash und abgebrochene Verarbeitung sind im Datenmodell nicht unterscheidbar. | Kurator, Wiederaufnahme, Aufbewahrung und Recovery können später nicht zuverlässig entscheiden, welche Session vollständig und verarbeitbar ist. |
| 12 | P1 | Memory-Autor / Kontextpflege | Es gibt keinen produktiven Memory-Autor, keine kuratierbare Block-ID, keine persistente Pflegewarteschlange, keine atomaren Memory-Deltas und keinen Wiederaufnahmezustand. | Lange Gespräche werden weder thematisch verdichtet noch dedupliziert; Rückstände können im Leerlauf oder beim nächsten Start nicht kontrolliert nachgeholt werden. |
| 13 | P1 | Memory-Verwaltung | Explizites Merken, Quellenanzeige, Korrigieren, Vergessen, Löschen und Export besitzen keinen produktiven Servicevertrag. `/showcontext` bleibt auch bei aktivierter Einstellung bewusst nicht verfügbar. | Nutzer können nicht verlässlich erkennen oder kontrollieren, was Sarah über sie gespeichert hat; falsche Erinnerungen wären nicht korrigierbar. |
| 14 | P1 | Inkognito | `/anonymous` markiert nur genau einen Turn als transient. Es existieren weder ein mehrturniger Inkognito-Zustand noch sichtbarer Status, explizites Beenden, Chatsegment-Clear oder ein Lebenszyklus über Modellwechsel hinweg. | Das aktuelle Verhalten erfüllt den vereinbarten privaten Gesprächsmodus nicht und ist für Nutzer leicht mit einem fortbestehenden Inkognito-Modus zu verwechseln. |
| 15 | P1 | Transiente Ableitungen | Sobald ein Folgeturn privaten oder externen Kontext verwendet, entfernt `commitTurn()` anschließend sämtliche transienten Quellen und übernimmt auch den gerade vollständig beantworteten Folgeturn nicht in den Live-Kontext. | Nach genau einer abhängigen Rückfrage ist nicht nur der private/Fremddatenblock weg, sondern auch die normale Rückfrage samt Antwort; weitere Anschlussfragen verlieren unerwartet den Faden. |
| 16 | P1 | Nicht-Log-Vertrag | Routing und ActionService protokollieren rohe Modellentscheidungen beziehungsweise validierte Action-Parameter im Klartext. Auch ein anonymer Turn kann diese Pfade erreichen. | Suchbegriffe, Programmnamen oder künftig sensible Aktionsparameter umgehen die Memory-Policy und können in Terminal-/Diagnoseaufzeichnungen erscheinen. |
| 17 | P1 | Prompt-Layer | Nur einzelne Profilfelder werden begrenzt bereinigt. Skills, Charaktereigenschaften, benutzerdefinierte Eigenarten und Memory-Ausschlüsse gelangen ohne einheitliche Längen- und Strukturgrenzen in den Systemprompt. Das Schema akzeptierte im Repro einen Systemprompt mit mehr als 60.000 Zeichen. | Konfigurationsdaten können Promptregeln überschreiben, das Kontextfenster verdrängen oder die Worker-Anfrage unbrauchbar machen. |
| 18 | P1 | Kontextbudget | Das Budget verwendet pauschal vier Zeichen pro Token und berücksichtigt weder den echten Modell-Tokenizer noch Rollen-/Chat-Template-Overhead. Die behauptete Garantie, Systemprompt und aktuelle Nutzernachricht überlebten immer, wird nicht gegen die tatsächlich an Ollama gesendeten Tokens geprüft. | Besonders bei ausführlichem Stil, deutschen Texten und großen Promptfeldern kann Ollama erneut vorne kürzen oder die Anfrage überfüllen; zentrale Regeln beziehungsweise die aktuelle Frage sind dann nicht verlässlich geschützt. |
| 19 | P1 | Externe Daten | Die Suchzusammenfassung sendet Anweisung, Delimiter und fremde Snippets gemeinsam als einzelne User-Nachricht an das Worker-Modell. Es gibt keinen eigenen Systemvertrag und als Ergebnisprüfung nur „nicht leer“. | Prompt-Injection aus Suchtreffern kann zwar keine Action direkt ausführen, aber die sichtbare und gesprochene Zusammenfassung manipulieren oder Fremdanweisungen als vermeintliche Antwort ausgeben. |
| 20 | P1 | Bestätigungsstufen | `minimal` und `standard` haben für alle aktuellen Actions exakt dasselbe technische Verhalten, weil keine Action als `critical` klassifiziert ist und nur `maximal` Änderungen bestätigt. Die Standard-Promptregel wird vom separaten Router nicht ausgewertet. | Die UI-Zusage „Standard – Sarah fragt, wenn sinnvoll“ ist gegenwärtig wirkungslos; Nutzer erhalten nur bei `maximal` einen materiell anderen Schutz. |
| 21 | P1 | Zentrale Policy | Die vorhandene Risikomatrix entscheidet nur „Bestätigung erforderlich: ja/nein“. Benötigte Berechtigung, `deny`, `prepare_only`, externe Verbindlichkeit, Kosten und Datenfreigabe sind nicht Teil eines zentralen Action-Policy-Ergebnisses. | Neue Datei-, Kommunikations-, Buchungs- oder Kaufaktionen könnten ohne vorherigen vollständigen Layer-2-Vertrag uneinheitliche Einzelregeln einführen. |
| 22 | P1 | Voice / temporäre Daten | Faster-Whisper schreibt jede Äußerung unverschlüsselt unter einem aus `Date.now()` gebildeten Namen in den allgemeinen Temp-Ordner. Bereinigung erfolgt nur im `finally` des laufenden Requests; es gibt keinen privaten Temp-Bereich und keine Startbereinigung nach Prozess-/Systemabsturz. | Gesprochene, auch später als inkognito gedachte Inhalte können als WAV-Absturzrest außerhalb der verschlüsselten Storage-Grenze verbleiben. |
| 23 | P1 | Regressionstests | Die vorhandenen Layer-2-nahen Tests beweisen den aktuellen Happy Path, aber keine verpflichtende Secret-Matrix, kein fail-closed Config-Recovery, keine Ciphertext-Quarantäne, keinen mehrturnigen Inkognito-Lebenszyklus und keine Lösch-/Korrekturwege. Der Memory-Policy-Test besitzt derzeit nur zwei URL-Fälle. | Gerade die kritischen Datenschutz- und Recovery-Verträge können regressieren, obwohl die bestehende Suite vollständig grün bleibt. |
| 24 | P2 | Dateiberechtigung | `trust.fileAccess` ist in Wizard, Einstellungen und Schema auswählbar, wird aber an keiner produktiven Datei-/Ressourcengrenze ausgewertet. | Die Einstellung vermittelt bereits eine wirksame Berechtigung, obwohl sie aktuell nur Konfigurationsdaten darstellt. Vor allgemeinen Dateiaktionen fehlt die technische Schranke. |
| 25 | P2 | Storage-Integrität | `messages.conversation_id` besitzt keinen Foreign Key, `role` keine Check-Constraint und der generische Storage-Zugang kann verwaiste oder fachlich ungültige Zeilen erzeugen. | Beschädigte oder fehlerhaft migrierte Daten können die Turn-Rekonstruktion still verändern; sichere künftige Löschung und Session-Reparatur werden erschwert. |
| 26 | P2 | OAuth-Secrets / Recovery | Ein beschädigter oder nicht entschlüsselbarer Token-Store wird ohne sichtbaren Degraded-Zustand als leer behandelt. Beim nächsten Speichern kann die bisherige Datei überschrieben werden. | Verbindungen verschwinden kommentarlos; Schlüsselverlust und Datenkorruption sind für Nutzer nicht von „nie verbunden“ unterscheidbar. |

## 4. Umsetzung und unabhängige Kontrollaudits

Die 26 Erstbefunde wurden in fachlich getrennten Paketen umgesetzt und anschließend mehrfach unabhängig gegen den jeweils vollständigen Arbeitsbaum geprüft. Jeder Kontrollaudit blieb auf Layer 2 abwärts bis Layer 0 begrenzt und suchte zusätzlich zu den bekannten Punkten nach Folgefehlern.

| Stand | Ergebnis | Konsequenz |
|---|---:|---|
| Erstaudit | 2 × P0, 21 × P1, 3 × P2 | 26 Befunde vollständig implementiert. |
| 1. unabhängiger Kontrollaudit | 2 × P0, 15 × P1, 4 × P2 | 21 Rest- und Folgeursachen umgesetzt. |
| 2. unabhängiger Kontrollaudit | 0 × P0, 3 × P1, 3 × P2 | Sechs Punkte umgesetzt; wegen der vereinbarten Schwelle folgte ein weiterer Audit. |
| 3. unabhängiger Kontrollaudit | 0 × P0, 4 × P1, 0 × P2 | Vier Punkte umgesetzt; zunächst Ende der automatischen Auditfolge. |
| 4. unabhängiger Kontrollaudit | 0 × P0, 5 × P1, 2 × P2 | Sieben Punkte umgesetzt; auf ausdrücklichen Wunsch ausgeführt und wegen der Befundzahl erneut kontrolliert. |
| 5. unabhängiger Kontrollaudit | 0 × P0, 4 × P1, 6 × P2 | Zehn Punkte umgesetzt; ein während der Korrektur sichtbar gewordener OAuth-Refresh-Rennfehler wurde zusätzlich geschlossen. |
| 6. unabhängiger Kontrollaudit | 0 × P0, 3 × P1, 2 × P2 | Fünf Punkte umgesetzt; gemäß vereinbarter Schwelle folgt kein weiterer automatischer Audit. |

### Konsolidierte Befundliste der ersten drei Kontrollaudits

Die drei unabhängigen Kontrollaudits nach dem Erstaudit ergaben zusammen **31 Befunde: 2 × P0, 22 × P1 und 7 × P2**. Wiederkehrende Themen sind bewusst getrennt aufgeführt: Sie zeigen, an welchen Stellen eine erste Korrektur die Ursache nur teilweise geschlossen hatte und der nächste Negativtest eine engere Variante sichtbar machte.

#### 1. Kontrollaudit – 21 Befunde

| Nr. | Prio | Ursache | Umgesetzte Wirkung |
|---:|:---:|---|---|
| 1 | P0 | Fehlende `config.json` wurde trotz Sicherung wie eine Erstinstallation behandelt; Trust fiel auf permissive Defaults. | Authentifizierte Sicherung wird geladen, andernfalls gelten sichtbare fail-closed Trust-Werte. |
| 2 | P1 | `/anonymous Merk dir …` konnte private Daten in kuratierte Erinnerungen schreiben. | Private Turns und Remember-Intents werden vor jeder Memory-Mutation blockiert. |
| 3 | P0 | Klartext oder Objektwerte konnten an der Verschlüsselungsgrenze als Legacy-Daten gelesen werden. | Nur authentifizierte Formate sind lesbar; Downgrades werden als Integritätsfehler behandelt. |
| 4 | P1 | Ein falscher oder fehlender Schlüssel konnte Originaldaten destruktiv entfernen oder still ersetzt werden. | Originale bleiben bestehen, Quarantänen sind wiederherstellbare Kopien und bestehende Stores erhalten keinen Ersatzschlüssel. |
| 5 | P1 | Ciphertexte waren nicht an Config-Key beziehungsweise Tabelle, Zeile und Spalte gebunden. | V2-AAD bindet jeden geschützten Wert an seine konkrete Identität. |
| 6 | P1 | Die unveränderliche Secret-Sperre übersah verbreitete Geheimnisse und Identifikationsdaten. | Die Secret-Matrix wurde erweitert und in späteren Audits weiter verschärft. |
| 7 | P1 | Neue Ausschlüsse löschten paraphrasierte Erinnerungen ohne erhaltene Quellbeziehung nicht. | Staging-, Conversation- und Turn-Provenienz verbindet Rohturn und Erinnerung für rückwirkende Löschung. |
| 8 | P1 | Explizite Remember- und Korrekturpfade konnten die allgemeine Persistence-Policy umgehen. | Alle expliziten Memory-Writes verwenden dieselbe aktuelle Ausschluss- und Secret-Policy. |
| 9 | P1 | Fehler der rückwirkenden Policy-Bereinigung wurden verschluckt. | Cleanup-Fehler werden propagiert und sperren weitere Persistenz fail-closed. |
| 10 | P1 | Ein laufender Turn konnte nach einer restriktiveren Trust-Änderung noch mit der alten Policy persistieren. | Commit verwendet den strengeren Draft-/Live-Vertrag und eine serialisierte Memory-Mutationsbarriere. |
| 11 | P1 | Messages und Staging wurden getrennt geschrieben und konnten als halber Turn zurückbleiben. | Turn-Messages und Staging entstehen atomar in einer SQLite-Transaktion. |
| 12 | P2 | Nach einem Prozessabbruch blieben Curator-Jobs dauerhaft auf `processing`. | Lease-basierte Restart-Recovery setzt verwaiste Jobs kontrolliert zurück. |
| 13 | P2 | Fehlerhafte Curator-Jobs blockierten mit unbegrenzten Wiederholungen die Queue. | Begrenzte Versuche, Backoff, Dead-Letter und bereinigte Rohquellen verhindern Starvation. |
| 14 | P1 | Das Kontextbudget unterschätzte tokenizerungünstige Eingaben und konnte `num_ctx` überschreiten. | Konservative UTF-8-Byte-Grenze, Reserven und harte Ablehnung nicht passend kürzbarer Requests. |
| 15 | P1 | Fremde Such-Snippets wurden durch ein instruktionsfolgendes LLM zusammengefasst. | Produktive Übersichten sind deterministisch; untrusted Snippets gelangen nicht mehr zum Modell. |
| 16 | P1 | Ein vorhersehbarer maschinenbasierter Schlüssel diente als produktiver Fallback. | Produktion verlangt Electron `safeStorage`; ein Testschlüssel muss ausdrücklich gesetzt werden. |
| 17 | P1 | Browser-Bestätigungen waren nicht an die konkrete Search-Session gebunden. | `sourceRequestId` wird beim einmaligen Consume exakt geprüft. |
| 18 | P1 | `scan-folder-exes` konnte `fileAccess` und erlaubte Ordner umgehen. | Kanonische Live-Policy-Prüfung und einmalige native Auswahlfreigaben begrenzen den Zugriff. |
| 19 | P1 | Fehlende oder beschädigte OAuth-Primärdaten erschienen als „keine Verbindungen“ und konnten überschrieben werden. | Primary-/Backup-Recovery, atomare Writes und schreibgesperrter Degraded-Zustand. |
| 20 | P2 | Voice-Inkognito setzte seine sichtbare Löschgrenze auf eine ältere normale Bubble. | Die Grenze wird an die User-Bubble des exakten `turnId` gebunden. |
| 21 | P2 | Kritische Negativpfade waren nicht regressionsgesichert. | Recovery-, Privacy-, Confirmation-, IPC-, Kontext- und Voice-Regressionen wurden ergänzt. |

#### 2. Kontrollaudit – 6 Befunde

| Nr. | Prio | Ursache | Umgesetzte Wirkung |
|---:|:---:|---|---|
| 1 | P1 | Weitere 2FA-, Verifizierungs-, Auth-, Bearer- und SSH-Secrets fehlten in der Matrix. | Secret-Erkennung erneut erweitert; der dritte Audit prüfte weitere Schreibweisen. |
| 2 | P1 | Ausgeblendete korrupte Memory-Zeilen und Quarantänen blieben für Policy-Cleanup unsichtbar. | Atomare Layer-2-Purge-Pfade beziehen unreadable Originale und rekursive Quarantänen ein. |
| 3 | P1 | Ungültiges `memoryExclusions` wurde zu einer leeren Liste repariert, während Memory aktiv blieb. | Unbekannte Ausschlusssemantik setzt `memoryAllowed=false`. |
| 4 | P2 | Ungebundene V1-DB-Ciphertexte konnten nach einem Zeilenwechsel automatisch als V2 legitimiert werden. | DB-Altwerte werden isoliert und niemals automatisch neu gebunden. |
| 5 | P2 | `policy_terms` bewahrte bis zu 12.000 Zeichen normalisierte Rohprovenienz. | Gesalzene, nicht umkehrbare Fingerprints ersetzen die Wortfolge; Altwerte werden kontrolliert migriert. |
| 6 | P2 | Entfernte Inkognito-Nodes blieben im Renderer referenziert. | Terminal- und Abschnittslöschung räumen die Turn-Referenzen mit auf. |

#### 3. Kontrollaudit – 4 Befunde

| Nr. | Prio | Ursache | Umgesetzte Wirkung |
|---:|:---:|---|---|
| 1 | P1 | MFA-, TOTP-, Backup-Code-, GitHub-Token-, Seed-Phrase- und JWT-Begriffe fehlten weiterhin. | Die unveränderliche Secret-Matrix deckt auch diese Varianten ab. |
| 2 | P1 | Eine quarantänisierte Message löschte Staging und abgeleitete Erinnerungen nicht vollständig. | Die atomare Provenienz-Kaskade entfernt Turn, Staging, Memories und rekursive Quarantänen. |
| 3 | P1 | Der Gesamt-Purge ließ `learned_facts` sowie nutzerbezogene persistente und Session-Regeln zurück. | Alle Layer-2-Altbestände werden bereinigt; unveränderliche `absolute_rules` bleiben erhalten. |
| 4 | P1 | Sicher isolierte ungebundene Altwerte hatten keinen nutzbaren Wiederherstellungspfad. | Expliziter Review mit Warnung, Vorschau, Zustimmung, Vollbackup, Compare-before-write und atomarem V2-Restore. |

#### 4. Kontrollaudit – 7 Befunde

| Nr. | Prio | Ursache | Umgesetzte Wirkung |
|---:|:---:|---|---|
| 1 | P1 | Ein älteres gültiges Config-Backup konnte neuere restriktive Trust-Werte permissiv zurückrollen. | Jeder Recovery-Stand wird bis zur sichtbaren Bestätigung auf fail-closed Trust geklemmt; fehlendes `root` gilt nicht als Erstinstallation. |
| 2 | P1 | Ein gelöschter OAuth-Token blieb im historischen Backup und konnte nach Primärschaden wieder erscheinen. | Primärdatei und Sicherung spiegeln denselben aktuellen verschlüsselten Stand; Löschung und Rotation können nicht zurückrollen. |
| 3 | P1 | Restriktive Memory-Wechsel stoppten laufende oder während der Bereinigung gestartete Recall-Turns nicht. | Betroffene Recall-Turns werden gezielt abgebrochen; neue Worker-Turns warten auf die autoritative Policy. |
| 4 | P1 | Policy-Cleanup verschob während Inkognito den gespeicherten History-Arrayindex. | Private History wird über konkrete Turn-IDs statt über eine veraltbare Position entfernt. |
| 5 | P1 | Fachliche Exclusions ließen Bankkonto/Sparkasse, Namen Dritter und Gesundheitszustand durch; der Curator prüfte nur Secrets. | Tokenbasierte Kategorien und ein erneuter Live-Policy-Check unmittelbar vor dem Curator-Write schließen den Pfad. |
| 6 | P2 | Neue Exclusions erfassten Legacy-Facts/-Rules nicht; Memory-Off ließ Conversation-Summaries und Quarantänen zurück. | Atomare Legacy- und Summary-Purge-Pfade bereinigen lesbare, unlesbare und quarantänisierte Werte; `absolute_rules` bleiben erhalten. |
| 7 | P2 | Private Search-Sessions und der Ergebniszeiger überlebten das Ende eines Inkognito-Abschnitts. | Private Ergebnis-Sessions werden beim Modusende oder einem überlappenden Abschluss gezielt verworfen; normale Suchen bleiben bestehen. |

#### 5. Kontrollaudit – 10 Befunde

| Nr. | Prio | Ursache | Umgesetzte Wirkung |
|---:|:---:|---|---|
| 1 | P1 | Secret-Labels in `.env`-Schreibweise und mit unsichtbaren Unicode-Zeichen konnten die unveränderliche Sperre umgehen. | Normalisierung entfernt Formatzeichen und erkennt Unterstrich-/Bindestrichvarianten ohne harmlose Teilwörter zu sperren. |
| 2 | P1 | Die Kategorie „Namen Dritter“ erkannte nur einzelne Beispielsbegriffe. | Die Kategorie arbeitet bewusst fail-closed: Solange sie aktiv ist, bleibt jeder Gesprächsturn flüchtig. |
| 3 | P1 | Nach fehlgeschlagener Policy-Bereinigung meldete ein identischer Config-Retry Erfolg, ohne die Bereinigung erneut auszuführen. | Ein Recovery-Marker erzwingt die Wiederholung; ohne erfolgreichen Router-Cleanup wird kein Erfolg gemeldet. |
| 4 | P1 | Zwei Electron-Instanzen konnten gleichzeitig auf Config, DB, Token-Store und Whisper-Ressourcen zugreifen. | Ein früher Single-Instance-Lock stoppt den Sekundärprozess; ein erneuter Start fokussiert das vorhandene Fenster. |
| 5 | P2 | Ein aktiver Inkognito-Modus ließ sich nach dem Deaktivieren der Funktion nicht mehr beenden. | Das Beenden eines bereits aktiven privaten Abschnitts bleibt unabhängig von der aktuellen Startfreigabe möglich. |
| 6 | P2 | Formal erfolgreiche, aber fachlich ungültige OAuth-2xx-Antworten konnten Primary und Backup vergiften. | Tokenantwort und Store-Eintrag werden strikt auf Tokens, Ablaufzeit und Scope validiert. |
| 7 | P2 | Ein Absturz zwischen Backup- und Primary-Publish konnte einen gelöschten OAuth-Token wiederherstellen. | Versionierte Commit-Envelopes mit Generation und Commit-ID wählen den neuesten gültigen Stand, auch bei Lösch-Commits. |
| 8 | P2 | `fileAccess=none` sperrte Ordnerscans, aber nicht die automatische Programmerkennung. | Auch `detect-programs` wird an der produktiven IPC-Grenze durch die Live-Policy blockiert. |
| 9 | P2 | Ein Fehler beim Löschen der temporären WAV-Datei konnte ein erfolgreiches Transkript überschreiben. | Cleanup-Fehler werden gemeldet, verändern aber weder Transkript noch ursprünglichen Transkriptionsfehler. |
| 10 | P2 | Native Ordnerfreigaben überlebten Policy-Wechsel und waren weder zeitlich noch an den aufrufenden Renderer gebunden. | Auswahlfreigaben sind einmalig, kurzlebig, sendergebunden und werden bei Trust-Änderungen invalidiert. |

Während dieser Korrektur wurde zusätzlich ein OAuth-Refresh-Rennfehler sichtbar: Parallele Refreshes konnten einen bereits rotierten Token überschreiben oder nach einem verspäteten Fehler löschen. Providerbezogenes Single-flight und ein Vergleich mit dem aktuellen Store-Stand verhindern beides. Dieser Zusatzpunkt verändert die Audit-Zählung nicht.

#### 6. Kontrollaudit – 5 Befunde

| Nr. | Prio | Ursache | Umgesetzte Wirkung |
|---:|:---:|---|---|
| 1 | P1 | Gebräuchliche Finanz-, Versicherungs- und Gesundheitsbegriffe wie Kontonummer, BIC, Depot, Versicherungsnummer, Blutdruck und Depression fehlten. | Klare Datenlabels sind unveränderlich gesperrt; Kategorien erkennen zusätzliche vollständige Fachbegriffe ohne Substring-Falschpositive. |
| 2 | P1 | Eine bestätigungspflichtige Websuche persistierte Anfrage und Bestätigung, bevor ein Suchergebnis als Fremddaten markiert wurde. | Bereits der validierte `web_search`-Intent macht bei ausgeschlossenen Browser-Daten sowohl Anfrage- als auch `/confirm`-Turn flüchtig. |
| 3 | P1 | Harte Prozess- oder Systemabbrüche hinterließen private Klartext-WAVs im Temp-Verzeichnis. | Der nächste Providerstart entfernt ausschließlich exakt benannte, echte Sarah-STT-Verzeichnisse und folgt keinen Symlinks. |
| 4 | P2 | Ein temporärer OAuth-Netzwerk-, Timeout- oder Serverfehler löschte den weiterhin gültigen Refresh-Token. | Nur definitive OAuth-Ablehnungen invalidieren den Token; transiente Fehler bleiben retrybar. |
| 5 | P2 | Anzahl und Länge von `memoryExclusions` waren unbegrenzt und konnten Main-Prozess und Cleanup blockieren. | Schema, IPC und Policy begrenzen auf 16 normalisierte Einträge mit jeweils höchstens 80 Zeichen und behandeln Umgehungen fail-closed. |

Die sieben Fixrunden schließen damit die sechs unabhängigen Kontrollaudits. Altwerte werden nie automatisch in den Kontext übernommen: Die Einstellungen zeigen Tabelle, Zeile, Spalte und eine begrenzte Vorschau, warnen vor der fehlenden historischen Herkunftsbindung und erstellen vor einem atomaren V2-Restore eine vollständige SQLite-Sicherung.

Der technisch geprüfte Endstand umfasst:

- fail-closed Konfigurations- und Schlüssel-Recovery mit atomaren Sicherungen,
- V2-Verschlüsselung mit Tabellen-/Zeilen-/Spalten-AAD und nicht-destruktiver Quarantäne,
- atomare Turn-/Staging-Persistenz, Crash-Recovery, begrenzte Curator-Retries und datensparsame Provenienz-Fingerprints,
- query-bezogenen Recall, begrenzten Live-Kontext und tokenizerunabhängig konservatives Kontextbudget,
- mehrturniges Inkognito sowie flüchtiges `/anonymous` ohne Memory-Sonderweg,
- zentrale Action-Policy, exakt gebundene Bestätigungen und technisch erzwungenen Datei-Scan-Zugriff,
- deterministische Suchübersichten ohne LLM-Verarbeitung fremder Snippets,
- sichtbare OAuth-/Storage-Degraded-Zustände und sichere Temp-Audio-Verarbeitung.
- Single-Instance-Schutz, versionierte OAuth-Commits und retrybare Refresh-Fehler ohne Tokenverlust.

Nach dem gemeinsamen Abschluss der Bestätigungs- und Browsergrenzen lief die vollständige Suite mit **107 Testdateien und 1.371 Tests** erfolgreich. Beide Typechecks, der Produktionsbuild und `git diff --check` sind grün; `better-sqlite3` wurde anschließend wieder für Electron 41.1.1 hergestellt.

Die praktische Windows-Abnahme vom 29. August 2026 hat alle zehn Testblöcke bestanden:

| Block | Praktischer Umfang | Stand |
|---:|---|:---:|
| 1 | Anonymous in Chat und Voice, temporärer Gesprächskontext, Wechsel zwischen Chat und Sprache sowie Verwerfen beim Beenden | bestanden |
| 2 | Erinnern, Anzeigen, Exportieren, Korrigieren und Löschen | bestanden |
| 3 | Policy-Wechsel während eines laufenden Turns | bestanden |
| 4 | Secret-Schutz in Text und Voice einschließlich Neustartprüfung | bestanden |
| 5 | Text- und Sprachbestätigungen einschließlich natürlicher Bestätigung, Abbruch und eindeutigem Pending-Zustand | bestanden |
| 6 | OAuth-, Storage-, Schlüssel- und Quarantäneanzeigen | bestanden |
| 7 | Legacy-/Recovery-Dialoge mit Annahme und Abbruch | bestanden |
| 8 | Getrennte Browser- und Speicherfreigabe, Fremdinhalte sowie stabiler Bezug auf vorherige Suchergebnisse | bestanden |
| 9 | Modell-, Voice- und Renderer-Crash-Recovery | bestanden |
| 10 | Windows-Schließen und begrenzter Shutdown-Drain | bestanden |

Die Blöcke 5 und 8 wurden gemeinsam geschlossen: Webzugriff benötigt bei aktivierter Berechtigung keine Bestätigung pro Suche, während echte bestätigungspflichtige Aktionen eine natürliche, eindeutig an genau eine Aktion gebundene Bestätigungs- oder Abbruchfolge besitzen. „Browser verwenden“ steuert die Funktion unabhängig davon, ob Browser-Daten dauerhaft gespeichert werden dürfen. Nummerierte oder benannte Verweise öffnen Ergebnisse aus der konkreten erfolgreichen Search-Session, ohne eine neue Suche auszulösen. Die technische `/confirm`-ID bleibt als Text-Fallback sichtbar, wird aber nicht vorgelesen. Layer 2 ist damit technisch und in allen zehn praktischen Windows-Blöcken abgenommen.

Zusätzlich wurden die Slash-Command-Vorschau praktisch bedient und die Renderer-Recovery automatisiert regressionsgeprüft. /deletememory all ist technisch umgesetzt und automatisiert geprüft; die praktische Bestätigungsfolge wird bei der nächsten vorhandenen Test-Erinnerung nebenbei abgenommen.

## 5. Nicht als Befund gezählte offene Kuratorentscheidung

Die konkrete Kontextpflege-Orchestrierung ist noch bewusst offen und wird daher nicht zusätzlich als mehrere Fehler gezählt. Fest steht derzeit:

- Router-Modell und 8B-Worker können auf Martins Zielsystem nicht ungeprüft parallel vorausgesetzt werden.
- Der Kurator ist eine Steuerungskomponente, kein zweites Modell.
- Zunächst soll dasselbe 8B-Modell kleine, atomare Pflegeblöcke bearbeiten.
- Nutzereingaben besitzen Vorrang; vollständige Blöcke bleiben erhalten, unvollständige Ergebnisse werden nie gespeichert.
- Nach längerer Inaktivität darf bei relevantem Rückstand ein begrenztes Nachholfenster das 8B erneut starten.
- Der Pflegezustand soll sichtbar sein; Modellwechsel dürfen mit einer ehrlichen Wartezeitmeldung überbrückt werden.

Noch zu entscheiden sind Startschwellen, Pflegebudget, F9-/Wake-Word-Abschlussfrist, Tray-/Vollbeenden-Verhalten und die Frage, ob Messwerte später ein zusätzliches deutlich kleineres Kuratorenmodell rechtfertigen. Diese Betriebsparameter gehören in eine eigene Weiterentwicklung der Kontextpflege und blockieren den technisch abgesicherten Layer-2-Speichervertrag nicht.

## 6. Audit-Verifikation des Ausgangsstands

- Geprüft wurden Konfigurationsschema und -recovery, Prompt-Layer, Kontextfenster, ConversationStore, Memory-Policy, verschlüsselter Storage, Router, Slash-Commands, Action-Bestätigungen, Suche/Fremddaten, Modellruntime, Voice-Tempdaten und OAuth-Token-Storage.
- Acht gezielte bestehende Testdateien mit **95 Tests** liefen grün. Das bestätigt den aktuellen Stand, widerlegt aber die Befunde nicht, weil mehrere Tests das noch zu ersetzende Verhalten ausdrücklich festschreiben.
- Direkte Reproduktionen bestätigten:
  - ungültige Fremdkonfiguration führt zu Defaults `memoryAllowed=true` und `confirmationLevel=standard`,
  - die sensible Ausschlussmatrix übersieht Passwort, Kartennummer und Diabetes,
  - der Substring-Ansatz sperrt „Parkbank“ fälschlich,
  - ungebundene Promptfelder erzeugen ohne Schemafehler einen Systemprompt mit mehr als 60.000 Zeichen.
- Es wurden keine Produktivdateien geändert, keine Befunde behoben und keine praktische Windows-Abnahme durchgeführt.

## 7. Ursprüngliche Umsetzungsreihenfolge

1. **Fail-closed Trust- und Secret-Grenzen:** Befunde 1 bis 5 sowie 16.
2. **Speichervertrag und Inkognito:** Befunde 6 bis 15.
3. **Prompt-, Fremddaten- und Kontextbudget:** Befunde 17 bis 19.
4. **Policy und Berechtigungen:** Befunde 20, 21 und 24.
5. **Untere Datenschutz-/Integritätspfade:** Befunde 22, 25 und 26.
6. **Verbindliche Layer-2-Regressionsmatrix:** Befund 23 gemeinsam mit jedem Paket ausbauen.

Diese Reihenfolge wurde in den sieben dokumentierten Fixrunden umgesetzt. Die damaligen P0-Blocker sind geschlossen; als nächster Schritt folgt die praktische Layer-2-Abnahme.
