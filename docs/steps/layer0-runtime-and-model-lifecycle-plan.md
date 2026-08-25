# Layer 0: Runtime-, Service- und Modell-Lifecycle

**Status:** Implementiert; automatisiert abgenommen, praktische Degraded-/Quit-Matrix teilweise offen

**Priorität:** P0 – Fundament vor weiteren Features

**Bezug:** Fundamentbereiche 2, 12, 14 und 16 aus `phase1-core-foundation-gaps.md`
**Ziel:** Sarah startet, meldet Bereitschaft, wechselt Modelle und beendet sich über einen einzigen wahrheitsgemäßen und vollständig bereinigenden Lebenszyklus.

---

## 1. Kurzentscheidung

Layer 0 ist **nicht fertig**. Es existiert bereits ein brauchbarer Unterbau, deshalb ist kein kompletter Neubau notwendig. Die Hauptlücke liegt in der Verbindung der vorhandenen Teile:

- Einzelne Provider schützen ihren Start bereits gegen Doppelaufrufe.
- Eine ServiceRegistry, Service-Zustände, ein Bootablauf und geordneter Shutdown existieren bereits.
- Ollama-Containerstart, Router, Worker, Whisper, Piper und Voice besitzen eigene Lifecycle-Logik.
- Die vorhandenen Einzelteile haben jedoch keinen gemeinsamen Besitzer für Start, echte Bereitschaft, Teilfehler und vollständige Bereinigung.
- Der aktuell gemeldete Modellzustand beschreibt teilweise die **beabsichtigte** Auswahl, nicht den technisch bestätigten Zustand.
- Einige Ressourcen liegen außerhalb der ServiceRegistry und können bei bestimmten Beendigungswegen zurückbleiben.

Der Layer wird deshalb als **ein gemeinsamer Architekturplan mit drei getrennt abnehmbaren Arbeitspaketen** umgesetzt. Drei voneinander unabhängige Plandokumente wären ungünstig, weil alle Pakete denselben Zustands-, Bereitschafts- und Shutdown-Vertrag verwenden müssen.

---

## 2. Was bereits tragfähig ist

| Bereich | Stand | Entscheidung |
|---|---|---|
| `SarahService` und `ServiceRegistry` | Grundlegende Registrierung, Init, Destroy und Nachrichten-Subscriptions sind vorhanden. | Beibehalten und gezielt härten. |
| Konfigurationsschema | Zod-validierter Snapshot und verschlüsselte Speicherung existieren. | Beibehalten; produktive Defaults vereinheitlichen. |
| Ollama-Containerverwaltung | Dockerzustände, Start, Healthcheck, Timeout und GPU-Konfiguration sind bereits isoliert und getestet. | Als Infrastrukturadapter weiterverwenden. |
| Router-/Worker-Aufteilung | Zwei Modellrollen und Routingpfad existieren. | Rollen fachlich benennen und technisch stärker trennen. |
| Provider-Initialisierung | Mehrere Provider besitzen bereits Single-Flight-Schutz. | Unter einem Runtime-Besitzer zusammenführen, nicht duplizieren. |
| Voice-Lifecycle | STT und TTS können getrennt degradiert werden; Whisper und Piper besitzen Cleanup. | In gemeinsamen Capability-Snapshot integrieren. |
| Testbasis | Viele Komponenten sind isoliert getestet. | Um Lifecycle-, Race- und Abnahmetests ergänzen. |

---

## 3. Festgestellte Layer-0-Lücken

### 3.1 Service-Start und Teilfehler

- `ServiceRegistry.initAll()` bricht beim ersten Fehler ab.
- Zuvor gestartete Services bleiben aktiv; die Subscription des fehlerhaften Services kann bestehen bleiben.
- Nachfolgende, unabhängige Services werden nicht mehr initialisiert.
- Registry-Init und Gesamt-Shutdown besitzen keinen gemeinsamen Single-Flight-/Idempotenzvertrag.
- Ein einzelner Fehler in `destroy()` kann die Bereinigung der übrigen Services verhindern.

### 3.2 Unwahre beziehungsweise zu grobe Bereitschaft

