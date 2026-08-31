# Memory Author — Themen, Aussagen und gepflegter Recall

**Stand:** 31.08.2026

**Branch:** `feat/memory-author`

**Primärer Layer:** Layer 2 — Kontext, Memory, Regeln und Berechtigungen

**Technischer Stand:** Implementiert und automatisiert geprüft. Die praktische Modell-/Voice-Abnahme sowie die produktive Datenbereinigung stehen bewusst noch aus.

## 1. Ziel

Sarah soll neue, dauerhaft relevante Nutzeraussagen nicht mehr als voneinander isolierte Kurztexte ablegen. Der bestehende Curator wird zu einem Memory Author erweitert, der:

- Aussagen einem stabilen Thema wie `Schach`, `Fahrrad` oder `Projekt S.A.R.A.H.` zuordnet,
- sinngleiche Wiederholungen ignoriert,
- neue Aussagen einem bestehenden Thema hinzufügt,
- klare Aktualisierungen und Widersprüche als neue Revision einordnet,
- ersetzte Aussagen aus dem aktiven Recall entfernt, ohne ihre Herkunft zu verlieren,
- unklare oder nur temporäre Stimmungen nicht als dauerhafte Wahrheit übernimmt,
- ausschließlich validierte, atomare Deltas gegen vorher angebotene Datensätze ausführen lässt.

Eine Themenkarte ist eine Darstellung mehrerer einzelner Aussagen. Es wird kein ständig wachsender, frei formulierter Themen-Fließtext überschrieben.

## 2. Verbindliche Abgrenzung

In diesem Paket enthalten:

- migrationssicheres Themen-, Aussagen- und Quellenmodell,
- atomare `add`, `update`, `merge`, `supersede` und `ignore`-Entscheidungen,
- zweistufige Extraktion und Bestandsentscheidung mit dem bestehenden 8B-Worker,
- konservatives Kontextbudget für beide Curator-Aufrufe,
- Recall ausschließlich aus aktiven Aussagen,
- kompatible Memory-Commands und diagnostische Ausgabe,
- automatisierter isolierter Schach-/Fahrrad-/Coding-Test.

Bewusst danach:

- produktive Bereinigung der vorhandenen Nutzer-Datenbank,
- grafische Memory-Verwaltung mit Themenkarten,
- natürlicher Befehl „Vergiss alles über Thema X“ ohne sichtbare ID,
- Embeddings oder ein zusätzlicher Vektorindex,
- `DecisionContext`, Planner und Evaluator.

## 3. Datenmodell

### Themen

`memory_topics` besitzt eine stabile ID, einen verschlüsselten Titel, eine Version für Stale-Write-Schutz sowie Erstellungs-, Änderungs- und Löschzeitpunkt.

### Aussagen

`curated_memories` bleibt die zentrale Tabelle einzelner Erinnerungen und erhält:

- `topic_id`,
- `status: active | superseded | deleted`,
- `revision`,
- `superseded_by_id`,
- `created_by_action`,
- einen kurzen verschlüsselten Nutzerbeleg,
- Bestätigungszähler und letzten Bestätigungszeitpunkt.

Eine Aktualisierung verändert eine Aussage nicht still in-place. Sie erzeugt eine neue aktive Aussage und markiert die vorherige atomar als ersetzt.

### Quellen

`memory_sources` hält die belegbaren Turn-, Explicit-, Manual- oder Legacy-Quellen einer Aussage. Zusammengeführte Ergebnisse behalten die Vereinigungsmenge ihrer Quellen, damit spätere Privacy-Regeln abgeleitete Inhalte fail-closed entfernen können.

Legacy-Erinnerungen werden technisch migriert, aber nicht automatisch semantisch umgedeutet. Sie bleiben zunächst aktive, unsortierte Einzelkarten.

## 4. Memory-Author-Ablauf

1. Ein persistierbarer Turn wird wie bisher atomar in `memory_staging` vorgemerkt.
2. Extraktion erzeugt in der ersten belastbaren Version höchstens eine streng validierte Kernaussage mit Thema, Dauerhaftigkeit, Konfidenz und echtem User-Beleg. Mehrere Kandidaten in einem einzelnen Turn bleiben eine spätere, atomar zu erweiternde Funktion.
3. Nur der User-Anteil darf eine Erinnerung belegen; Assistant-Text ist niemals eigenständige Faktenquelle.
4. Der Store wählt deterministisch höchstens vier passende aktive Aussagen aus.
5. Der zweite Modellaufruf entscheidet nur über ein Schema-Delta gegen diese IDs.
6. Policy, Ziel-IDs, Revisionen und Themenversion werden unmittelbar vor dem Commit erneut geprüft.
7. Alle Änderungen, Quellen, Staging-Abschluss und Entfernung des Rohturns erfolgen vollständig oder gar nicht.
8. Erst nach erfolgreichem Commit wird der Recall-Cache aktualisiert.

