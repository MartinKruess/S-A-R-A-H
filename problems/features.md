# S.A.R.A.H. — Bugs, Features & Plan (persistent)

> Stand 19.07.2026. Einzige Quelle für offene Punkte — `anmerkungen.md`, `spotify.md`, `analyze-fabel.md` wurden hier konsolidiert und gelöscht; `talkabouts.md` ist nur noch flüchtiger Review-Scratch.

## ✅ Umgesetzt (auf `dev`)

- **Bug 1** — Spotify-Start-Fehlmeldung („nicht installiert" obwohl gestartet): `launchAppx` ignoriert den Explorer-Exit-Code, verifiziert per `tasklist` + `ProgramEntry.processName` → **PR #23**.
- **STT-Qualität** — Windows-Mic-Pegel (Nutzerseite) + Input-Normalisierung + `vad_filter` + Modell `small`→`large-v3-turbo` (int8) + Mic-Warm-Halten gegen abgeschnittene Satzanfänge → **PR #24**.
- **Füllsätze V1** — gesprochene Brücke über die Modell-Swap-Pause: 2B→9B `frontendThinking`, 9B→2B `switchingBack`, via Main-only Event `llm:filler` (`src/services/llm/filler-phrases.ts`) → **PR #25**. Die übrigen §11-Kategorien (Hintergrund/Deep-Search/Programm-Ladestatus/Coding/Memory/Fehler) warten aufs Backend-/Task-System (Architektur §1–21).
- **Gate-Fix** — Infinitive/höfliche Befehle („kannst du Spotify **starten**") werden erkannt: Wortanfang-Stämme `ACTION_HINT_STEMS` → **PR #26**.
- **Integrationen V1 (Spotify-Lautstärke)** — generischer OAuth-Layer (selbstgebauter PKCE), Settings-Tab „Integrationen", `spotify_volume`/`spotify_volume_adjust` → **PR #27**. Live E2E bestätigt.
- **Mediensteuerung Schicht 1 (generisch)** — `media_*` play/pause/toggle/next/previous über Windows GSMTC (self-contained C#-Helper `native/media-helper/`, JSON-stdio), playerübergreifend (Spotify/Browser/VLC), ohne OAuth/Premium; plattformneutraler `MediaController`-Vertrag → **PR #28**. Live E2E bestätigt (Spotify + YouTube, inkl. 9B-warm → Router-Dispatch). Spec: `docs/superpowers/specs/2026-07-19-media-control-design.md`.

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

- **Mediensteuerung Schicht 1 (generisch) ✅ gemergt (PR #28):** play/pause/toggle/next/previous über Windows GSMTC (C#-Helper `media-helper.exe`), playerübergreifend, ohne OAuth/Premium. Siehe „Umgesetzt" oben.
- **Schicht 2 (Spotify-spezifisch, künftig):** Shuffle/Repeat, nach Namen spielen, Playlists — via Spotify-Web-API (Premium + aktives Gerät). Bleiben `spotify_*`-Actions hinter dem OAuth-Adapter.
- **V3 — Nach Namen spielen (Gruppe B):** Lied suchen+spielen (`GET /search` → play `uris`), Playlist abspielen (`GET /me/playlists` → play `context_uri`). Braucht Fuzzy-Namensauflösung + `playlist-read-private`.
- **V4 — Playlist bearbeiten (Gruppe C):** Lied add/remove (`POST`/`DELETE /playlists/{id}/tracks`). Braucht `playlist-modify-public/-private` → Nutzer muss **neu verbinden** (Scope-Consent).

---

## Feature: Medien-Konversationskontext (geplant, nach Schicht 1)

Damit knappe Folgebefehle natürlich funktionieren. „weiter" ist von Natur aus zweideutig — „mach weiter" = fortsetzen (`media_play`), „ein Lied weiter" = nächstes (`media_next`). Lösung: sich die **letzte Medien-Aktion/Richtung** merken.

- **Kern:** deterministische Komponente `MediaContext` (`{letzte Aktion, Richtung, Ziel, Zeitstempel}`), die ein definiertes Set knapper Folgeworte auflöst — **nicht** dem 2B-Router überlassen. Nach „ein Lied weiter" → knappes „weiter" = `media_next` (nicht resume), „zurück" = `media_previous`.
- **Lebensdauer:** kurzes, gleitendes **10–15-s-Zeitfenster** (bewusst simpel). Recency-gebunden — nach längerem Plaudern ist das Fenster abgelaufen, „weiter" fällt zurück (wie bei Menschen: nach 5 Min „weiter!" versteht auch niemand).
- **Kein** neuer Mic-Timer nötig: das Zuhör-Fenster ist bereits gelöst (Keyword → 30 s, gleitend; PTT diskret). Dieses Feature ist rein der Intent-Kontext.
- **Scope V1:** nur Schicht-1-Transport (weiter/zurück/stop). „Dauerschleife"/Repeat und Playlist-Folgesachen („mach mal ein zweiter") sind Schicht 2 → ziehen nach, sobald Schicht 2 existiert. Erst Brainstorm→Spec→Plan.
- **Nebenbei:** mehr Synonyme/Begrifflichkeiten (inkrementell, Router-Beispiele + Gate-Stämme).

Ehrlicher Haken: Die API ist der leichte Teil — der Aufwand steckt ab V3 im **Voice-Routing** (gesprochene Namen auf Playlist-/Song-IDs auflösen).

**Offene Follow-ups (aus V1):** Callback-Pfad pro Provider `/callback/<id>`? · „etwas lauter/leiser" landet bei ±25 statt ±5 (Routing-Prompt schärfen).

### Später, separat: Browser / Games gezielt

Geht **nur** über den Windows-Mixer (Web-API kann nur Spotify). Ansatz `ISimpleAudioVolume` via `IAudioSessionManager2`: Sessions enumerieren → per `GetProcessId()` gegen `tasklist` die App matchen → `SetMasterVolume(scalar)`. Aufwändiger (umfangreiches Inline-C# oder C#-Helfer-Binary) → eigene spätere Runde.

---

## Kleinere offene Punkte

- **Routing-Prompt:** klarstellen, dass `set_volume` einen **absoluten** Zielwert (0–100) erwartet, keine Deltas.

---

## Offene Bugs — Programm-Scan

> Konsolidiert aus `anmerkungen.md` (gelöscht 19.07.). Erledigt war nur `type`-Feld + appx-Start (Action-Layer); der Rest ist offen. Siehe Memory `project_program_scan_bugs`.

- **Discord** — Eintrag zeigt auf den Updater `…\Discord\Update.exe` statt die echte App `…\Discord\app-*\Discord.exe`. Der Launcher lehnt `type: updater` ehrlich ab, aber der Pfad sollte korrigiert werden.
- **PDFgear** — Pfad ist `PDFLauncher.exe` (Launcher, nicht Hauptprogramm). Kann funktionieren → beobachten, ggf. ersetzen.
- **OneDrive** — läuft oft als Hintergrunddienst → Start bringt nicht immer ein sichtbares Ergebnis.
- **Epic Games Launcher** — Pfad `…Win32\EpicGamesLauncher.exe` wirkt ungewöhnlich (Win32 statt Win64) → prüfen.
- **RocketLeague** — `…Win64\RocketLeague.exe`; Launcher-/Anti-Cheat-abhängig, Direktstart evtl. instabil.
- **OpenOffice** — Aliase `soffice.exe` (Haupt) ✅, `scalc/swriter/sbase.exe` überschneiden sich (alle „OpenOffice"). Matcher fragt bei Mehrdeutigkeit nach; die Überschneidung selbst bleibt. Empfehlung: `soffice.exe` = Default.

---

## Offen: Voice/TTS & Code-Qualität

> Konsolidiert aus `analyze-fabel.md` (gelöscht 19.07.). Die kritischen Bugs (§3), Action-Layer/History (§5.1/5.2) und appx sind erledigt; hier bleiben die offenen Reste.

- **Piper spawnt pro Satz einen Prozess** (`piper-provider.ts`) — 50–150 ms Overhead/Satz. Ein persistenter Piper-HTTP-Server (wie faster-whisper) → <10 ms. Größter TTS-Latenz-Hebel.
- **STT schreibt Temp-WAV auf Disk** (`faster-whisper-provider.ts`) statt In-Memory (multipart) — unnötiges I/O, SSD-Verschleiß bei häufigen Kurznachrichten.
- **STT-Startup-Timeout** bleibt hoch (Modell-Download); der Spawn-Abort bei fehlendem Python ist erledigt.
- **Silence-VAD fixer Schwellwert** `SILENCE_RMS_THRESHOLD = 0.01` (`voice-service.ts`) — unkalibriert; in lauten Umgebungen löst der Silence-Timer nie aus. Betrifft nur den Keyword-Modus → adaptive VAD nötig.

> ✅ Verifiziert erledigt (19.07., waren in der alten Fabel-Analyse noch offen): LLM-Retry-once-on-timeout (`chat-with-timeout.ts`), `require('electron')`-Callbacks entfernt, toter VRAM-`_load`-Param entfernt (`swapModels(unload)`), IPC-Input-Validation (`ipc-validation.ts`).

---

## Offen: Architektur/Strategie

> Aus `analyze-fabel.md` §5 + §7. Größere Brocken, teils abhängig vom Backend-/Task-System (Architektur-Doc unten, §1–21).

- **Keyword/Wake-Word-Modus nicht funktionsfähig** (`voice-service.ts`) — beim Init auf `off` gezwungen; Porcupine braucht einen Picovoice-Key (kostenpflichtig), kein Wizard-Setup/UI-Hinweis. Wichtig für „always-on". (Verwandt: das 30-s-Konversationsfenster, auf das der Medien-Kontext aufbaut.)
- **Kein Langzeit-Kontext** — `MAX_CONTEXT_TOKENS` trimmt hart; echte Ganztags-Sessions brauchen smarte Zusammenfassung statt Trim.
- **Keine generischen Tool-Calls / Structured Output** — der Action-Layer deckt feste Actions ab, aber allgemeine strukturierte Aufgaben (E-Mail verfassen, Kalender, Datei umbenennen) fehlen.
- **Roadmap (mittel/lang):** TTS-Upgrade (Coqui/ElevenLabs), E-Mail-Integration (IMAP/OAuth — OAuth-Layer existiert), Claude-Code-API-Anbindung, Backend-Route (Cloud), Browser-Steuerung (CDP), UI-Automation (WinAPI UIAutomation), Vision/Multimodal (RTX 3050 zu klein → Cloud).

> **Perf-Baseline (Referenz, gemessen 2026-04-13):** Kaltstart ~14 s (Whisper ~978 ms · Router ~4.7 s · Worker ~6.8 s · TTS ~1.8 s); Warmstart ~5.4 s (Whisper ~485 ms · Worker ~2.9 s · TTS ~2.0 s). Bottlenecks: TTS-Prozessstart, Worker-VRAM-Swap. (Vgl. Memory `project_voice_perf_baseline`.)

---


## Feature: Backend / Hintergrundaufgaben-System (Design, viel später)

> Das große Architektur-Dokument (Frontend/Backend-Router, persistente Task-Queue, Worker-Loop, Ergebnis-Events, kompletter Füllsatz-/Statusmeldungs-Katalog §11) ist ausgelagert nach **`docs/superpowers/specs/2026-07-19-backend-tasksystem-design.md`**. Es baut das System, das viele der offenen Architektur-Punkte oben adressiert. §11 Lückenfüller **V1 ist gemergt** (PR #25); der Rest wartet auf dieses System. Noch nicht terminiert.