- Bootereignisse wie `router-ready`, `whisper-ready` oder `piper-ready` können auch nach einem Fehler weitergegeben werden.
- `pending` wird teilweise nicht als Bootproblem behandelt.
- Es gibt keinen zentralen Snapshot, der zwischen `ready`, `degraded`, `unavailable` und `error` pro Fähigkeit unterscheidet.
- UI und Splash können deshalb Bereitschaft anzeigen, obwohl nur ein Teil des benötigten Pfades funktioniert.

### 3.3 Verteilter Ressourcenbesitz

Zusätzlich zur ServiceRegistry werden unter anderem folgende Ressourcen manuell in `main.ts` gehalten:

- Sandbox-Browser
- Metrik- und Voice-Level-Subscriptions
- System-/Action-Timer
- Spotify-OAuth-Loopback-Server während einer Verbindung
- Ollama-Container-/Modellressourcen
- Electron-Fenster und weitere Event-Subscriptions

Diese Ressourcen benötigen einen gemeinsamen Cleanup-Stack. Sie künstlich alle in `SarahService` umzubauen wäre unnötig und würde die Serviceabstraktion verwässern.

### 3.4 Unvollständiger Electron-Shutdown

- Der zentrale Cleanup hängt aktuell hauptsächlich an `window-all-closed`.
- Direkter App-Quit, Teilinitialisierung und bestimmte Betriebssystem-Beendigungen benutzen nicht garantiert diesen Pfad.
- Der Shutdown ist nicht idempotent; parallele oder wiederholte Auslöser können denselben Cleanup mehrfach betreten.
- Ein Fehler in einem frühen Cleanup-Schritt kann Datenbank, Config, Browser oder Provider offenlassen.

### 3.5 Modellrollen und realer Modellzustand

- `activeModel` steht teilweise für die gewünschte Rolle, nicht für ein verifiziert geladenes Modell.
- Ein Modellwechsel entlädt das vorherige Modell, lädt und bestätigt das Zielmodell aber nicht als atomaren Vorgang.
- Die Worker-Verfügbarkeit wird beim Start nicht gleichwertig geprüft.
- Idle-Unload und ein neuer Turn können kollidieren.
- Ein fehlgeschlagener Init bleibt teilweise in einem nicht wiederholbaren Promise-Zustand hängen.
- Router- und Workerrolle heißen intern noch `2b` und `9b`; diese Namen sind fachlich falsch, sobald andere Modellgrößen konfiguriert werden.
- Die Browser-Zusammenfassung kann noch den warmen Router-Provider für freie Textgenerierung verwenden.

### 3.6 Konfigurationswahrheit

- Kontextgrößen und Modelloptionen besitzen mehrere Defaultquellen mit abweichenden Werten.
- Modellprovider werden aus dem Start-Snapshot gebaut.
- Eine spätere Modell-/URL-/GPU-Änderung wird gespeichert, aber nicht zuverlässig in der laufenden Runtime angewendet.
- Die Oberfläche unterscheidet nicht ehrlich zwischen sofort wirksamen und neustartpflichtigen Modelländerungen.

---

## 4. Zielarchitektur

Layer 0 erhält drei klar begrenzte Besitzer. Es wird **kein generisches Dependency-Graph-Framework** gebaut.

### 4.1 `ServiceRegistry`

Verantwortung:

- Sarah-Services registrieren.
- Initialisierung pro Service genau einmal koordinieren.
- Teilfehler erfassen, unabhängige Services weiter initialisieren und fehlgeschlagene Teilinitialisierung bereinigen.
- Shutdown in umgekehrter Reihenfolge vollständig und best-effort ausführen.
- Strukturierte Init- und Shutdown-Berichte liefern.

Nicht verantwortlich für:

- Electron-App-Lifecycle
- Modellresidenz
- beliebige externe Ressourcen wie Browser oder OAuth-Server
- fachliche Entscheidung, ob die App insgesamt benutzbar ist

### 4.2 `AppLifecycleController`

Verantwortung:

