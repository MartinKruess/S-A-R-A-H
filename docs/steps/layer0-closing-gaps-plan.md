# Layer 0: Abschluss der Lifecycle-Luecken

**Status:** Implementiert und automatisiert abgenommen; praktische Windows-Matrix aus dem Hauptplan offen

**Bezug:** Zweiter Abschlussaudit vom 25.08.2026

**Ziel:** Layer 0 auch bei Abbruch, Teilstart, Modellfehler und fatalem Bootstrap wahrheitsgemäß und vollständig bereinigend machen, ohne die Turn-Orchestrierung aus Layer 1 vorwegzunehmen.

---

## 1. Abgrenzung

Dieser Abschluss baut keine allgemeine Turn-Queue und keine Nutzerfunktion zum Abbrechen einer Antwort. Er schließt ausschließlich den technischen Lebenszyklus:

- Ein App-Shutdown darf nicht minutenlang auf einen noch startenden Service warten.
- Bereits gestartete oder laufende technische Operationen dürfen nach Shutdown keine Ressourcen erneut aktivieren.
- Ein fehlgeschlagener Modellwechsel muss einen ehrlichen Zustand und einen kontrollierten Rückweg besitzen.
- Teilweise gestartete native Ressourcen müssen sofort beziehungsweise spätestens beim Shutdown bereinigt werden.
- Ein Fehler vor der fertigen AppContext-Erzeugung muss sichtbar und kontrolliert enden.

---

## 2. Paket A - Abbruchfaehiger Start und kontrollierter Drain

### Problem

Die ServiceRegistry wartet beim Shutdown derzeit vollständig auf `initAll()`. Ein noch ladendes Whisper- oder Ollama-System kann das Beenden deshalb mehrere Minuten verzögern. Laufende Search- und Modelloperationen besitzen außerdem keinen durchgängigen technischen Shutdown-Abbruch.

### Umsetzung

1. Der Service-Lifecycle erhält ein `AbortSignal` für die Initialisierung.
2. `destroyAll()` signalisiert zuerst den Abbruch und wartet nur begrenzt auf den Startabschluss.
3. Services beziehungsweise Provider behandeln den Startabbruch als erwarteten Shutdown, nicht als nachträgliche Bereitschaft.
4. ModelRuntime besitzt einen eigenen Runtime-Abbruchcontroller und verbindet ihn mit Request-Timeouts.
5. Search bricht bei gesetztem Signal sofort ab, startet keine weitere Suchmaschine und wartet beim Destroy begrenzt auf die aktive Suche.
6. Ein Shutdown darf keine späten Chunks, Ergebnisse, Capability-Updates oder erneut geladenen Modelle erzeugen.

### Abnahme

- Shutdown während eines blockierten Service-Starts beendet sich innerhalb der festgelegten Grenze.
- Ein abgebrochener Search-Fallback öffnet keine zweite Engine.
- Ein laufender Modellrequest wird beim Shutdown abgebrochen und kann das Modell danach nicht erneut warmhalten.
- Normale Timeouts und der spätere Layer-1-Abbruch bleiben weiterhin möglich.

---

## 3. Paket B - Modellfehler und Rollback

### Problem

Die Router-Rückkehr wird nach Worker-Arbeit nur im Erfolgsfall geplant. Ein fehlgeschlagenes Entladen des vorherigen Modells verhindert den folgenden Load derzeit nicht.

### Umsetzung

1. Router-Restore nach Worker-Nutzung im Fehler- und Erfolgsfall planen, solange die Runtime nicht beendet wird.
2. Fehlgeschlagenes Entladen als fehlgeschlagene Transition behandeln.
3. Residency und `activeRole` nach jedem Fehler konsistent halten.
4. Einen Worker-Fehler kontrolliert zum Router zurückführen; schlägt auch das fehl, bleibt der Router ehrlich auf `error`.
5. Tests für Worker-Fehler, Unload-Fehler und Shutdown während Restore ergänzen.

### Abnahme

- Nach einem Worker-Fehler wird der Router wieder warm oder ehrlich als nicht verfügbar gemeldet.
- Nie werden zwei Rollen als kontrolliert aktiv behandelt, wenn das vorherige Modell nicht entladen werden konnte.
- Ein fehlgeschlagener Restore schreibt nach Shutdown keinen Zustand mehr zurück.

---

## 4. Paket C - Voice- und Bootstrap-Cleanup

### Problem

Ein teilweise gestarteter Faster-Whisper-Prozess kann nach einem Init-Fehler bis zum späteren Gesamtschutdown bestehen bleiben. Der native globale Hotkey-Hook wird abgemeldet, aber nicht gestoppt. Fehler bei der Bootstrap-Erzeugung besitzen noch keinen kontrollierten Main-Prozess-Abschluss.

