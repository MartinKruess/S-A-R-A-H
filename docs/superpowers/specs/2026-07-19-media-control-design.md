# Generische Mediensteuerung — Schicht 1 (Design)

**Datum:** 2026-07-19
**Branch:** `feat/media-control` (vormals `feat/spotify-transport`)
**Ersetzt:** den überholten Spotify-spezifischen Transport-Entwurf.

## Architektur-Rahmen: Zwei Schichten

S.A.R.A.H. steuert Programme in zwei getrennten Schichten:

- **Schicht 1 — Allgemeine Bedienung (uniform):** Befehle, die überall dasselbe bedeuten
  (Transport: Play/Pause/Toggle/Next/Previous). **Ein** Executor bedient jeden Player —
  Spotify, Browser/YouTube, VLC, Amazon Music. Kein OAuth, kein Premium.
  Action-Namen: **`media_*`**. **← diese Spec.**
- **Schicht 2 — Programmspezifisch (reich):** Fähigkeiten, die pro Anbindung verschieden sind
  und gezielt über die jeweilige API laufen (Spotify: Songsuche/Playlists/Shuffle/Repeat;
  E-Mail; weitere). Adapter hinter dem bestehenden OAuth/Provider-Muster.
  Action-Namen: **`<provider>_*`** (`spotify_*`, `email_*`, …). Bereits vorhanden: `spotify_volume`.

**Abgrenzungsregel:** Transport läuft **immer** über Schicht 1 (uniform, kein OAuth) — auch
„pausiere *Spotify*" (Named-Target; GSMTC kann eine bestimmte Session ansprechen). Schicht 2
nur für das, was Schicht 1 nicht kann (nach Namen spielen, Playlists, Shuffle/Repeat, E-Mail).

## Ziel dieser Spec (Schicht 1)

Sarah steuert die **aktive Windows-Mediensitzung** per Sprache: Play, Pause, Toggle, nächster/
vorheriger Titel. Über die **Global System Media Transport Controls** (GSMTC,
`Windows.Media.Control`), gekapselt in einem kleinen C#-Helper. Kein Spotify-OAuth, kein Premium.

### Nicht-Ziele (YAGNI)

- Kein Shuffle/Repeat → Schicht 2 (braucht die Spotify-Web-API).
- Kein Namen-/Playlist-Matching, keine Suche → Schicht 2.
- Kein Session-Scoring-Punktesystem, kein Event-Cache (Doc-Entwurf §11/§22) — schlanke
  Auswahl genügt (siehe unten). Kann später nachgezogen werden.