- genau einen Bootvorgang und genau einen idempotenten Shutdownvorgang besitzen
- ServiceRegistry, Storage, ModelRuntime und externe Cleanup-Callbacks koordinieren
- Capability-Zustände sammeln und einen wahrheitsgemäßen Runtime-Snapshot veröffentlichen
- neue Arbeit ab Beginn des Shutdowns ablehnen
- alle Beendigungswege von Electron in denselben kontrollierten Shutdown führen
- Cleanup-Fehler sammeln, ohne spätere Bereinigung abzubrechen

Externe Ressourcen registrieren einen kleinen, benannten Cleanup-Callback, zum Beispiel:

```ts
registerCleanup('sandbox-browser', () => sandboxBrowser.close())
```

Der Controller ersetzt damit verstreute manuelle Shutdown-Blöcke, ohne jeden Ressourcenbesitzer in einen künstlichen Service umzubauen.

### 4.3 `ModelRuntime`

Verantwortung:

- Ollama-/Provider-Erzeugung und den gültigen Config-Snapshot besitzen
- Router- und Worker-Verfügbarkeit getrennt prüfen
- Verfügbarkeit, Residenz und Fähigkeit nicht miteinander verwechseln
- Modellwechsel serialisieren
- Zielmodell laden und technisch bestätigen, bevor es als geladen gilt
- Idle-Unload nur ohne aktive Modellnutzung ausführen
- beim Shutdown neue Modellarbeit sperren, laufende Transition begrenzt abwarten und Sarah-eigene Modelle entladen

Nach außen werden rollenbegrenzte Interfaces ausgegeben:

- `RoutingModelClient`: darf ausschließlich klassifizieren und strukturierte Routingdaten liefern.
- `WorkerTextGenerator`: darf freie Antworten, Zusammenfassungen und Erklärungen erzeugen.

Search, Browser und andere freie Textpfade erhalten dadurch technisch keinen Zugriff mehr auf den Router-Client.

---

## 5. Zustandsmodell

### 5.1 Service-/Capability-Zustände

Für App und Fähigkeiten gelten die fachlichen Zustände:

- `registered`
- `starting`
- `ready`
- `degraded`
- `unavailable`
- `error`
- `stopping`
- `stopped`

Ein Runtime-Snapshot enthält mindestens:

- App/Storage
- Router
- lokaler Worker
- STT
- TTS
- Actions
- Search/Browser

`ready` wird nur aus technischen Ergebnissen abgeleitet, niemals aus der Reihenfolge einer Splashanimation.

### 5.2 Modellzustände

Modellzustand wird zweidimensional geführt:

1. **Availability:** Ist das konfigurierte Modell vorhanden und der Provider erreichbar?
2. **Residency:** Ist das Modell aktuell nachweislich geladen?

Residenzzustände:

- `unloaded`
- `loading`
- `loaded`
- `unloading`
- `error`

Der Router wird beim Start warmgehalten. Der Worker wird beim Start auf Verfügbarkeit geprüft, aber erst beim ersten Bedarf geladen. Damit bleiben Startzeit und VRAM-Verbrauch kontrolliert.

### 5.3 Benutzbarkeit im Degraded-Modus

- App-Shell und Einstellungen dürfen auch bei ausgefallenen KI-Fähigkeiten geöffnet werden.
- Texteingabe wird nur angenommen, wenn Router und mindestens ein gültiger Antwortpfad bereit sind.
- Voice-Fähigkeiten werden getrennt ausgewiesen: STT-Ausfall darf Textchat nicht blockieren; TTS-Ausfall darf Textausgabe nicht blockieren.
- Nicht verfügbare Fähigkeiten werden in der UI deaktiviert beziehungsweise klar erklärt, nicht als bereit dargestellt.

---

## 6. Arbeitspaket A – Service-Lifecycle und sicherer Shutdown

### Ziel

Ein belastbarer Besitzer für Initialisierung, Teilfehler, Bereitschaft und vollständige Bereinigung – zunächst unabhängig von der tieferen Modellumschaltung.

### Umsetzung

1. `ServiceRegistry.initAll()` single-flight und wiederholbar sicher machen.
2. Pro Service einen strukturierten Init-Status zurückgeben.
3. Bei Init-Fehler:
   - Subscription des fehlerhaften Services entfernen,
   - best-effort `destroy()` für dessen Teilzustand ausführen,
   - unabhängige Services weiter initialisieren.
