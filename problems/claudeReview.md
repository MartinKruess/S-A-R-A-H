# Claude Review: Was künftig besser laufen sollte

Stand: 2026-04-09

Diese Datei ist keine Fehlerliste für das Produkt selbst, sondern eine Review für die Zusammenarbeit und Ausführung durch Claude.

Wichtig vorweg:

- Der fehlende Live-Mikrofontest am Ende von Phase 2 war laut User-Absprache bewusst auf später verschoben.
- Das ist daher **nicht** als Versäumnis von Claude zu werten.
- Der Hauptpunkt dieser Review ist nicht „Claude kann es nicht“, sondern: Status, Restpunkte und Verifikation müssen präziser behandelt werden.

## Gesamtfazit

Claude hat in Phase 1 bis 4 technisch brauchbare Arbeit geliefert. Die wiederkehrenden Probleme lagen weniger im reinen Implementieren als in vier Mustern:

1. Offene Restpunkte wurden teils zu früh als erledigt behandelt.
2. Verhalten wurde nicht immer so direkt getestet wie behauptet.
3. Mehrschichtige Flows wurden zu stark aus Einzelteilen statt als Gesamtkette bewertet.
4. Konfigurations- und Altwertpfade wurden anfangs nicht konsequent genug mitgeprüft.

## Phase 1: Zentrale Lehre

Der Kernfehler in Phase 1 war nicht der eigentliche Fix, sondern die zu frühe Annahme, der Fehlerpfad sei vollständig geschlossen. Beim `llm:error`-Thema war zunächst sichtbar, dass die Subscription ergänzt wurde, aber nicht sauber belegt, was das Event tatsächlich im Zustand `processing` auslöst.

**Merke für ähnliche Fälle:**

- Bei State-Machines nie nur den Happy Path prüfen.
- Nicht nur testen, dass etwas verdrahtet ist, sondern was es tatsächlich bewirkt.
- Review-Dateien direkt nach der Nachprüfung auf denselben Stand bringen wie der Code.

## Phase 2: Zentrale Lehre

Phase 2 war technisch gut umgesetzt, aber anfangs zu optimistisch bewertet. Der eigentliche Schwachpunkt war die Trennung zwischen `implementiert` und `wirklich verifiziert`, vor allem bei Renderer-/Browser-Code und Lifecycle-Themen.

**Merke für ähnliche Fälle:**

- Neue Renderer-/Browser-Module sofort mit Teststrategie denken.
- Lifecycle-Fragen immer vollständig prüfen: Erstellung, Nutzung, Cleanup, Fehlerfall.
- Manuelle Verify-Schritte explizit als durchgeführt, offen, verschoben oder blockiert kennzeichnen.

## Phase 3: Zentrale Lehre

Phase 3 zeigte vor allem: gute Service-Tests sind nicht automatisch eine vollständige Systemabnahme. Die eigentliche Lücke lag zwischen UI, Preload, IPC und Service.

**Merke für ähnliche Fälle:**

- Wenn ein Feature durch mehrere Schichten läuft, die ganze Kette prüfen statt nur die Service-Seite.
- Offene Verify-Punkte konkret benennen, nicht pauschal.
- Eine Funktion ist erst dann wirklich belastbar bewertet, wenn auch das sichtbare Verhalten am Ende der Kette geprüft wurde.

## Phase 4: Zentrale Lehre

Phase 4 zeigte: eine technisch richtige Kernimplementierung reicht nicht, wenn UI und Runtime unterschiedliche Annahmen über erlaubte Konfigurationswerte haben oder wenn ein defektes Feature nur versteckt statt wirklich neutralisiert wird.

**Merke für ähnliche Fälle:**

- UI-Eingaben und Runtime-Validierung immer als zusammengehöriges System behandeln.
- Nicht funktionsfähige Features nie nur verstecken, sondern defensiv im Runtime-Code entschärfen.
- Neben dem Sollpfad immer auch ungültige Werte, Altwerte und Fallbacks testen.
- Aussagen wie `alles grün` nur mit genau dem genannten Kommando absichern.

## Konkrete Arbeitsregeln für Claude

