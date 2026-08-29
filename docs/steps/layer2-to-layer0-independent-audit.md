# S.A.R.A.H. — Aktiver Auditbestand Layer 2 bis Layer 0

**Auditdatum:** 28.08.2026
**Arbeitsstand:** Branch codex/layer2-audit-1
**Scope:** Layer 2 und die von Layer 2 berührten Verträge in Layer 1 und Layer 0.
**Zweck:** Ausschließlich noch offene oder bewusst geparkte Themen. Erledigte, widerlegte und doppelte Befunde werden nicht als aktive Punkte weitergeführt.

## Aktueller Stand

Nach drei Umsetzungsrunden bleiben **27 eigenständige Themen**:

| Verifikation | Entscheidung | Anzahl |
|---|---|---:|
| bestätigt | Produktentscheidung vor Umsetzung erforderlich | 1 |
| bestätigt | derzeit nachrangig | 4 |
| teilweise berechtigt | nachrangig oder bedingt | 17 |
| nicht bestätigt | nur bei geänderter Architektur neu prüfen | 5 |
| **Gesamt** |  | **27** |

Die erste Runde hat **42 bestätigte Befunde**, die zweite Runde **8 wichtige teilweise berechtigte Befunde** und die dritte Runde **11 weiterhin relevante Hardening-Punkte** umgesetzt. Diese Punkte sind aus dem aktiven Arbeitsbestand entfernt. Zwei weitere teilweise berechtigte Befunde wurden beim erneuten Codeabgleich geschlossen.

### Prüfung nach der dritten Umsetzungsrunde

| Prüfung | Ergebnis |
|---|---|
| npm test | **107 Testdateien, 1.371 Tests, alle grün** |
| Typecheck Main | grün |
| Typecheck Renderer | grün |
| npm run build | grün |
| git diff --check | grün; nur vorhandene LF/CRLF-Hinweise |
| Praktische Windows-Abnahme | **10 von 10 Blöcken bestanden** |

Die grünen automatisierten Prüfungen und die vollständige praktische Windows-Abnahme belegen gemeinsam den aktuellen Layer-2-Stand. Sie ersetzen keine spätere Layer-3-Gesamtprüfung oder Penetrationsprüfung.

## Entscheidungsmatrix

| Verifikation | Entscheidung | IDs |
|---|---|---|
| bestätigt | entschieden und technisch umgesetzt; praktische Windows-Abnahme offen | **B-02** |
| bestätigt | derzeit nachrangig | **C-16, D-12, E-15, F-08** |
| teilweise berechtigt | nachrangig oder bedingt | **A-07, A-10, A-11, B-06, B-07, B-09, B-11, C-08, C-14, D-04, D-14, E-07, E-10, E-11, F-04, F-09, G-10** |
| nicht bestätigt | nur bei geänderter Architektur neu prüfen | **E-12, E-13, G-13, G-15, G-16** |

---

## B-02 — entschieden, technisch umgesetzt und praktisch abgenommen

### B-02 — Kein fachlich definierter Weg nach endgültigem Schlüsselverlust

**Was Runde 1 bereits verbessert hat:** Der Hauptschlüssel besitzt jetzt eine zweite, durable Kopie; Schreibvorgänge werden synchronisiert, und eine fehlende oder beschädigte Primärdatei kann aus der Sicherung wiederhergestellt werden.

**Was technisch nicht automatisch lösbar ist:** Sind beide DPAPI-gebundenen Kopien nach Windows-Konto-, Profil- oder DPAPI-Verlust nicht mehr entschlüsselbar, können die verschlüsselten Daten ohne separates Recovery-Geheimnis nicht gerettet werden.

**Empfehlung:** Ein expliziter destruktiver Reset-Pfad ist für das lokale Desktop-Produkt derzeit die einfachste ehrliche Lösung:

1. unlesbare Stores nicht still überschreiben, sondern für mögliche manuelle Recovery sichern;
2. Nutzer klar über den endgültigen Datenverlust informieren;
3. Reset ausdrücklich bestätigen lassen;
4. erst dann aktive verschlüsselte Daten zurücksetzen und einen neuen Schlüssel erzeugen.

**Alternative:** Ein externer Recovery-Key oder ein separates Recovery-Passwort ermöglicht echte Datenrettung, erhöht aber Schlüsselverwaltung, UX-, Support- und Sicherheitsaufwand erheblich. Diese Alternative sollte nur mit einer bewussten Produktentscheidung eingeführt werden.