4. `destroyAll()` idempotent und reverse-order ausführen.
5. Cleanup trotz einzelner Fehler fortsetzen und Fehler gesammelt zurückgeben.
6. `AppLifecycleController` mit benanntem Cleanup-Stack einführen.
7. Bootstrap-Storage-Cleanup ebenfalls best-effort und idempotent machen.
8. Browser, Metriken, Voice-Level, Timer und aktive OAuth-Verbindung beim Controller registrieren.
9. Electron-Beendigungswege auf denselben Controller führen.
10. Runtime-/Capability-Snapshot als kleine zentrale Datenstruktur einführen.
11. Bootereignisse aus dem Snapshot ableiten; falsche `*-ready`-Signale entfernen.

### Abnahme

- Zweimaliger Start erzeugt keine doppelten Subscriptions oder Prozesse.
- Ein defekter unabhängiger Service verhindert nicht den Start anderer Fähigkeiten.
- Ein `destroy()`-Fehler verhindert keine weitere Bereinigung.
- Zweimaliger Shutdown bleibt sicher und schließt jede Ressource höchstens einmal.
- Direkter Quit und Fenster-Schließen benutzen nachweislich denselben Shutdownpfad.
- UI/Splash meldet ausgefallene Fähigkeiten niemals als bereit.

### Erwartete betroffene Bereiche

- `src/core/service-registry.ts`
- `src/core/bootstrap.ts`
- `src/core/types.ts`
- neuer Lifecycle-Controller unter `src/core/`
- `src/main.ts`
- `src/main/boot-sequence.ts`
- OAuth-, Browser- und Messressourcen nur an ihren Cleanup-Anschlüssen
- zugehörige Unit- und Integrationstests

---

## 7. Arbeitspaket B – Modell-Runtime und Rollengrenzen

### Ziel

Ein technisch wahrer, race-sicherer Modellzustand und eine harte Trennung zwischen Routerklassifikation und freier Worker-Generierung.

### Umsetzung

1. Fachliche Rollen `router` und `local_worker` statt `2b` und `9b` verwenden.
2. `ModelRuntime` als Besitzer für Container, Provider, Availability und Residency einführen.
3. Beim Start beide konfigurierten Modelle auf Vorhandensein/Erreichbarkeit prüfen.
4. Nur den Router vorwärmen; Worker lazy laden.
5. Modelltransitionen über eine gemeinsame serielle Operation koordinieren.
6. Zielmodell nach dem Laden technisch verifizieren, bevor `loaded` gemeldet wird.
7. Fehlgeschlagene Transition setzt einen ehrlichen Fehlerzustand und kann kontrolliert erneut versucht werden.
8. Idle-Unload an eine Nutzungs-/Lease-Regel binden, damit kein aktiver Request entladen wird.
9. RouterService, RoutingService und WorkerService auf rollenbegrenzte Clients umstellen.
10. Search-Zusammenfassungen ausschließlich über `WorkerTextGenerator` erzeugen.
11. Shutdown entlädt Router- und Worker-Modell best-effort und gibt VRAM frei.
12. Der Docker-Container bleibt standardmäßig laufen; Sarah beendet nur die von ihr geladenen Modelle. Ein optionales Container-Beenden ist nicht Teil dieses Layers.

### Abnahme

- Der Worker kann nicht versehentlich über den Router-Client ersetzt werden.
- Browser-/Search-Zusammenfassungen benutzen niemals das Router-Modell.
- `loaded` ist durch den tatsächlichen Providerzustand bestätigt.
- Gleichzeitig eintreffende Role-Requests erzeugen keine überlappenden Swaps.
- Ein neuer Request kann nicht mit Idle-Unload kollidieren.
- Ein fehlendes Worker-Modell ergibt einen verständlichen Degraded-Zustand.
- App-Shutdown hinterlässt keine Sarah-eigenen Modelle im VRAM.

### Erwartete betroffene Bereiche

- `src/services/llm/`
- `src/services/search/search-service.ts`
- Ollama-Provider und Containeradapter
- Modell-/Routertests und neue Runtime-Racetests