1. Vor jeder Abschlussaussage prüfen, ob wirklich alle Verify-Schritte erledigt sind.
2. Nicht nur Verdrahtung prüfen, sondern beobachtbares Verhalten.
3. Happy Path und Error Path gleich ernst behandeln.
4. UI, IPC und Runtime immer als zusammenhängende Kette bewerten.
5. Konfigurationswerte immer auf gültige, ungültige, alte und fehlende Zustände prüfen.
6. Nicht funktionsfähige Features nicht nur aus der UI entfernen, sondern im Runtime-Code sicher neutralisieren.
7. Review-Dateien sofort mit dem tatsächlichen Prüfstand synchron halten.
8. Nicht `fertig` sagen, wenn eigentlich nur `implementiert, aber noch nicht vollständig verifiziert` gemeint ist.
9. Temporäre Logs und Diagnosehilfen klar als temporär markieren.
10. Wenn ein Gesamtstatus behauptet wird, genau den dafür genannten Testlauf wirklich ausführen.

## Kurzform für Claude

1. Nicht nur fixen, sondern den ursprünglichen Fehlerpfad wirklich schließen.
2. Nicht nur Einzelteile prüfen, sondern die gesamte Wirkungskette.
3. Nicht nur Sollwerte testen, sondern auch Fehler-, Alt- und Fallbackpfade.
4. Nicht nur Code ändern, sondern Review-Status sauber nachziehen.
5. Nicht `abgeschlossen` sagen, wenn noch Verifikation fehlt.

# Claude Review: Was künftig besser laufen sollte

Stand: 2026-04-09

Diese Datei ist keine Fehlerliste für das Produkt selbst, sondern eine Review für die Zusammenarbeit und Ausführung durch Claude.

Wichtig vorweg:

- Der fehlende Live-Mikrofontest am Ende von Phase 2 war laut User-Absprache bewusst auf später verschoben.
- Das ist daher **nicht** als Versäumnis von Claude zu werten.
- Was Claude sich trotzdem merken sollte: Er muss klar zwischen `implementiert`, `automatisch getestet`, `manuell verifiziert` und `noch offen` unterscheiden.

## Gesamtfazit

Claude hat in Phase 1 bis 4 technisch brauchbare Arbeit geliefert, aber an mehreren Stellen war die Abnahme zunächst unsauber oder zu optimistisch formuliert. Der wiederkehrende Schwachpunkt war nicht primär das Coding, sondern die Genauigkeit bei Statusaussagen, Restpunkten, Randfällen und Verifikation.

## Phase 1: Was Claude besser machen sollte

### 1. Offene Restfehler nicht zu früh als erledigt behandeln

In Phase 1 war der zentrale Restpunkt der fehlende Rückweg `processing -> llm:error -> idle` im VoiceService. Dieser Punkt wurde anfangs nicht sauber mitabgenommen, obwohl der State-Fehler logisch weiter offen war.

**Künftig besser:**

- Nach jedem Fix aktiv gegen den ursprünglichen Fehlerpfad prüfen.
- Nicht nur auf den „Happy Path“ schauen.
- Bei State-Machines immer auch Fehlerpfade, Timeout-Pfade und Abbruchpfade kontrollieren.

### 2. Nicht nur Subscription-Änderungen testen, sondern Verhalten

Nachdem `llm:error` ergänzt wurde, war im Test zunächst nur sichtbar, dass die Subscription-Liste erweitert wurde. Das reicht für eine echte Abnahme nicht.

**Künftig besser:**

- Nicht nur testen, dass ein Event abonniert wird.
- Testen, was das Event tatsächlich auslöst.
- Bei einem Fix wie `llm:error` muss der Test konkret zeigen:
  1. Zustand vorher `processing`
  2. `llm:error` kommt an
  3. Zustand geht auf `idle`
  4. `voice:error` wird emittiert

### 3. Review-Dateien aktuell halten

Während Phase 1 waren Audit-Dateien zeitweise veraltet und behaupteten noch offene Punkte, die im Code bereits gelöst waren, oder umgekehrt.

**Künftig besser:**

- Nach Abschluss einer Phase die Review-/Problemdateien aktiv mit dem echten Codezustand synchronisieren.
- Keine alte Problembeschreibung stehen lassen, wenn sie inzwischen behoben ist.
- Keine Phase als „fertig“ markieren, wenn die eigene Audit-Datei noch das Gegenteil sagt.

### 4. Status präziser formulieren

In Phase 1 wäre die präzise Formulierung früher gewesen: „größtenteils umgesetzt, aber noch nicht vollständig abgenommen“. Stattdessen war die Kommunikation stellenweise zu pauschal.

**Künftig besser:**

- Immer zwischen diesen Kategorien unterscheiden:
  1. implementiert
  2. kompiliert
  3. automatisch getestet
  4. fachlich geprüft
  5. vollständig abgenommen

## Phase 2: Was Claude besser machen sollte

### 1. Implementierung und Verifikation sauber trennen

Phase 2 war technisch gut vorangebracht, aber die erste Abschlussaussage war stärker als die belegte Verifikation. Genau hier lag das Hauptproblem.

