# Talkabouts — offene Bugs & Feature-Ideen

> Stand 18.07.2026.

## ✅ Umgesetzt (auf `dev`)

- **Bug 1** — Spotify-Start-Fehlmeldung („nicht installiert" obwohl gestartet): `launchAppx` ignoriert den Explorer-Exit-Code, verifiziert per `tasklist` + `ProgramEntry.processName` → **PR #23**.
- **STT-Qualität** — Windows-Mic-Pegel (Nutzerseite) + Input-Normalisierung + `vad_filter` + Modell `small`→`large-v3-turbo` (int8) + Mic-Warm-Halten gegen abgeschnittene Satzanfänge → **PR #24**.
- **Füllsätze V1** — gesprochene Brücke über die Modell-Swap-Pause: 2B→9B `frontendThinking`, 9B→2B `switchingBack`, via Main-only Event `llm:filler` (`src/services/llm/filler-phrases.ts`) → **PR #25**. Die übrigen §11-Kategorien (Hintergrund/Deep-Search/Programm-Ladestatus/Coding/Memory/Fehler) warten aufs Backend-/Task-System (Architektur §1–21).
- **Gate-Fix** — Infinitive/höfliche Befehle („kannst du Spotify **starten**") werden erkannt: Wortanfang-Stämme `ACTION_HINT_STEMS` → **PR #26**.
- **Integrationen V1 (Spotify-Lautstärke)** — generischer OAuth-Layer (selbstgebauter PKCE), Settings-Tab „Integrationen", `spotify_volume`/`spotify_volume_adjust` → **PR #27**. Live E2E bestätigt.

---

## Bug (offen, geparkt): `set_volume` — „auf 50 % bleibt bei 100 %"

### Beobachtung

Beim Befehl „Lautstärke auf 50 %" ändert sich etwas im System-Sound-Panel, aber der Master-Regler bleibt bei 100 %.

### Stand

Noch **nicht diagnostiziert** — Repro + Logs stehen aus. `SystemActions.setVolume(percent)` setzt den **Master** via `SetMasterVolumeLevelScalar` (CoreAudio-PowerShell). Der COM-Pfad funktionierte im Spike isoliert.

Mögliche Ursachen:

- **LLM liefert falschen Param** (Delta statt Absolutwert, z. B. `150` → Zod `min(0).max(100)` lehnt ab → keine Änderung). → `[Router] raw=…` und `[Actions] set_volume:…` in der Konsole prüfen.
- **PowerShell-Fehler ohne Speak** (Exit 0 trotz Exception). → nach `[SystemActions] setVolume failed` suchen.

### Priorität

Niedrig — „Musik/Spotify auf x %" läuft künftig ohnehin über die **Spotify-Web-API** (per-App, siehe unten), nicht über den Master. Der Master-Bug bleibt nur für explizites „**Systemlautstärke** auf x %" relevant.

---

## Feature: Spotify-Steuerung — Roadmap

> **V1 (Lautstärke) ✅ gemergt (PR #27).** Absolut + relativ läuft live.

Weitere Spotify-Fähigkeiten (alle via Web-API; **Premium + aktives Gerät** nötig). Nach Aufwand:

- **Mediensteuerung V2 (Schicht 1, generisch) ✅ auf `feat/media-control`:** play/pause/toggle/next/previous über Windows GSMTC (C#-Helper `media-helper.exe`), playerübergreifend (Spotify/Browser/VLC), ohne OAuth/Premium. Generische `media_*`-Actions + `MediaController`-Vertrag. Details: `docs/superpowers/specs/2026-07-19-media-control-design.md`.
- **Schicht 2 (Spotify-spezifisch, künftig):** Shuffle/Repeat, nach Namen spielen, Playlists — via Spotify-Web-API (Premium + aktives Gerät). Bleiben `spotify_*`-Actions hinter dem OAuth-Adapter.
- **V3 — Nach Namen spielen (Gruppe B):** Lied suchen+spielen (`GET /search` → play `uris`), Playlist abspielen (`GET /me/playlists` → play `context_uri`). Braucht Fuzzy-Namensauflösung + `playlist-read-private`.
- **V4 — Playlist bearbeiten (Gruppe C):** Lied add/remove (`POST`/`DELETE /playlists/{id}/tracks`). Braucht `playlist-modify-public/-private` → Nutzer muss **neu verbinden** (Scope-Consent).

Ehrlicher Haken: Die API ist der leichte Teil — der Aufwand steckt ab V3 im **Voice-Routing** (gesprochene Namen auf Playlist-/Song-IDs auflösen).

**Offene Follow-ups (aus V1):** Callback-Pfad pro Provider `/callback/<id>`? · „etwas lauter/leiser" landet bei ±25 statt ±5 (Routing-Prompt schärfen).

### Wunsch (V1, erledigt)

Sarah soll gezielt **Spotify/Musik** regeln (nicht den Windows-Master), inkl. relativer Deltas.

### Entscheidung (Brainstorming 18.07., Details im OAuth-Plan)

- **Spotify via Web-API** `PUT https://api.spotify.com/v1/me/player/volume?volume_percent=<0-100>` — **nicht** Windows-Mixer. Premium bestätigt, generischer OAuth-Layer (openid-client, PKCE). Eigener Branch **nach** den Füllsätzen.
- Neue Actions: `spotify_volume:<0-100>` (absolut) + `spotify_volume_adjust:<signed>` (Delta im Code aufgelöst: Ist-Wert lesen → clampen → PUT).

### Command-Grammatik (Spec für die Umsetzung)

```
Spotify / Musik auf x Prozent        → absolut
Spotify (etwas) leiser / lauter      → -25 / +25   (etwas = ±5)
Spotify x Prozent leiser             → -x
Systemsound (dieselben Befehle)      → Master (set_volume)
```

Auslöse-Schlagworte: `spotify`, `musik`, evtl. `hintergrundmusik`.

### Später, separat: Browser / Games gezielt

Geht **nur** über den Windows-Mixer (Web-API kann nur Spotify). Ansatz `ISimpleAudioVolume` via `IAudioSessionManager2`: Sessions enumerieren → per `GetProcessId()` gegen `tasklist` die App matchen → `SetMasterVolume(scalar)`. Aufwändiger (umfangreiches Inline-C# oder C#-Helfer-Binary) → eigene spätere Runde.

---

## Kleinere offene Punkte

- **Routing-Prompt:** klarstellen, dass `set_volume` einen **absoluten** Zielwert (0–100) erwartet, keine Deltas.

## # Sarah – Architektur für Router, Hintergrundaufgaben und dynamische Statusmeldungen

## 1. Ziel des Systems

Sarah soll sich nicht wie ein einzelner blockierender Chatbot verhalten, sondern wie ein dauerhaft ansprechbarer Assistent.

Lange Aufgaben wie Deep Search, umfangreiche Codeanalysen oder Dokumentauswertungen sollen im Hintergrund laufen. Währenddessen muss Sarah weiterhin:

- normale Gespräche führen können,
- Programme starten können,
- Timer stellen können,
- lokale Systemaktionen ausführen können,
- auf Erinnerungen und frühere Gespräche zugreifen können,
- weitere kleinere Aufgaben bearbeiten können.

Das System soll nach außen wie eine einzige Assistenz wirken, intern aber aus mehreren spezialisierten Modellen, Routern und Hintergrundprozessen bestehen.

---

# 2. Grundarchitektur

Die Architektur besteht aus drei wesentlichen Ebenen:

```text
User
  ↓
Frontend-Router
  ├── lokale Aktion
  ├── Frontend-Gesprächsmodell
  └── Backend-Auftrag
          ↓
     Backend-Router
          ↓
     persistente Aufgabenwarteschlange
          ↓
     großes spezialisiertes Modell
```

## 2.1 Frontend-Router

Der Frontend-Router kann ein kleines Modell mit ungefähr 2B Parametern sein.

Seine Aufgabe ist nicht, komplexe Fragen selbst zu beantworten. Er übernimmt hauptsächlich:

- Intent-Erkennung,
- Routing,
- lokale Systemaktionen,
- kurze Begrüßungen,
- einfache Rückfragen,
- Timer,
- Programmstarts,
- Lautstärkeänderungen,
- Weiterleitung an das Frontend-Modell,
- Weiterleitung an das Backend.

Der Frontend-Router kennt nur drei Hauptziele:

```text
LOCAL
FRONTEND
BACKEND
```

Er muss nicht wissen, welches genaue Modell im Backend verwendet wird.

Beispiel:

```json
{
  "destination": "backend",
  "intent": "deep_search",
  "request": "Vergleiche geeignete Datenbanken für das Portal",
  "priority": "normal"
}
```

---

## 2.2 Frontend-Gesprächsmodell

Das Frontend-Modell kann beispielsweise ein 9B-Modell sein.

Es übernimmt:

- normale Gespräche,
- komplexere direkte Antworten,
- Formulierung von Statusmeldungen,
- Kommunikation mit dem Nutzer,
- Zugriff auf Erinnerungen,
- Zusammenfassungen abgeschlossener Backend-Aufgaben,
- Ankündigung neuer Ergebnisse,
- Rückfragen zur Präsentation von Ergebnissen.

Dieses Modell bleibt verfügbar, während im Backend eine große Aufgabe läuft.

Beispiel:

Der Nutzer startet eine Deep Search und fragt danach:

> „Öffne bitte VS Code.“

Der lokale Router startet VS Code.

Danach fragt der Nutzer:

> „Wo waren wir gestern stehen geblieben?“

Das Frontend-Modell greift auf das Gedächtnis zu und beantwortet die Frage.

Währenddessen läuft die Deep Search unabhängig weiter.

---

## 2.3 Backend-Router

Im Backend sitzt ein eigener kleiner Router oder Orchestrator.

Seine Aufgaben:

- Backend-Aufträge entgegennehmen,
- Aufgabe klassifizieren,
- passendes großes Modell auswählen,
- verfügbare Ressourcen prüfen,
- Aufgaben in eine Warteschlange eintragen,
- Modelle laden und entladen,
- Aufgaben ausführen,
- Ergebnisse speichern,
- Frontend über Fertigstellung informieren.

Der Frontend-Router kennt die Backend-Modelle nicht direkt.

Der Backend-Router entscheidet beispielsweise:

```text
Deep Search         → Research-Modell
Codeanalyse         → Coding-Modell
Dokumentanalyse     → Analysemodell
komplexe Planung    → General-Modell
```

---

# 3. Parallele Verarbeitung

Frontend und Backend müssen vollständig voneinander entkoppelt sein.

Das bedeutet:

```text
Backend bearbeitet Deep Search
        +
Frontend führt weiterhin Gespräche
        +
lokale Aktionen bleiben verfügbar
```

Ein laufender Backend-Job darf den Frontend-Chat nicht blockieren.

Beispielablauf:

```text
1. Nutzer startet eine Deep Search.
2. Backend nimmt die Aufgabe an.
3. Sarah bestätigt den Hintergrundauftrag.
4. Nutzer spricht normal weiter.
5. Nutzer startet Programme oder stellt Timer.
6. Backend beendet die Deep Search.
7. Backend sendet ein Completion-Event.
8. Frontend-Modell kündigt das Ergebnis an.
9. Nutzer entscheidet, wie das Ergebnis präsentiert wird.
```

---

# 4. Persistente Aufgabenwarteschlange

Backend-Aufgaben dürfen nicht nur im Arbeitsspeicher gespeichert werden.

Eine persistente Queue ist wichtig, damit Aufgaben nicht verloren gehen, wenn:

- der Server neu startet,
- ein Modell abstürzt,
- ein Prozess beendet wird,
- eine Verbindung abbricht,
- mehrere Aufgaben eingehen.

Geeignete Speicher:

- SQLite für eine einfache lokale Lösung,
- PostgreSQL für eine größere verteilte Lösung,
- Redis mit Persistenz für eine schnelle Queue,
- Kombination aus Redis und Datenbank.

Eine Aufgabe könnte so aussehen:

```ts
type BackendTask = {
  id: string;
  type:
    | 'deep_search'
    | 'coding_analysis'
    | 'document_analysis'
    | 'general_reasoning';

  title: string;
  request: string;

  priority: 'low' | 'normal' | 'high';

  status:
    | 'queued'
    | 'waiting_for_resources'
    | 'loading_model'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';

  requiredModel?: string;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  result?: {
    announcement?: string;
    spokenSummary?: string;
    fullResultPath?: string;
  };

  error?: string;
};
```

---

# 5. Smarter Worker-Loop

Der Backend-Router benötigt einen Worker-Loop, der regelmäßig prüft, welche Aufgabe als Nächstes ausgeführt werden kann.

Ein vereinfachtes Beispiel:

```ts
async function backendWorkerLoop() {
  while (true) {
    const task = await getNextRunnableTask();

    if (!task) {
      await waitForNewTask();
      continue;
    }

    try {
      await updateTaskStatus(task.id, 'waiting_for_resources');

      const resourcesAvailable = await checkResources(task);

      if (!resourcesAvailable) {
        await sleep(2000);
        continue;
      }

      await updateTaskStatus(task.id, 'loading_model');

      const model = await loadRequiredModel(task);

      await updateTaskStatus(task.id, 'running');

      const result = await executeTask(model, task);

      await saveTaskResult(task.id, result);
      await updateTaskStatus(task.id, 'completed');

      await notifyFrontend({
        event: 'background_task_completed',
        taskId: task.id,
        title: task.title,
      });
    } catch (error) {
      await updateTaskStatus(task.id, 'failed');

      await saveTaskError(
        task.id,
        error instanceof Error ? error.message : String(error),
      );

      await notifyFrontend({
        event: 'background_task_failed',
        taskId: task.id,
        title: task.title,
      });
    }
  }
}
```

`getNextRunnableTask()` sollte nicht blind die älteste Aufgabe nehmen.

Es muss unter anderem prüfen:

- welches Modell gerade geladen ist,
- wie viel RAM verfügbar ist,
- wie viel VRAM verfügbar ist,
- ob ein anderes großes Modell läuft,
- welche Aufgabe Priorität hat,
- ob eine Aufgabe mit dem aktuell geladenen Modell ausgeführt werden kann.

---

# 6. Backend-Ressourcenregeln

In der ersten Version sollte das System möglichst einfach bleiben.

Empfohlene Regeln:

1. Es läuft maximal ein großes Backend-Modell gleichzeitig.
2. Eine laufende Aufgabe wird nicht automatisch abgebrochen.
3. Neue Aufgaben werden in eine Warteschlange gestellt.
4. Der Nutzer kann die Priorität ändern.
5. Der Nutzer kann eine Aufgabe abbrechen.
6. Eine neue große Aufgabe kann die laufende nur nach ausdrücklicher Bestätigung ersetzen.
7. Pausieren und späteres Fortsetzen wird zunächst nicht unterstützt.
8. Ergebnisse werden dauerhaft gespeichert.
9. Lokale Aktionen und das Frontend-Modell bleiben trotzdem verfügbar.
10. Der Nutzer wird nicht mit technischen Details wie VRAM-Fehlern konfrontiert.

Statt:

> „Nicht genug VRAM.“

soll Sarah sagen:

> „Ich bearbeite gerade noch eine größere Aufgabe. Soll ich die neue Aufgabe danach starten oder die laufende Bearbeitung abbrechen?“

---

# 7. Warteschlangenstrategie

Zunächst reicht eine einfache FIFO-Warteschlange:

```text
First In, First Out
```

Später können Prioritäten ergänzt werden:

```text
HIGH
NORMAL
LOW
```

Beispiel:

```ts
function compareTasks(a: BackendTask, b: BackendTask) {
  const priorityValue = {
    high: 3,
    normal: 2,
    low: 1,
  };

  const priorityDifference =
    priorityValue[b.priority] - priorityValue[a.priority];

  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}
```

Optional können später zwei Warteschlangen geführt werden:

```text
interactive_queue
background_queue
```

## Interactive Queue

Für Aufgaben, auf deren Antwort der Nutzer aktiv wartet:

- komplexe direkte Fragen,
- akute Codeprobleme,
- kurze Analyseaufgaben.

## Background Queue

Für:

- Deep Search,
- große Dokumentanalysen,
- vollständige Projektprüfungen,
- Reports,
- Indexierung,
- Zusammenfassungen.

Mit nur einem großen Backend-Modell gibt es dort dennoch keine echte Parallelität. Die Queue regelt nur Reihenfolge und Priorität.

---

# 8. Ergebnisrückgabe

Das Backend soll Ergebnisse nicht als direkte Chatantwort zurückgeben.

Stattdessen sendet es ein Event:

```json
{
  "event": "background_task_completed",
  "taskId": "task_1042",
  "title": "Datenbankvergleich für das Portal",
  "result": {
    "announcement": "Die Recherche ist abgeschlossen.",
    "spokenSummaryPath": "/results/task_1042-summary.md",
    "fullResultPath": "/results/task_1042-full.md"
  }
}
```

Das Frontend-Modell erhält anschließend eine strukturierte Systemnachricht:

```json
{
  "system_event": "background_task_completed",
  "taskId": "task_1042",
  "title": "Datenbankvergleich für das Portal",
  "summaryAvailable": true,
  "fullResultAvailable": true
}
```

Das Frontend-Modell formuliert daraus eine natürliche Meldung:

> „Übrigens, die Recherche zum Datenbankvergleich ist fertig. Soll ich dir die wichtigsten Punkte zusammenfassen oder den vollständigen Bericht öffnen?“

---

# 9. Ergebnisformate

Ein Backend-Ergebnis sollte idealerweise drei Ebenen enthalten.

```json
{
  "announcement": "Die Recherche zum Datenbankvergleich ist abgeschlossen.",

  "spokenSummary": "Kurze Zusammenfassung, die sich gut vorlesen lässt.",

  "fullReport": "Vollständiger Bericht mit Details, Quellen und Ergebnissen."
}
```

Dadurch muss das Frontend-Modell nicht den kompletten Bericht erneut verarbeiten.

Mögliche Ausgabeformen:

- mündlich zusammenfassen,
- vollständigen Text anzeigen,
- Browserfenster öffnen,
- separates Textfenster öffnen,
- Markdown-Datei speichern,
- README erstellen,
- Ergebnis in VS Code öffnen,
- Ergebnis in ein bestehendes Projekt schreiben.

---

# 10. Unterbrechungsregeln für Fertigmeldungen

Sarah darf nicht mitten in einen Satz oder während der Nutzer spricht eine Fertigmeldung ausgeben.

Ein Completion-Event soll erst präsentiert werden, wenn:

- die aktuelle Sprachausgabe beendet ist,
- der Nutzer gerade nicht spricht,
- keine lokale Aktion bestätigt wird,
- kein kritischer Dialog offen ist,
- eine kurze natürliche Gesprächspause vorhanden ist.

Die Nachricht kann bis zu einem passenden Zeitpunkt zwischengespeichert werden.

Beispiel:

```ts
type PendingNotification = {
  taskId: string;
  title: string;
  createdAt: string;
  delivered: boolean;
};
```

Die Präsentation erfolgt dann beispielsweise:

> „Übrigens, die Recherche von vorhin ist inzwischen abgeschlossen.“

---

# 11. Lückenfüller und Statusmeldungen

> **Status:** V1 umgesetzt (PR #25) — nur die Swap-Bridge-Kategorien `frontendThinking` (§11.1) und `switchingBack` (9B→2B-Gate, nicht im Doc, im Code ergänzt) sind verkabelt. Alle übrigen Kategorien unten sind definiert, aber noch NICHT ausgelöst (brauchen das Backend-/Hintergrundaufgaben-System aus §1–10).

Die Texte sollen nicht nach konkreten Themen ausgewählt werden.

Es wäre zu aufwendig und fehleranfällig, für jedes Land, jedes historische Ereignis oder jedes Fachgebiet eigene Texte zu pflegen.

Die Meldungen sollen stattdessen an den technischen Zustand gekoppelt werden.

---

## 11.1 Allgemeiner Wechsel zum Frontend-Modell

- „Das schaue ich mir genauer an.“
- „Einen Moment, ich gehe etwas tiefer darauf ein.“
- „Lass mich das kurz durchdenken.“
- „Das ist eine interessante Frage.“
- „Ich beschäftige mich kurz damit.“
- „Lass mich eine vernünftige Antwort darauf vorbereiten.“
- „Einen Augenblick, ich ordne das kurz.“
- „Ich sehe mir das etwas genauer an.“
- „Da lohnt sich ein genauerer Blick.“
- „Moment, ich denke das einmal sauber durch.“

---

## 11.2 Hintergrundaufgabe angenommen

- „Alles klar, ich kümmere mich im Hintergrund darum.“
- „Die Aufgabe läuft jetzt im Hintergrund.“
- „Ich habe die Bearbeitung gestartet und bleibe währenddessen ansprechbar.“
- „Das ist angestoßen. Wir können währenddessen weitermachen.“
- „Ich lasse das im Hintergrund bearbeiten.“
- „Die Aufgabe läuft. Du kannst mir parallel weitere Dinge sagen.“
- „Ich habe die ausführliche Bearbeitung gestartet.“
- „Darum kümmert sich jetzt mein Hintergrundsystem.“
- „Ich habe den Auftrag vorgemerkt.“
- „Die Bearbeitung wurde gestartet.“

---

## 11.3 Deep Search gestartet

- „Ich gehe dem ausführlicher nach.“
- „Dafür starte ich eine gründlichere Recherche.“
- „Ich untersuche das etwas umfassender.“
- „Ich nehme mir dafür mehrere Quellen vor.“
- „Das schaue ich mir im Detail an.“
- „Ich starte eine vertiefte Suche.“
- „Dafür recherchiere ich etwas ausführlicher.“
- „Ich prüfe das aus mehreren Blickwinkeln.“
- „Ich sammle dazu umfassendere Informationen.“
- „Ich gehe der Frage gründlich nach.“

---

## 11.4 Deep Search läuft noch

Diese Meldungen sollen nur ausgegeben werden, wenn der Nutzer nachfragt oder ein Status ausdrücklich gewünscht ist.

- „Die ausführliche Recherche läuft noch.“
- „Ich arbeite mich gerade durch mehrere Quellen.“
- „Ich vergleiche gerade verschiedene Ergebnisse.“
- „Ich prüfe noch weitere Informationen.“
- „Die Recherche ist noch nicht abgeschlossen.“
- „Ich ordne gerade die gefundenen Informationen.“
- „Ich prüfe noch Widersprüche und Zusammenhänge.“
- „Ich stelle die Ergebnisse gerade strukturiert zusammen.“
- „Einen Moment noch, die Bearbeitung läuft weiter.“
- „Ich bin noch dabei, die Quellen abzugleichen.“

---

## 11.5 Hintergrundaufgabe abgeschlossen

- „Übrigens, die Recherche ist jetzt fertig.“
- „Ich habe inzwischen das Ergebnis deiner Anfrage vorliegen.“
- „Die Hintergrundaufgabe ist abgeschlossen.“
- „Deine angefragte Auswertung ist jetzt bereit.“
- „Die Ergebnisse sind inzwischen eingetroffen.“
- „Ich habe jetzt die vollständigen Daten vorliegen.“
- „Die Recherche wurde abgeschlossen.“
- „Das Ergebnis deiner vorherigen Anfrage ist fertig.“
- „Kurze Zwischenmeldung: Die Auswertung ist fertig.“
- „Nebenbei ist gerade deine Aufgabe abgeschlossen worden.“

---

## 11.6 Ergebnis anbieten

- „Soll ich dir die wichtigsten Punkte zusammenfassen?“
- „Möchtest du das Ergebnis hören oder lieber anzeigen lassen?“
- „Soll ich die Auswertung öffnen oder kurz zusammenfassen?“
- „Möchtest du die vollständige Fassung oder eine kurze Übersicht?“
- „Soll ich direkt mit den Ergebnissen beginnen?“
- „Möchtest du die Daten lesen oder von mir zusammengefasst bekommen?“
- „Soll ich das Ergebnis in einem Fenster öffnen?“
- „Ich kann es vorlesen, zusammenfassen oder abspeichern.“
- „Soll ich daraus eine Datei erstellen?“
- „Möchtest du das Ergebnis direkt in VS Code öffnen?“

---

## 11.7 Backend belegt

- „Ich arbeite im Hintergrund noch an einer größeren Aufgabe.“
- „Mein großes Arbeitsmodul ist momentan noch beschäftigt.“
- „Die umfangreiche Verarbeitung ist derzeit bereits ausgelastet.“
- „Ich kann momentan nur eine große Aufgabe gleichzeitig bearbeiten.“
- „Die vorherige Aufgabe läuft noch.“
- „Für diese Aufgabe brauche ich dieselbe Kapazität, die gerade verwendet wird.“
- „Eine weitere umfangreiche Aufgabe kann erst danach starten.“
- „Der große Arbeitsbereich ist derzeit noch belegt.“
- „Die neue Aufgabe kann ich im Moment nur vormerken.“
- „Ich muss zuerst die laufende Aufgabe abschließen oder abbrechen.“

---

## 11.8 Entscheidung bei Ressourcenkonflikt

- „Soll ich die neue Aufgabe danach einreihen oder die aktuelle abbrechen?“
- „Möchtest du warten oder die laufende Bearbeitung ersetzen?“
- „Ich kann sie vormerken oder die bisherige Aufgabe stoppen.“
- „Soll die neue Aufgabe als Nächstes starten?“
- „Möchtest du die aktuelle Bearbeitung fortsetzen oder wechseln?“
- „Ich kann den neuen Auftrag in die Warteschlange setzen.“
- „Soll ich die laufende Aufgabe beenden und mit der neuen beginnen?“
- „Welche der beiden Aufgaben hat Vorrang?“
- „Soll ich die neue Aufgabe hinten anstellen?“
- „Möchtest du die laufende Aufgabe behalten oder ersetzen?“

---

## 11.9 Lokale Aktion gestartet

- „Alles klar, mache ich.“
- „Wird erledigt.“
- „Einen Moment, ich führe das aus.“
- „Schon dabei.“
- „Kommt sofort.“
- „Ich kümmere mich darum.“
- „Alles klar, der Befehl läuft.“
- „Das setze ich direkt um.“
- „Ich habe die Aktion gestartet.“
- „Wird gemacht.“

---

## 11.10 Programmstart

- „Alles klar, ich starte das Programm.“
- „Ich fahre die Anwendung hoch.“
- „Startbefehl ist raus.“
- „Das Programm wird geöffnet.“
- „Wird gemacht, ich starte es.“
- „Ich bringe die Anwendung an den Start.“
- „Einen Moment, das Programm wird geladen.“
- „Ich öffne es für dich.“
- „Der Start wurde angestoßen.“
- „Die Anwendung wird vorbereitet.“

---

## 11.11 Programm lädt länger

- „Das Programm fährt noch hoch.“
- „Die Anwendung lädt gerade.“
- „Der Start dauert noch einen Moment.“
- „Ich warte noch, bis alles vollständig geladen ist.“
- „Die Anwendung bereitet gerade ihre Komponenten vor.“
- „Der Startvorgang läuft noch.“
- „Das Programm ist noch nicht ganz bereit.“
- „Einen Augenblick noch, es lädt weiterhin.“
- „Die Anwendung braucht noch etwas.“
- „Der Ladevorgang ist noch nicht abgeschlossen.“

---

## 11.12 Programm einsatzbereit

- „Das Programm ist jetzt einsatzbereit.“
- „Die Anwendung läuft.“
- „Alles bereit.“
- „Das Programm wurde geöffnet.“
- „Start abgeschlossen.“
- „Die Anwendung ist vollständig hochgefahren.“
- „Du kannst loslegen.“
- „Fertig, das Programm steht bereit.“
- „Die Anwendung reagiert und ist bereit.“
- „Der Start ist abgeschlossen.“

---

## 11.13 Gedächtnis wird geladen

- „Ich schaue kurz in unsere bisherigen Gespräche.“
- „Einen Moment, ich rufe den letzten Stand ab.“
- „Ich sehe kurz nach, wo wir aufgehört haben.“
- „Lass mich unsere bisherigen Notizen prüfen.“
- „Ich hole kurz den letzten Stand hervor.“
- „Ich schaue nach, was wir dazu festgehalten haben.“
- „Moment, ich gehe kurz in unser Gesprächsprotokoll.“
- „Ich prüfe unsere bisherigen Ergebnisse.“
- „Ich rufe kurz die passende Erinnerung ab.“
- „Lass mich nachsehen, was wir zuletzt besprochen haben.“

---

## 11.14 Gedächtniseintrag gefunden

Diese Meldungen dürfen nur verwendet werden, wenn tatsächlich ein passender Eintrag gefunden wurde.

- „Ich habe den letzten Stand gefunden.“
- „Alles klar, ich weiß wieder, wo wir waren.“
- „Ich habe unsere bisherigen Notizen vor mir.“
- „Der letzte Stand ist geladen.“
- „Ich habe die passende Stelle gefunden.“
- „Unsere bisherigen Ergebnisse sind wieder da.“
- „Ich habe das frühere Gespräch gefunden.“
- „Alles klar, ich habe den Zusammenhang.“
- „Ich weiß wieder, worum es ging.“
- „Ich habe die bisherigen Informationen geladen.“

---

## 11.15 Coding-Modul

- „Alles klar, wir wechseln in den Coding-Modus.“
- „Ich bereite die Coding-Session vor.“
- „Dann sehen wir uns den Code an.“
- „Ich aktiviere die Entwicklungswerkzeuge.“
- „Alles klar, Zeit für etwas Code.“
- „Ich richte mich kurz für die Programmierung ein.“
- „Die Coding-Umgebung wird vorbereitet.“
- „Ich schalte auf die Codeanalyse um.“
- „Ich lade den Projektkontext.“
- „Ich sehe mir den aktuellen Codebestand an.“

---

## 11.16 Codeanalyse läuft

- „Ich prüfe gerade den Code.“
- „Ich gehe die betroffene Stelle durch.“
- „Ich suche gerade nach der Ursache.“
- „Ich analysiere die Zusammenhänge im Projekt.“
- „Ich sehe mir den Ablauf Schritt für Schritt an.“
- „Ich prüfe gerade, wo das Problem entsteht.“
- „Ich vergleiche die relevanten Dateien.“
- „Ich arbeite gerade eine passende Lösung aus.“
- „Ich prüfe den aktuellen Projektstand.“
- „Ich analysiere die letzten Änderungen.“

---

## 11.17 Aufgabe fehlgeschlagen

- „Das konnte ich leider nicht abschließen.“
- „Bei der Bearbeitung ist ein Problem aufgetreten.“
- „Die Aufgabe wurde nicht erfolgreich beendet.“
- „Die Verarbeitung ist fehlgeschlagen.“
- „Ich konnte kein vollständiges Ergebnis erzeugen.“
- „Dabei ist ein technisches Problem aufgetreten.“
- „Die Aufgabe musste beendet werden.“
- „Das Ergebnis konnte nicht erstellt werden.“
- „Ich habe die Bearbeitung nicht erfolgreich abschließen können.“
- „Die Aufgabe benötigt einen neuen Versuch.“

---

## 11.18 Erneuter Versuch

- „Ich versuche es erneut.“
- „Ich starte einen zweiten Versuch.“
- „Ich probiere einen anderen Weg.“
- „Einen Moment, ich setze die Aufgabe neu an.“
- „Ich korrigiere den Ablauf und versuche es noch einmal.“
- „Die Aufgabe bekommt einen neuen Anlauf.“
- „Ich prüfe eine alternative Vorgehensweise.“
- „Ich starte die Bearbeitung erneut.“
- „Ich versuche es mit einer anderen Methode.“
- „Ich gehe die Aufgabe noch einmal neu an.“

---

# 12. Datenstruktur für Lückenfüller

Die Texte sollten nach Status gruppiert werden.

```ts
const feedbackTexts = {
  frontendThinking: [
    'Das schaue ich mir genauer an.',
    'Einen Moment, ich gehe etwas tiefer darauf ein.',
    'Lass mich das kurz durchdenken.',
  ],

  backgroundAccepted: [
    'Alles klar, ich kümmere mich im Hintergrund darum.',
    'Die Aufgabe läuft jetzt im Hintergrund.',
    'Das ist angestoßen. Wir können währenddessen weitermachen.',
  ],

  deepSearchStarted: [
    'Ich gehe dem ausführlicher nach.',
    'Dafür starte ich eine gründlichere Recherche.',
    'Ich untersuche das etwas umfassender.',
  ],

  backendBusy: [
    'Ich arbeite im Hintergrund noch an einer größeren Aufgabe.',
    'Ich kann momentan nur eine große Aufgabe gleichzeitig bearbeiten.',
    'Die vorherige Aufgabe läuft noch.',
  ],

  programStarting: [
    'Alles klar, ich starte das Programm.',
    'Ich fahre die Anwendung hoch.',
    'Startbefehl ist raus.',
  ],

  programLoading: [
    'Das Programm fährt noch hoch.',
    'Die Anwendung lädt gerade.',
    'Der Start dauert noch einen Moment.',
  ],

  programReady: [
    'Das Programm ist jetzt einsatzbereit.',
    'Die Anwendung läuft.',
    'Alles bereit.',
  ],

  memoryLoading: [
    'Ich schaue kurz in unsere bisherigen Gespräche.',
    'Einen Moment, ich rufe den letzten Stand ab.',
    'Ich sehe kurz nach, wo wir aufgehört haben.',
  ],

  taskCompleted: [
    'Übrigens, die Recherche ist jetzt fertig.',
    'Ich habe inzwischen das Ergebnis deiner Anfrage vorliegen.',
    'Die Hintergrundaufgabe ist abgeschlossen.',
  ],
};
```

---

# 13. Wiederholungen vermeiden

Reiner Zufall kann denselben Satz mehrfach hintereinander auswählen.

Deshalb sollte der zuletzt verwendete Text gespeichert werden.

```ts
const lastUsedIndex: Record<string, number> = {};

function getRandomFeedback(category: keyof typeof feedbackTexts): string {
  const texts = feedbackTexts[category];

  if (!texts || texts.length === 0) {
    return 'Einen Moment bitte.';
  }

  if (texts.length === 1) {
    return texts[0];
  }

  let index: number;

  do {
    index = Math.floor(Math.random() * texts.length);
  } while (index === lastUsedIndex[category]);

  lastUsedIndex[category] = index;

  return texts[index];
}
```

Noch besser ist eine kleine Historie.

```ts
const recentTexts: Record<string, string[]> = {};

function getFeedback(
  category: keyof typeof feedbackTexts,
  historySize = 4,
): string {
  const texts = feedbackTexts[category];

  if (!texts || texts.length === 0) {
    return 'Einen Moment bitte.';
  }

  const recent = recentTexts[category] ?? [];

  const available = texts.filter((text) => !recent.includes(text));

  const pool = available.length > 0 ? available : texts;

  const selected = pool[Math.floor(Math.random() * pool.length)];

  recentTexts[category] = [...recent, selected].slice(-historySize);

  return selected;
}
```

---

# 14. Statusmeldungen nicht übertreiben

Sarah sollte nicht bei jedem kleinen Prozess mehrere Meldungen ausgeben.

Empfohlene Regel:

```text
unter 2 Sekunden:
keine zusätzliche Statusmeldung

2 bis 5 Sekunden:
eine Startmeldung

über 8 bis 15 Sekunden:
optional eine weitere Statusmeldung

danach:
nur auf Nachfrage oder bei klarer Zustandsänderung
```

Hintergrundaufgaben sollen nicht ungefragt ständig Fortschrittsmeldungen vorlesen.

Eine Meldung ist sinnvoll bei:

- Start,
- Warteschlange,
- Ressourcenkonflikt,
- Abschluss,
- Fehler,
- Nutzer fragt nach Status.

---

# 15. Memory-Antworten

Das kleine Modell sollte keine langen alten Gespräche selbst rekonstruieren.

Stattdessen sollte das Gedächtnissystem strukturierte Zusammenfassungen liefern.

Beispiel:

```json
{
  "topic": "Kolosseum in Rom",
  "lastState": "Geschichte und Architektur wurden besprochen",
  "openQuestion": "Wie Gladiatorenkämpfe organisiert wurden",
  "suggestedContinuation": "Organisation der Veranstaltungen"
}
```

Das Frontend-Modell kann daraus formulieren:

> „Gestern ging es um das Kolosseum in Rom. Wir hatten zuletzt über seine Geschichte und Architektur gesprochen. Offen war noch, wie die Gladiatorenkämpfe organisiert wurden. Möchtest du dort weitermachen?“

Wichtige Regel:

Sarah darf nur behaupten, etwas gefunden zu haben, wenn das Gedächtnissystem tatsächlich einen Treffer geliefert hat.

Bei keinem Treffer:

> „Ich habe dazu keinen eindeutigen früheren Stand gefunden.“

---

# 16. Kommunikation zwischen Frontend und Backend

Geeignet sind beispielsweise:

- WebSocket,
- Server-Sent Events,
- Redis Pub/Sub,
- RabbitMQ,
- NATS,
- einfache Datenbank-Events mit Polling.

Für eine erste lokale Version reicht:

```text
Frontend API
Backend API
SQLite Queue
WebSocket für Events
```

Beispiel:

```ts
type BackendEvent =
  | {
      event: 'task_queued';
      taskId: string;
      title: string;
    }
  | {
      event: 'task_started';
      taskId: string;
      title: string;
    }
  | {
      event: 'task_completed';
      taskId: string;
      title: string;
    }
  | {
      event: 'task_failed';
      taskId: string;
      title: string;
      error?: string;
    };
```

---

# 17. Beispiel für einen vollständigen Ablauf

Der Nutzer sagt:

> „Sarah, recherchiere ausführlich, welche Datenbank für unser Portal am sinnvollsten ist.“

Frontend-Router erkennt:

```json
{
  "destination": "backend",
  "intent": "deep_search"
}
```

Backend-Auftrag:

```json
{
  "type": "deep_search",
  "title": "Datenbankvergleich für das Portal",
  "request": "Vergleiche geeignete Datenbanken für das Portal",
  "priority": "normal",
  "status": "queued"
}
```

Sarah sagt:

> „Alles klar, ich starte eine ausführliche Recherche im Hintergrund. Wir können währenddessen weitermachen.“

Danach sagt der Nutzer:

> „Öffne bitte VS Code.“

Der Router führt eine lokale Aktion aus.

Sarah sagt:

> „Alles klar, ich öffne VS Code.“

Danach fragt der Nutzer:

> „Wo waren wir gestern beim Rollenmodell stehen geblieben?“

Das Frontend-Modell lädt die Erinnerung und antwortet normal.

Später meldet das Backend:

```json
{
  "event": "task_completed",
  "taskId": "task_1042",
  "title": "Datenbankvergleich für das Portal"
}
```

Die Meldung wird zwischengespeichert, bis der Nutzer nicht mehr spricht.

Sarah sagt:

> „Übrigens, die Recherche zum Datenbankvergleich ist fertig. Soll ich dir die wichtigsten Punkte zusammenfassen oder den vollständigen Bericht öffnen?“

Der Nutzer sagt:

> „Schreib mir das bitte als README in mein Projekt.“

Dann geschieht:

```text
1. Projekt auswählen.
2. VS Code bei Bedarf starten.
3. README-Pfad ermitteln.
4. Bericht in Markdown umwandeln.
5. Datei schreiben.
6. VS Code auf die Datei fokussieren.
7. Abschluss bestätigen.
```

Sarah sagt:

> „Die README wurde erstellt und in VS Code geöffnet.“

---

# 18. Fehler- und Sicherheitsregeln

1. Keine erfundenen Statusmeldungen.
2. „Fertig“ darf nur gesagt werden, wenn der Prozess wirklich abgeschlossen ist.
3. „Programm läuft“ darf erst gesagt werden, wenn der Prozess gefunden wurde.
4. Idealerweise zusätzlich prüfen, ob das Fenster reagiert.
5. „Erinnerung gefunden“ nur bei echtem Treffer.
6. „Recherche abgeschlossen“ nur nach Completion-Event.
7. Keine automatische Unterbrechung laufender großer Aufgaben.
8. Keine automatische Löschung abgeschlossener Ergebnisse.
9. Aufgabenstatus muss nach einem Neustart wiederherstellbar sein.
10. Fehler intern detailliert protokollieren, dem Nutzer aber verständlich erklären.
11. Keine technischen Rohmeldungen wie CUDA-Fehler oder Out-of-Memory direkt vorlesen.
12. Der Nutzer muss große Aufgaben abbrechen können.
13. Der Nutzer muss die Warteschlange anzeigen lassen können.
14. Doppelte identische Aufgaben sollten erkannt werden.
15. Bei versehentlich doppeltem Auftrag nachfragen oder den zweiten Auftrag zusammenführen.

---

# 19. Sinnvolle Befehle für den Nutzer

Sarah sollte später Befehle verstehen wie:

```text
Welche Aufgaben laufen gerade?

Wie weit ist die Recherche?

Was steht noch in der Warteschlange?

Starte die Codeanalyse danach.

Setze die Recherche auf hohe Priorität.

Brich die aktuelle Recherche ab.

Entferne die zweite Aufgabe aus der Warteschlange.

Zeig mir das letzte Ergebnis.

Lies mir nur die Zusammenfassung vor.

Öffne den vollständigen Bericht.

Schreib das Ergebnis in eine README.

Öffne das Ergebnis in VS Code.
```

---

# 20. Minimaler technischer Startumfang

Für eine erste Version reichen:

```text
1 Frontend-Router
1 Frontend-Modell
1 Backend-Router
1 großes Backend-Modell
1 persistente Queue
1 Worker
1 Event-Verbindung
1 Ergebnisspeicher
```

Noch nicht notwendig:

- mehrere große Modelle gleichzeitig,
- echtes Pausieren laufender Inferenz,
- automatische Modellmigration,
- verteilte Worker,
- komplexe Prioritätslogik,
- dynamische GPU-Verteilung,
- mehrere Server.

Die erste Version sollte zunächst zuverlässig können:

```text
Aufgabe annehmen
→ speichern
→ einreihen
→ Modell laden
→ ausführen
→ Ergebnis speichern
→ Frontend informieren
→ Ergebnis präsentieren
```

---

# 21. Zentrale Designregel

Die Nutzeroberfläche soll sich wie eine einzige Sarah anfühlen.

Intern darf das System aus vielen Komponenten bestehen. Nach außen soll Sarah aber nicht ständig erklären:

- welches Modell gerade läuft,
- wie viele Parameter es hat,
- wie viel VRAM belegt ist,
- welcher Worker die Aufgabe übernommen hat.

Technische Details können auf Nachfrage angezeigt werden.

Im normalen Gespräch reicht:

> „Ich kümmere mich im Hintergrund darum.“

oder:

> „Die große Verarbeitung ist gerade noch mit deiner vorherigen Aufgabe beschäftigt.“

Das wichtigste Ziel lautet:

```text
Lange Aufgaben laufen im Hintergrund.
Sarah bleibt jederzeit ansprechbar.
Ergebnisse werden später natürlich in das Gespräch eingebracht.
```