---

## 8. Arbeitspaket C – Konfigurationsvertrag, Integration und Core-Abnahme

### Ziel

Die neue Runtime vollständig in Boot, UI und Settings integrieren und mit einer kleinen verbindlichen Abnahmematrix abschließen.

### Umsetzung

1. Eine produktive Quelle für Modell- und Kontextdefaults festlegen.
2. Modellbezogene Einstellungen klassifizieren:
   - promptbezogene Werte: beim nächsten Workerturn live,
   - Base-URL, Modellname, Kontext, GPU-/Performanceoptionen: zunächst sichtbar neustartpflichtig.
3. Beim Speichern neustartpflichtiger Werte den laufenden Provider nicht halb aktualisieren.
4. IPC-Antwort des Speichervorgangs um `restartRequired` ergänzen.
5. UI meldet Erfolg erst nach bestätigtem Speichern und zeigt Neustartbedarf ehrlich an.
6. Bootsequenz vollständig auf Lifecycle- und ModelRuntime-Snapshots umstellen.
7. Alte doppelte Provider-/Router-/Voice-Initialisierung entfernen.
8. Veraltete Boot-Subscriptions und Timer beim Shutdown zuverlässig abmelden.
9. Kleine technische Core-Smoke-Suite und praktische Abnahme dokumentieren.

Eine vollständige atomare Überarbeitung aller Settings-Ansichten und aller IPC-Verträge bleibt außerhalb dieses Arbeitspakets. Layer 0 stellt nur sicher, dass Modellkonfiguration und Runtimezustand nicht lügen.

### Automatisierte Abnahme

- Registry-Init ist single-flight und registriert keine Listener doppelt.
- Init-Teilfehler wird bereinigt; unabhängige Services starten weiter.
- Shutdown läuft trotz Cleanup-Fehler vollständig durch.
- Runtime-Snapshot unterscheidet `ready`, `degraded`, `unavailable` und `error`.
- Fehlgeschlagene Fähigkeiten senden kein Ready-Ereignis.
- Router- und Worker-Verfügbarkeit werden getrennt geprüft.
- Modellwechsel und Idle-Unload sind serialisiert.
- Config-Defaults stammen aus einer Quelle.
- Modelländerungen melden `restartRequired` und verändern die alte Runtime nicht halb.
- Search besitzt keinen Router-Textgenerator.
- Shutdown entlädt beide Sarah-Modelle und lässt den Container gemäß Policy laufen.

### Praktische Abnahme unter Windows

1. Kaltstart bei bereits laufendem Docker/Ollama.
2. Warmstart mit bereits verfügbarem Routermodell.
3. Start ohne erreichbaren Docker-/Ollama-Dienst.
4. Start mit fehlendem Worker-Modell.
5. Start mit ausgefallenem STT, aber funktionierendem Textchat.
6. Start mit ausgefallenem TTS, aber sichtbarer Textantwort.
7. Mehrfaches Starten/Schließen ohne Zombieprozesse oder doppelte Listener.
8. Workeraufruf, Rückkehr zum Router und Idle-Unload.
9. Modellkonfiguration speichern, sichtbaren Neustartbedarf prüfen und neu starten.
10. App direkt beenden und danach VRAM, Python-/TTS-Prozesse, Browser und OAuth-Port prüfen.

---

## 9. Bewusst nicht Teil von Layer 0

Diese Punkte benötigen die Layer-0-Anschlüsse, werden aber erst in späteren Layern umgesetzt:

- Turn-ID, TurnCoordinator, Queue-/Replace-/Cancel-Regeln und vollständiger End-to-End-Abbruch
- Session-, Inkognito-, Persistenz- und Memory-Policy
- Mikrofon-Pre-Roll- und Privacy-Vertrag
- Action-Risikoklassen, Bestätigung und Policy Engine
- vollständige Vereinheitlichung aller IPC- und Eventverträge
- allgemeine atomare Settings-Merges zwischen mehreren geöffneten Ansichten
- Backend-/Cloudmodelle und automatischer Fallback dorthin
- proaktive Auto-Recovery-Endlosschleifen