**Künftig besser:**

- Nicht aus funktionierendem Build automatisch auf vollständige Abnahme schließen.
- Nicht aus sauberem Code automatisch auf echten E2E-Nachweis schließen.
- Wenn ein manueller Live-Test noch nicht ausgeführt wurde, das klar sagen.

### 2. Bei Renderer-/Browser-Code früh an Testbarkeit denken

Die AudioBridge-Tests kamen erst nach explizitem Nachschärfen. Für neue Renderer-Infrastruktur hätte die Teststrategie von Anfang an mitgedacht werden sollen.

**Künftig besser:**

- Bei neuen Browser-/Renderer-Modulen sofort fragen:
  1. Wie teste ich Start?
  2. Wie teste ich Stop?
  3. Wie teste ich Cleanup?
  4. Wie teste ich Error-Fallbacks?
- Für Audio-/IPC-Code mindestens Mocks und Lifecycle-Tests direkt mitliefern.

### 3. Cleanup vollständiger denken

Der `beforeunload`-Cleanup war zuerst da, aber das explizite Schließen der `AudioContext`-Instanzen fehlte zunächst.

**Künftig besser:**

- Bei Ressourcen mit Lebenszyklus immer vollständig prüfen:
  1. wer erstellt die Ressource
  2. wer stoppt sie
  3. wer zerstört sie
  4. ob wirklich alle Handles geschlossen werden

Das gilt besonders für:

- `AudioContext`
- `MediaStream`
- Event-Listener
- IPC-Subscriptions
- Timer

### 4. Manuelle Verifikation explizit dokumentieren

Für Phase 2 war ein echter Live-Mikrofontest vorgesehen. Dieser wurde bewusst auf später verschoben, aber genau dieser Status hätte immer klar als „noch nicht durchgeführt“ markiert sein sollen.

**Künftig besser:**

- Bei manuellen Prüfschritten immer explizit dokumentieren:
  1. durchgeführt
  2. nicht durchgeführt
  3. bewusst verschoben
  4. blockiert durch Umgebung

- Keine Formulierungen wie „Phase abgeschlossen“, wenn ein geplanter manueller Verify-Schritt noch offen ist.

### 5. Diagnostik klar als temporär markieren

Das Chunk-Logging in `main.ts` war sinnvoll für Diagnose und Live-Test, aber solche Hilfen müssen immer als temporär gekennzeichnet und später wieder entfernt werden.

**Künftig besser:**

- Debug-Logs als Diagnosemaßnahme klar markieren.
- Direkt dazuschreiben, in welcher Phase sie wieder entfernt werden.
- Keine temporäre Diagnose als dauerhafte Lösung verkaufen.

## Phase 3: Was Claude besser machen sollte

### 1. UI-Integration nicht mit Systemintegration verwechseln

In Phase 3 war die Service-Seite recht schnell in gutem Zustand, aber die eigentlichen Renderer-/IPC-Nachweise fehlten noch. Genau dort lag am Ende der Unterschied zwischen `sauber implementiert` und `vollständig abgenommen`.

**Künftig besser:**

- Wenn eine Funktion durch UI, Preload, IPC und Service läuft, nicht nur die Service-Tests zählen.
- Für solche Änderungen immer separat prüfen:
  1. UI-Eingabe
  2. IPC-Übergabe
  3. Main-/Service-Reaktion
  4. sichtbares Ergebnis im Renderer

### 2. Abschlussaussagen enger an den tatsächlichen Nachweis koppeln

Phase 3 war zwischenzeitlich technisch fast fertig, aber nicht in allen Schichten separat belegt. Die richtige Aussage war daher nicht `abgeschlossen`, sondern `weitgehend umgesetzt, aber noch nicht vollständig end-to-end verifiziert`.

**Künftig besser:**

- Bei mehrschichtigen Features keine Gesamtfreigabe nur aus Service-Tests ableiten.
- Offene Verify-Punkte immer konkret benennen statt pauschal `noch etwas testen` zu schreiben.

### 3. Event- und Zustandsflüsse als Kette prüfen

Gerade bei `interactionMode`, `voice:transcript` und Live-Config war das zentrale Thema nicht eine einzelne Funktion, sondern eine Ereigniskette über mehrere Schichten.

**Künftig besser:**

- Bei Event-getriebenen Features bewusst die ganze Kette auflisten und einzeln abhaken.
- Nicht nur fragen `ist der Handler da?`, sondern `kommt das Ereignis wirklich am Ende sichtbar an?`.

## Phase 4: Was Claude besser machen sollte