**Produktentscheidung für Phase 1:** Die explizite Reset-Variante wird verwendet. Ein Recovery-Passwortsystem bleibt ein möglicher späterer Ausbau und ist nicht Bestandteil des vorläufigen Layer-2-Abschlusses.

**Stand:** Sarah unterscheidet vorübergehend nicht verfügbaren Betriebssystem-Schlüsselschutz von endgültig fehlenden oder unlesbaren Schlüsselkopien. Vorübergehende Fehler erhalten einen Erstversuch plus zwei begrenzte Neuversuche und lösen niemals einen Reset aus. Bei endgültigem Schlüsselverlust verlangt der native Startpfad eine ausdrückliche Bestätigung, archiviert Schlüssel, Config, Datenbank einschließlich SQLite-Sidecars und OAuth-Speicher, prüft den Zustand unmittelbar vor der Mutation erneut und erzeugt erst nach vollständigem Archiv einen frischen Schlüssel. Automatisierte Tests sind grün. Unter Windows wurden Abbruch, Archivierung/Reset und anschließender Neustart praktisch abgenommen.

---

## Nachrangig oder nur unter Bedingungen relevant

Diese Punkte bleiben dokumentiert, werden aber erst durch einen konkreten Trigger relevant oder haben im heutigen Produktpfad kein belegtes Schadensszenario.

| ID | Warum derzeit nachrangig oder bedingt | Aktivierungsbedingung |
|---|---|---|
| **A-07** | Der Voice-Config-Kanal bildet noch eine zweite Config-Autorität, besitzt aber keinen aktuellen Renderer-Aufrufer. | Nächste Änderung oder Reaktivierung der Voice-Konfiguration. |
| **A-10** | Der Router ist im produktiven Main-Pfad vor den Config-Handlern registriert. | Alternative Bootstrap-, Recovery- oder Testtopologie ohne Router. |
| **A-11** | Es gibt heute nur einen Settings-Dialog und keinen konkurrierenden Trust-Writer. | Parallele Settings-Fenster oder weitere Config-Autoren. |
| **B-06** | Nur der gemeinsame Rollback beider gültiger Kopien bleibt; eine Lösung benötigt extern oder OS-geschützt monotonen Zustand. | Cloud-Sync, Update-Rollback-Schutz oder erweitertes lokales Angreifermodell. |
| **B-07** | Quarantäne und manuelle Wiederherstellung sind vorhanden; reale V1-DB-Bestände sind nicht belegt. | Nachweis produktiver Altinstallationen mit V1-Daten. |
| **B-09** | Backup und Recovery sind vorhanden; Rotation und Re-Encryption wären ein eigenes Betriebsfeature. | Reale Kompromittierungs- oder Rotationsanforderung. |
| **B-11** | Temporäre Refresh-Fehler und Disconnect sind getrennt; nur die Live-Aktualisierung einer bereits offenen Ansicht fehlt. | Beobachteter Bedarf oder Einführung externer Statusänderungen. |
| **C-08** | WAV-Dateien sind restriktiv und temporär; nur ein Hard-Crash kann Klartext bis zum nächsten Providerstart hinterlassen. | Strikte Produktanforderung „kein Klartext-Audio auf Disk“. |
| **C-14** | Der direkte Response-Persistenzzweig wird von heutigen Aufrufern nicht policy-frei erreicht. | Neue Aufrufer mit recordInHistory ohne Turn-Draft. |
| **D-04** | Default-Budgetfehler ist behoben; Abweichung entsteht nur nach Live-Änderung von num_ctx ohne Runtime-Neustart. | Editierbares num_ctx oder dynamische Provider-Neukonfiguration. |
| **D-14** | Der Summarizer ist produktiv tot und nur als Kompatibilitätsnaht verdrahtet. | Reaktivierung oder nächste Search-Aufräumrunde. |
| **E-07** | Minimal bestätigt heute Datenfreigaben; es existiert keine aktuelle critical-Aktion. | Erste destruktive, bezahlte oder rechtlich bindende Aktion. |
| **E-10** | Beide Policy-Auswertungen liefern für alle heutigen Aktionen effektiv dieselbe Entscheidung. | Erste Datei-, Kosten- oder Binding-Aktion. |
| **E-11** | dataDisclosure ist jetzt wirksam; ein Rollenmodell wird im lokalen Ein-Nutzer-Produkt nicht verwendet. | Mehrnutzer-, Mobil- oder Geräteautorisierung. |
| **F-04** | Fremdseitenfenster erhalten unnötige IPC-Kopien, besitzen aber ohne Preload/Node keinen aktuellen JS-Leseweg. | Änderung der Browser-Sandbox, Preload-Anbindung oder IPC-Architektur. |
| **F-09** | Neue Deadlines machen dauerhaft offene Turns im normalen Ablauf unwahrscheinlich; openTurns bleibt Defense-in-depth unbegrenzt. | Neuer Pfad ohne Terminalzustand oder beobachtetes Wachstum. |
| **G-10** | Windows garantiert bei session-end keine Await-Zeit; bloßes Awaiten würde keine belastbare Zusage schaffen. | Bedarf an harter Prozessbesitz-Garantie, etwa über Windows Job Objects. |