Die neuen Interfaces akzeptieren dort, wo Modell- oder Providerarbeit stattfindet, bereits einen später nutzbaren Abbruchkontext beziehungsweise `AbortSignal`. Die eigentliche Turn-Orchestrierung wird in Layer 1 gebaut.

---

## 10. Empfohlene Ausführungsreihenfolge

1. **Arbeitspaket A abschließen und abnehmen.** Erst dann gibt es einen verlässlichen Besitzer für die Ressourcen aus Paket B.
2. **Arbeitspaket B abschließen und abnehmen.** Danach sind Modellzustand und Router-/Workergrenzen technisch wahr.
3. **Arbeitspaket C integrieren und praktisch abnehmen.** Erst danach gilt Layer 0 als geschlossen.

Die Pakete sollten in getrennten, aufeinander aufbauenden Branches beziehungsweise Pull Requests umgesetzt werden. So bleibt jeder Umbau prüfbar und rücksetzbar. Die konkrete Branch-Erstellung erfolgt erst nach Abnahme dieses Plans und nach sauberem Abschluss des aktuell offenen Feature-Branches.

---

## 11. Definition of Done für Layer 0

Layer 0 ist erst grün, wenn alle folgenden Aussagen praktisch und automatisiert belegt sind:

- Sarah besitzt genau einen Boot- und Shutdown-Orchestrator.
- Bereitschaft wird pro Fähigkeit technisch bestätigt und ehrlich angezeigt.
- Teilfehler führen zu einem kontrollierten Degraded-Modus.
- Jede gestartete Ressource besitzt einen eindeutigen Cleanup-Besitzer.
- Shutdown ist idempotent, best-effort und lässt sich durch einen einzelnen Fehler nicht abbrechen.
- Router und Worker besitzen getrennte, rollenbegrenzte Clients.
- Verfügbarkeit und tatsächliche Modellresidenz werden getrennt und verifiziert geführt.
- Modellwechsel, Idle-Unload und Shutdown können nicht gegeneinander laufen.
- Modellkonfiguration besitzt eine Defaultquelle und einen ehrlichen Live-/Restart-Vertrag.
- Der verbindliche Windows-Smoke-Test hinterlässt keine Sarah-eigenen Zombieprozesse, offenen Ports, Browserinstanzen oder geladenen Modelle.

---

## 12. Umsetzungsstand vom 25.08.2026

### Implementiert