### Umsetzung

1. Faster Whisper macht Startpolling abbrechbar und bereinigt einen Teilstart direkt bei Fehler oder Abort.
2. VoiceService bereinigt einen Provider nach dessen fehlgeschlagener Initialisierung best-effort, ohne die andere Voice-Fähigkeit zu verlieren.
3. HotkeyManager trennt Moduswechsel (`unregister`) und endgültiges Freigeben (`destroy`) und stoppt den nativen Hook beim Destroy.
4. Der Main-Bootstrap erhält eine zentrale Fehlergrenze mit verständlicher Meldung und anschließendem kontrolliertem Quit.
5. Bootstrap schließt bereits erzeugte Storage-Ressourcen auch dann, wenn ein späterer Konstruktor- oder Lesevorgang scheitert.

### Abnahme

- Fehlgeschlagener beziehungsweise abgebrochener Whisper-Start hinterlässt keinen Python-Prozess.
- Voice-Teilfehler lassen die gesunde Fähigkeit weiterlaufen und räumen nur den defekten Provider auf.
- Nach Voice-Destroy läuft kein globaler uIOhook-Worker weiter.
- Ein Bootstrap-Fehler bleibt weder als endloser Splash noch als unbehandelte Promise-Rejection stehen.

---

## 5. Reihenfolge und Abschluss

1. Paket A implementieren und fokussiert testen.
2. Paket B auf dem neuen Abbruchvertrag implementieren.
3. Paket C abschließen.
4. Full Suite, Typecheck und Build ausführen.
5. Dritten Codeaudit gegen beide Layer-0-Pläne durchführen.
6. Praktische Windows-Matrix abnehmen und erst danach Layer 0 auf grün setzen.

Die praktische Matrix bleibt unverändert im Hauptplan dokumentiert. Tests ohne Ollama, mit fehlendem Modell oder absichtlich defekten Voice-Ressourcen werden nur kontrolliert durchgeführt; laufende lokale Dienste oder Modelle werden nicht ungefragt verändert.

---

## 6. Ergebnis vom 25.08.2026

- Service-Starts erhalten einen gemeinsamen Abbruchkontext. Der Shutdown bricht Starts zuerst ab und wartet auf nicht kooperative Initialisierungen nur begrenzt.
- Search-, Browser-, Container-, Modell- und Voice-Startpfade reichen den Abbruch bis zu ihren blockierenden Operationen weiter.
- Ein abgebrochener oder fehlgeschlagener Modellwechsel räumt einen möglichen Teil-Load auf und stellt den Router sofort wieder her. Scheitert auch das, bleibt der Zustand ehrlich auf `error`.
- Faster Whisper reagiert auf Abort, Spawn-Fehler und einen vorzeitigen Prozess-Exit; fehlgeschlagene Voice-Provider werden sofort best-effort bereinigt.
- Der native Hotkey-Hook besitzt einen finalen Destroy-Pfad. Teilweise erzeugte Storage-Ressourcen und fatale Bootstrap-Fehler werden kontrolliert bereinigt.
- Lifecycle-Cleanups und Service-Destroys besitzen feste Zeitgrenzen; ein hängender Besitzer verhindert nicht länger den restlichen Shutdown.
- Ein nicht kooperativer Service, dessen Start erst nach dem ersten Cleanup endet, wird anschließend ein zweites Mal idempotent bereinigt.
- Laufende Actions werden beim Shutdown abgebrochen beziehungsweise begrenzt drainiert. Search, Browseranzeige, AppX-Verifikation, Spotify/OAuth, Systembefehle und Media-Helper übernehmen dafür denselben Abbruchkontext; späte Action-Ergebnisse werden verworfen.
- Ein abschließender erneuter Codeaudit ergab nach diesen Korrekturen keine weitere offene Layer-0-Codelücke.

### Automatisierte Abnahme

- Main- und Renderer-Typecheck erfolgreich.
- Vollständiger Main-/Renderer-Build erfolgreich.
- 71 Testdateien mit 716 Tests erfolgreich.
- `git diff --check` ohne Whitespace-Fehler; die ausgegebenen Hinweise betreffen nur die bestehende LF-/CRLF-Konfiguration.

### Verbleibende Grenze

Die technische Implementierung von Layer 0 ist damit geschlossen. Die Gesamtbewertung bleibt bis zur praktischen Windows-Matrix aus dem Hauptplan gelb: insbesondere normales Fenster-Schließen beziehungsweise direkter Quit, echte Degraded-Starts sowie der reale Router-/Worker-/Search-Ablauf. Diese Tests verändern lokale Dienste, Modelle oder Voice-Ressourcen und werden deshalb gesondert kontrolliert abgenommen.