---

## Bestätigt, aber derzeit nachrangig

| ID | Einordnung |
|---|---|
| **C-16** | Toter zweiter Recall-Pfad mit abweichender Semantik; vor Reaktivierung entfernen oder vereinheitlichen. |
| **D-12** | tests liegt außerhalb des Typechecks. Die aktuelle Suite läuft vollständig, eine zusätzliche Typgrenze bleibt dennoch sinnvoll. |
| **E-15** | Verbleibende Testlücken sind Qualitäts-Hardening, solange kein konkreter ungetesteter Bypass belegt ist. |
| **F-08** | Preload-Kanäle besitzen keine vollständige Laufzeitvalidierung; der aktuelle Vertrag und die Aufrufer sind jedoch eng kontrolliert. |

---

## Nur bei geänderter Architektur neu prüfen

Diese fünf Punkte sind für die heutige Architektur nicht bestätigt und lösen keine Umsetzung aus.

| ID | Warum heute kein Befund | Neu prüfen, wenn |
|---|---|---|
| **E-12** | Renderer-beschreibbare Config ist im lokalen Ein-Nutzer-Vertrauensmodell die vorgesehene Nutzerkonfiguration, keine separate Autoritätsgrenze. | Renderer oder Settings-Oberfläche als nicht vertrauenswürdig behandelt werden. |
| **E-13** | Die heutige Risikoklassifikation ist eine Produktentscheidung; kein konkreter Bypass folgt allein aus der Benennung. | Neue destruktive, bezahlte oder irreversible Aktionen hinzukommen. |
| **G-13** | Das activate-Verhalten ist unter dem aktuellen Windows-zentrierten Lifecycle kein produktiver Fehler. | macOS oder Mehrfenster-Lifecycle unterstützt wird. |
| **G-15** | Für den heutigen Helper ist kein verwaister produktiver Kindprozess belegt. | Neue dauerhafte Media-Helper oder andere Prozessbesitzregeln eingeführt werden. |
| **G-16** | Ein fehlender separater Destroyed-Guard erzeugt im heutigen Piper-Lifecycle keinen belegten Fehler. | Provider-Reuse, parallele Lifecycle-Aufrufe oder ein anderer Besitzvertrag eingeführt werden. |

---

## Empfohlene nächste Entscheidung

1. Die **17 bedingten Punkte** nur bei Eintritt ihrer Aktivierungsbedingung hochstufen.
2. Neue Timer-Unterbrechungs- und Performance-Arbeit getrennt vom abgeschlossenen Layer-2-Audit behandeln.
3. In der nächsten Prüfschicht die bestehenden Verträge erneut als Regressionen einbeziehen, ohne die praktische Layer-2-Abnahme stillschweigend auf andere Layer auszuweiten.

## Prüfgrenzen

- Die elf weiterhin relevanten Hardening-Punkte wurden in Runde 3 umgesetzt; fünf weitere wurden auf klare Aktivierungsbedingungen zurückgestuft und einer geschlossen.
- Für die Neubewertung wurden Codepfade und Aufrufer geprüft; sie war keine zusätzliche vollständige Produkt- oder Penetrationsprüfung.
- Die praktische Windows-Abnahme bestand alle zehn Blöcke einschließlich Sprache, natürlicher Bestätigung und Abbruch, Browserberechtigungen und Ergebnisbezug, OAuth-/Storage-Anzeigen, Crash-Recovery und Shutdown.
- Änderungen an Layer 3 bis 6 bleiben außerhalb dieses Dokuments.