### 1. UI-Einschränkungen und Runtime-Fähigkeiten immer synchron halten

Der erste Phase-4-Stand hatte eine saubere Hold-to-Talk-Implementierung, aber das Settings-UI ließ zunächst weiterhin Tasten zu, die der Runtime-Code gar nicht verarbeiten konnte. Dadurch war die Funktion implementiert und gleichzeitig leicht kaputtkonfigurierbar.

**Künftig besser:**

- Wenn die Runtime nur einen eingeschränkten Wertebereich akzeptiert, muss die UI exakt denselben Bereich erzwingen.
- Für Konfigurationswerte immer fragen:
  1. Welche Werte sind erlaubt?
  2. Wo werden diese Werte eingegeben?
  3. Wo werden ungültige Werte abgefangen?
  4. Was passiert mit Alt-Konfigurationen?

### 2. Features nicht nur verstecken, sondern defensiv deaktivieren

Beim Keyword-Mode reichte es nicht, die Option aus dem Settings-Select zu entfernen. Solange der Runtime-Code den Modus noch normal ausführte, blieb der bekannte Defekt für Alt-Konfigurationen weiter erreichbar.

**Künftig besser:**

- Ein nicht funktionsfähiges Feature nie nur in der UI verstecken.
- Immer zusätzlich im Runtime-Code absichern:
  1. Wert ignorieren oder auf sicheren Fallback setzen
  2. Alt-Konfigurationen defensiv behandeln
  3. vorhandene Tests auf das neue Verhalten umstellen

### 3. Negative Konfigurationspfade gezielt testen

Phase 4 war am Ende nicht wegen des Happy Paths offen, sondern wegen zweier Konfigurationsrandfälle: ungültige Hotkeys und alte `keyword`-Werte.

**Künftig besser:**

- Nicht nur den Sollwert testen, sondern auch ungültige und veraltete Konfigurationen.
- Bei Settings-Features mindestens diese Fälle prüfen:
  1. gültiger Wert
  2. ungültiger Wert
  3. alter gespeicherter Wert
  4. fehlender Wert

### 4. Finale Freigabe mit exakt dem genannten Kommando verifizieren

In Phase 4 war die Aussage `104 Tests grün` erst belastbar, nachdem genau der benannte Workflow wirklich gelaufen ist.

**Künftig besser:**

- Wenn du einen Status wie `alles grün` behauptest, immer das exakte Kommando nennen und wirklich damit prüfen.
- Keine globale Erfolgsaussage aus Teilmengen-Tests ableiten, wenn du dich auf die Gesamtsuite beziehst.

## Konkrete Arbeitsregeln für Claude ab Phase 3

Claude sollte sich für die nächsten Phasen an folgende Regeln halten:

1. Vor einer Abschlussaussage immer prüfen, ob alle im Plan genannten Verify-Schritte wirklich erledigt wurden.
2. Bei jedem Fix mindestens einen Test oder einen klaren, reproduzierbaren Nachweis liefern.
3. Fehlerpfade genauso ernst prüfen wie Erfolgsfälle.
4. Review-Dateien nach jeder Phase aktualisieren, damit Codezustand und Dokumentation übereinstimmen.
5. In Statusmeldungen nie „fertig“ sagen, wenn es eigentlich nur „implementiert, aber noch nicht vollständig verifiziert“ ist.
6. Bei Browser-/Renderer-Code immer Lifecycle und Cleanup separat prüfen.
7. Temporäre Logs, Flags oder Diagnosehilfen sichtbar als temporär kennzeichnen.
8. UI-Eingaben und Runtime-Validierung immer als zusammengehöriges System prüfen.
9. Nicht funktionsfähige Features nicht nur verstecken, sondern im Runtime-Code sicher neutralisieren.
10. Bei Konfigurationen immer auch Altwerte, ungültige Werte und Fallbacks testen.

## Kurzform für Claude

Wenn Claude nur eine kompakte Merkliste lesen soll, dann diese:

1. Nicht nur fixen, sondern auch den ursprünglichen Fehlerpfad wirklich schließen.
2. Nicht nur kompilieren lassen, sondern Verhalten prüfen.
3. Nicht nur Happy Path testen, sondern auch Error Path.
4. Nicht nur Code ändern, sondern Audit-Dateien synchron halten.
5. Nicht „abgeschlossen“ sagen, wenn manuell oder fachlich noch ein Verify-Schritt offen ist.
6. UI, IPC und Runtime immer als eine Kette prüfen, nicht als getrennte Inseln.
7. Versteckte Features zusätzlich defensiv abschalten.