## 5. Entscheidungsregeln

- `ignore`: Duplikat, temporär, unklar oder nicht belegt.
- `add`: neue eigenständige Aussage in einem neuen oder bestehenden Thema.
- `update`: präzisierte Fassung derselben Aussage; alter Stand wird ersetzt.
- `supersede`: klare aktuelle Revision oder ausdrückliche Korrektur.
- `merge`: belegbar überlappende Aussagen innerhalb eines Themas werden ohne freien ungeprüften SQL- oder Text-Write zusammengeführt.

„Heute nervt mich Schach“ ersetzt keine dauerhafte Präferenz. „Ich mag Schach nicht mehr“ kann eine bisher aktive Präferenz ersetzen. Bei Mehrdeutigkeit wird nichts überschrieben.

## 6. Sicherheits- und Betriebsvertrag

- Themen, Belege und Inhalte bleiben mit zeilen-/spaltengebundener V2-AAD verschlüsselt.
- Secrets, Memory-Ausschlüsse, Inkognito und live geänderte Policies bleiben vor jedem Commit fail-closed.
- Abbruch durch neue Nutzereingabe schreibt kein Teilergebnis.
- Modell-/JSON-Fehler verwenden die bestehende begrenzte Retry-/Dead-Letter-Logik.
- Stale-Entscheidungen verändern nichts und werden ohne Teilcommit neu eingeordnet.
- Beide Modellaufrufe verwenden den konservativen Kontextplaner innerhalb des realen 4.096er Workerfensters.
- Recall enthält ausschließlich aktive, lesbare und policy-konforme Aussagen.

## 7. Automatische Abnahme

- Schema-v3→v4-Migration einschließlich Rollback, Fremdschlüssel und bestehender Ciphertexte,
- AAD-/Quarantäneprüfungen für neue verschlüsselte Felder,
- atomare Deltas und Stale-Write-Abweisung,
- Duplicate→Ignore, neues Detail→Add, klare Revision→Supersede, unklare Stimmung→Ignore,
- erfundene oder nicht angebotene Ziel-ID wird abgewiesen,
- aktiver Recall enthält keine ersetzten oder gelöschten Aussagen,
- Cache-, Abbruch-, Retry-, Neustart- und Policy-Wechsel-Regressionsfälle,
- bestehende `/remember`, `/showcontext`, `/correctmemory`, `/forget`, `/deletememory` und `/exportmemory`-Verträge,
- vollständige Suite, beide Typechecks, Produktionsbuild und Diff-Prüfung.

Ergebnis des technischen Gates:

- fokussierte Memory-/Router-Abnahme: 228/228 Tests,
- vollständige Suite: 114 Dateien, 1.650 Tests,
- Main- und Renderer-Typecheck: grün,
- Produktionsbuild: grün,
- zusätzliche Schlussprüfung: Sicherheits-Datenmarker bleiben auch bei Trunkierung geschlossen; der Neustart-Startkontext lädt ausschließlich aktive Aussagen.

## 8. Gemeinsame praktische Abnahme

Nach der technischen Abnahme verwenden wir zunächst eine isolierte Testdatenbank:

1. Schach-Aussage A,
2. Fahrrad-Aussage A,
3. Schach-Aussage B,
4. sinngemäße Wiederholung von Schach A,
5. Coding-/S.A.R.A.H.-Projektinformation,
6. zweite Fahrradaussage,
7. temporäre negative Schach-Stimmung,
8. klare dauerhafte Schach-Korrektur,
9. Neustart und identische Recall-Fragen,
10. gezieltes Vergessen einer sichtbaren Aussage.

Erwartet werden drei Themenkarten, keine doppelte Schach-Aussage, nur die aktuelle widerspruchsfreie Präferenz im Recall sowie identisches Verhalten nach Neustart.

## 9. Produktive Bereinigung danach

Erst nach gemeinsamer Abnahme wird der bestehende Nutzerbestand separat behandelt:

1. Sarah vollständig schließen,
2. vollständige verschlüsselte SQLite-Datei einschließlich Sidecars sichern,
3. Hash und exakte Tabellen-/Zeilenzahlen anzeigen,
4. den konkreten Löschumfang erneut bestätigen,
5. ausschließlich Layer-2-Memory-Daten atomar bereinigen,
6. Privacy-Finalisierung und Neustartprüfung durchführen.

Profil, Einstellungen, Programme, Verbindungen sowie Timer und geplante Erinnerungen gehören nicht automatisch zu dieser Bereinigung.