- ServiceRegistry startet single-flight, bereinigt fehlgeschlagene Teilstarts und initialisiert unabhängige Services weiter.
- Registry- und App-Shutdown sind idempotent, reverse-order und best-effort; Fehler werden pro Besitzer gesammelt.
- Ein `AppLifecycleController` besitzt Runtime-Snapshot, Capability-Zustände und Cleanup-Phasen vor beziehungsweise nach den Services.
- Boot-, Chat- und Bus-Bridges werden vor dem Service-Shutdown abgemeldet; Storage und externe Ressourcen folgen danach.
- Electron `before-quit`, `window-all-closed` und Windows `session-end` benutzen denselben idempotenten Lifecycle.
- OAuth-Loopback-Flows können beim Shutdown abgebrochen und ihre Ports geschlossen werden.
- Voice-Initialisierung ist single-flight; STT und TTS werden getrennt als ready/unavailable gemeldet und unabhängig bereinigt.
- Service-Starts sind über einen gemeinsamen Lifecycle-Abbruch kontrollierbar; der Shutdown wartet auf nicht kooperative Starts nur begrenzt.
- Laufende Search-, Browser-, Container-, Modell- und Voice-Startoperationen reichen den Shutdown-Abbruch bis zu ihren blockierenden Adaptern weiter.
- Lifecycle-Cleanups und Service-Destroys besitzen feste Fristen und lassen spätere Besitzer auch nach einem Timeout weiter bereinigen.
- Ein verspätet abgeschlossener nicht kooperativer Service-Start erhält einen nachträglichen zweiten idempotenten Cleanup-Lauf.
- Die neue `ModelRuntime` besitzt Containerstart, Provider, Availability, Residency, serielle Transitionen, Idle-Restore und Shutdown-Unload.
- Modelloperationen tragen eine Lifecycle-Generation; verspätete Transitionen können nach Shutdown keinen geladenen Zustand zurückschreiben.
- Fehlgeschlagene oder abgebrochene Worker-Transitionen bereinigen einen möglichen Teil-Load und stellen den Router sofort wieder her oder melden dessen Fehler ehrlich.
- Router und freier Worker werden über Rollen `router` und `local_worker` geführt.
- Search-Zusammenfassungen erhalten ausschließlich den Worker-Textgenerator und keinen Router-Provider.
- Modellverfügbarkeit prüft bei expliziten Tags das tatsächlich konfigurierte Modell statt nur die Modellfamilie.
- Modell- und Kontextdefaults besitzen eine gemeinsame Quelle.
- Modellrelevante Settings werden serialisiert gespeichert und melden `restartRequired` mit konkreten Gründen.
- Dashboard-Chat wird aus dem Runtime-Snapshot deaktiviert, solange der Router nicht technisch bereit ist.
- Splash unterscheidet Ready und terminalen Degraded-/Unavailable-Zustand und kann auch ohne STT beziehungsweise TTS fortfahren.
- Faster-Whisper-Teilstarts, ausgefallene Voice-Provider, der native Hotkey-Hook und teilweise erzeugte Bootstrap-Storage-Ressourcen besitzen explizite Cleanup-Pfade.
- Fatale Fehler vor einer vollständig erzeugten AppContext-Instanz enden in einer sichtbaren Fehlermeldung und einem kontrollierten App-Quit.
- ActionService stoppt neue Arbeit beim Shutdown, bricht laufende Adapter soweit möglich ab, wartet begrenzt und sendet danach keine verspäteten Ergebnisse mehr.

### Automatisiert geprüft

- Main- und Renderer-Typecheck erfolgreich.
- Vollständiger Main-/Renderer-Build erfolgreich.
- 71 Testdateien mit 715 Tests erfolgreich.
- Enthalten sind unter anderem Doppelstart, Teilinitialisierung, Cleanup-Fehler, Start-/Shutdown-Race, Modellwechsel-Race, verspätete Transition, fehlender Worker, exakte Modell-Tags, Voice-Teilfehler, OAuth-Abbruch, direkte Electron-Quit-Orchestrierung und Restart-Vertrag.
- Ein abschließender erneuter Codeaudit nach den Cleanup-Fristen, dem Late-Init-Cleanup und dem Action-Drain ergab keine weitere relevante Layer-0-Codelücke.

### Realer Windows-Smoke-Test

- Electron-Anwendung startete über den produktiven Dev-Bootpfad.
- Ollama lud und bestätigte `phi4-mini:3.8b` mit 2048 Kontext und VRAM-Belegung.
- Faster-Whisper startete seinen Python-Prozess, lud `large-v3-turbo` und beantwortete den Healthcheck erfolgreich.
- Nach dem erzwungenen Ende des Dev-Watchers blieben keine Electron-, Python- oder Piper-Prozesse bestehen.
- Der Dev-Watcher beendet Kindprozesse ausdrücklich mit `SIGKILL`; dieser Stopp kann den Electron-Quit-Lifecycle nicht praktisch abnehmen. Das dadurch noch geladene Routermodell wurde anschließend kontrolliert entladen und `/api/ps` war leer.

### Noch praktisch abzunehmen

- normales Schließen des sichtbaren App-Fensters und direkte Quit-Aktion mit anschließender Prozess-/VRAM-Prüfung
- realer Start ohne Docker/Ollama
- realer Start mit fehlendem Worker-Modell
- realer STT- und TTS-Teilausfall
- praktischer Router-zu-Worker-Wechsel, Idle-Rückkehr und Search-Zusammenfassung
- Modellsetting speichern, sichtbaren Neustarthinweis prüfen und nach Neustart die neue Runtime bestätigen

Bis diese praktische Matrix abgeschlossen ist, bleibt Layer 0 als Ganzes **gelb** statt grün. Die implementierte technische Basis und ihre automatisierten Verträge sind abgeschlossen.