- Keine interaktive Rückfrage („welchen Player?") — Actions sind einmalig; deterministischer
  Tiebreak statt Dialog.

## Zukunftssicherheit: Vertrag trennt von Ausführung

Cross-Platform entsteht durch die **Trennung von Contract und Executor**, nicht durch die
Windows-Methode. Der `media_*`-Action-Vertrag ist auf jeder Plattform identisch; pro OS wird
nur das Backend getauscht:

```
Router → media_* (Action + optionales Target)      ← plattformUNabhängig
            ↓
        MediaController-Interface                   ← der Vertrag (TS)
            ↓
  Windows: C#-Helper/GSMTC │ (später) Linux: MPRIS │ Android: MediaSession │ iOS: MPRemoteCommandCenter
```

Electron läuft nicht auf Mobil — „mobil" wird später eine eigene native App, die denselben
**JSON-Protokoll-Vertrag** spricht. Wiederverwendbar ist die Contract-/Router-Schicht, nie der
Executor-Code. Der C#-Helper hinter einem JSON-Contract macht genau diese Grenze explizit.

## Actions

Fünf neue Actions (Doc §3/§24). Konvention `media_*`.

| Action | Param-Schema | Bedeutung |
|---|---|---|
| `media_play` | `z.string().max(40)` | Wiedergabe starten/fortsetzen |
| `media_pause` | `z.string().max(40)` | Wiedergabe pausieren |
| `media_toggle` | `z.string().max(40)` | zwischen Play/Pause wechseln (Rückfallebene) |
| `media_next` | `z.string().max(40)` | nächster Titel |
| `media_previous` | `z.string().max(40)` | vorheriger Titel / Titelanfang |

**Param = optionales Target.** Leerstring `''` = aktive Sitzung (Normalfall). Ein Programmname
(`spotify`, `chrome`, …) = gezielt diese Sitzung. Der Router liefert meist `''`.

> Zur Reihenfolge: der Param muss **optional** sein. Beispiel-Tag ohne Target:
> `[ACTION:media_pause:]` (leerer Param). Mit Target: `[ACTION:media_pause:spotify]`.

## Session-Auswahl (schlank)

1. Target genannt → Sitzung, deren `SourceAppUserModelId` das Target enthält (case-insensitive).
   Nicht gefunden → `NO_MATCHING_SESSION`.
2. Kein Target → `GetCurrentSession()` von Windows.
3. Keine aktuelle, aber genau eine Sitzung mit Status `Playing` → diese.
4. Sonst keine eindeutige/keine Sitzung → `NO_MEDIA_SESSION`.

`media_toggle` liest den `PlaybackStatus` der gewählten Sitzung und sendet Pause bei `Playing`,
sonst Play. `media_play`/`media_pause` senden direkt (idempotent — Player ignoriert No-Ops).

## Komponenten

### 1. C#-Helper `media-helper.exe`

Kleines self-contained .NET-Console-Programm. TFM `net8.0-windows10.0.19041.0` (projiziert
`Windows.Media.Control` ohne NodeRT). Ein Kommando pro Aufruf, JSON über **stdin → stdout**.

**Request:**
```json
{ "action": "media_pause", "target": "" }
```

**Response (Erfolg):**
```json
{ "success": true, "app": "Spotify.exe", "status": "paused" }
```

**Response (Fehler):**
```json
{ "success": false, "error": "NO_MEDIA_SESSION" }
```

Fehlercodes: `NO_MEDIA_SESSION`, `NO_MATCHING_SESSION`, `ACTION_NOT_SUPPORTED`, `ACTION_FAILED`.

Ablauf: `GlobalSystemMediaTransportControlsSessionManager.RequestAsync()` → Session per obiger
Regel wählen → `TryPlayAsync`/`TryPauseAsync`/`TryTogglePlayPauseAsync`/`TrySkipNextAsync`/
`TrySkipPreviousAsync`. Vor `next`/`previous`/`play`/`pause` die `GetPlaybackInfo().Controls`
prüfen; nicht unterstützt → `ACTION_NOT_SUPPORTED`.

**Media-Key-Fallback (Doc §19):** Findet Schritt 4 gar keine Session (`NO_MEDIA_SESSION`) für
`toggle`/`next`/`previous`, sendet der Helper als letzte Instanz die entsprechende Medientaste
(`VK_MEDIA_PLAY_PAUSE`/`NEXT_TRACK`/`PREV_TRACK` via `keybd_event`) und meldet
`{ success: true, app: "media-key" }`. Für `play`/`pause` **kein** Key-Fallback (Taste ist nur
Toggle → würde ggf. das Falsche tun).

**Bundling & Fund:** Exe liegt in `resources/media-helper/` und wird zur Laufzeit über dieselbe
Resource-Auflösung wie Piper gefunden (dev vs. gepackt). Aufnahme in den electron-builder-
`extraResources`-Block analog Piper.

### 2. `MediaController`-Interface + `WindowsMediaController` (TS)

`src/services/actions/media-controller.ts`:
```ts
export interface MediaResult { ok: boolean; speak?: string; }

export interface MediaController {
  play(target: string): Promise<MediaResult>;
  pause(target: string): Promise<MediaResult>;
  toggle(target: string): Promise<MediaResult>;
  next(target: string): Promise<MediaResult>;
  previous(target: string): Promise<MediaResult>;
}
```

`WindowsMediaController implements MediaController`: startet den Helper per `execFile`
(injizierbar wie `SystemActions.execFn`), schreibt den Request auf stdin, parst die JSON-Antwort,
mappt Fehlercodes auf ehrliche deutsche `speak`-Texte:

- `NO_MEDIA_SESSION` → „Ich sehe gerade keine laufende Wiedergabe."
- `NO_MATCHING_SESSION` → „Ich finde gerade keine passende Wiedergabe."
- `ACTION_NOT_SUPPORTED` → „Das kann der aktuelle Player nicht."
- `ACTION_FAILED` / Parse-/Exec-Fehler → „Das hat gerade nicht geklappt."
- Erfolg → stilles `{ ok: true }`.

Nicht-`win32` → `{ ok: false, speak: 'Das unterstützt dein System nicht.' }` (wie `SystemActions`).

### 3. `action-schemas.ts`

Fünf `media_*`-Einträge (siehe Tabelle). Gate-Stämme (`ACTION_HINT_STEMS`) konservativ um
`'pausier'` ergänzen; `'musik'`/`'spotify'` decken den Rest. Kein `'weiter'`/`'zurück'`
(Über-Match im 9B-Gespräch).

### 4. `action-service.ts`

`ActionDeps` bekommt `media: MediaController`. Fünf `case`-Zweige, Target = `parsed.data`:
```ts
case 'media_play':     return this.deps.media.play(parsed.data as string);
case 'media_pause':    return this.deps.media.pause(parsed.data as string);
case 'media_toggle':   return this.deps.media.toggle(parsed.data as string);
case 'media_next':     return this.deps.media.next(parsed.data as string);
case 'media_previous': return this.deps.media.previous(parsed.data as string);
```

### 5. `routing-prompt.ts`

Fünf Zeilen in der Command-Liste + deutsche Beispiele. Target-Param erklären (leer = aktive
Wiedergabe):
```
- media_pause:<leer|programm> — laufende Wiedergabe pausieren ("Pause", "Mach die Musik aus")
- media_play:<leer|programm>  — Wiedergabe fortsetzen ("Weiter", "Play")
- media_toggle:<leer|programm>— Play/Pause umschalten ("Mach die Musik an")
- media_next:<leer|programm>  — nächster Titel ("Nächstes Lied", "Skip")
- media_previous:<leer|programm> — vorheriger Titel ("Zurück", "Eins zurück")
```
Beispiele u. a.: `"Pause" → [ACTION:media_pause:]`, `"Nächstes Lied" → [ACTION:media_next:]`,
`"Pausiere Spotify" → [ACTION:media_pause:spotify]`. Abgrenzung zu `open_program`/`close_program`
(Doc §6): „Schließe Spotify" ist ein Programm-Befehl, „Pausiere Spotify" ein Medien-Befehl.

### 6. Verdrahtung `main.ts`

`WindowsMediaController` instanziieren (mit Helper-Pfad), in `ActionDeps.media` reichen.

## Tests

- **`media-controller.test.ts`** (mirror `spotify-actions.test.ts`): injizierter Helper-Runner —
  je Action korrekter JSON-Request (action + target); Erfolg → stilles `ok`; jeder Fehlercode →
  richtiger deutscher `speak`; kaputte/leere Helper-Antwort → generisch; `platform !== win32` →
  „unterstützt dein System nicht"; Exec-Throw → generisch, kein Reject.
- **`action-schemas.test.ts`**: `media_*` akzeptieren `''` und einen kurzen Programmnamen,
  lehnen zu lange Strings ab; `isActionName` kennt die fünf Namen.
- **`action-service.test.ts`**: Dispatch ruft die richtige `MediaController`-Methode mit dem
  Target-Param.
- **C#-Helper:** kein vitest — verifiziert manuell (siehe unten). Optional ein Smoke-Skript, das
  die Exe mit `media_pause` aufruft und valides JSON zurückbekommt.

## Verifikation

- `npm run typecheck`, `npm test`, `npm run build` grün (Claude). C#-Helper baut per
  `dotnet publish` (self-contained) — Build-Schritt dokumentiert.
- Manuell (Martin, `npm start`): in **Spotify** *und* **YouTube (Browser)** je etwas abspielen →
  „Pause"/„Weiter"/„Nächstes Lied" auf die jeweils laufende Sitzung; die spielende Sitzung
  wechseln und erneut testen; „Pausiere Spotify" (Named-Target); **alles gestoppt** → ehrliche
  Ansage; Media-Key-Fallback prüfen (Player ohne GSMTC-Session, falls vorhanden).

## Doku-Nachzug

`problems/features.md`: Schicht-1-Mediensteuerung nach Merge auf „✅ umgesetzt"; Spotify-Roadmap
neu einordnen — Transport ist jetzt Schicht 1, `spotify_*`-Reste (Shuffle/Repeat/Suche/Playlists)
bleiben Schicht 2.
