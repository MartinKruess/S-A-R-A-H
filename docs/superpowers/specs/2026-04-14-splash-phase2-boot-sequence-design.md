# Splash Phase 2 — Boot Sequence Design Spec

## Überblick

Nach der Text-Animation (Phase 1) zeigt der Splash eine Boot-Sequence: Services werden real geladen, Statusmeldungen erscheinen unten links, und Sarah "erwacht" schrittweise — erst schreibend (Chat-Bubble), dann sprechend (TTS). Der Orb-Reveal ist an den echten Router-Ready-State gekoppelt.

## Startup-Architektur

### Sofort bei App-Start (parallel zu Phase 1)

- Fenster + Splash-Screen erscheint instant
- Main-Process beginnt **Preload + Init** von Whisper + Router im Hintergrund
- Whisper + Router `init()` starten sofort parallel zu Phase 1
- Ergebnisse werden **gepuffert** bis Renderer `boot-ready` sendet (Phase 1 fertig)
- Falls Services schneller fertig sind als Phase 1: kein Problem, gepufferte Status-Events werden nach `boot-ready` nachgeliefert
- Phase-1 Text-Animation läuft unabhängig davon

### Timing

- Dynamisch: 1s Vorlauf + echte Router-Zeit + 1s Piper
- Kein künstliches Warten — reale Ladezeiten bestimmen die Dauer
- Erwartete Gesamtzeit: ~6s (bei ~4s Router), kann kürzer sein wenn Router schneller startet

## Boot-Sequence Timeline

Phase 1 (Text-Animation) muss fertig sein bevor die Boot-Sequence startet.

| Schritt | Statusmeldung (unten links) | Was passiert | Orb | Dauer |
|---------|-----------------------------|-------------|-----|-------|
| 1 | "Spracherkennung wird aktiviert ..." | Whisper aktivieren | Dimmed, klein (Phase-1-Zustand) | ~500ms real |
| 2 | "Sarah Protokoll wird initialisiert ..." | Router/Phi4-mini Init, echtes Monitoring | Dimmed, klein | ~4s real (variabel) |
| 3 | — | Router ready → Orb Reveal-Animation startet | Reveal: Scale 0.4→1.0, Lichter hoch | ~3.5s (bestehende Reveal-Animation) |
| 4 | — | Chat-Bubble "Willkommen!" erscheint | Voll sichtbar | ~2s sichtbar |
| 5 | "Sprachprotokolle werden geladen ..." | Piper TTS aktivieren | Voll sichtbar | ~1s real |
| 6 | — | Break-Animation (100-300ms vor TTS-Start), Sarah spricht: "Huch, jetzt bin ich einsatzbereit!" | Break-Effekt | TTS-Dauer |
| 7 | — | Transition zum SarahOrb-Screen (siehe Transition-Spec) | Transport-Schaukeln | ~2.1s |

## Statusmeldungen

### Position & Style

- Unten links im Splash-Screen, dezent wie System-Boot-Log
- Kleine Schrift, helle aber gedämpfte Farbe (z.B. `#a0a0b8` passend zum Subtitle)

### Verhalten

- **Ersetzend**: immer nur eine Meldung sichtbar
- Alte Meldung fadet aus, neue fadet ein
- Animierte Punkte bei Wartezeiten: `. → .. → ... → (leer) → .` (Loop)

## Chat-Bubble "Willkommen!"

- Erscheint nach Orb-Reveal (Schritt 4)
- Gestyled im Dashboard-Chat-Style (wie Sarahs Nachrichten im SarahOrb-Screen)
- Nur Text, kein Voice (Piper ist zu diesem Zeitpunkt noch nicht geladen)
- Verschwindet nach ~2s oder wenn Piper-Laden beginnt
- **UX-Intention:** Sarah kann erst nur schreiben, dann sprechen — der Übergang von Bubble zu Voice erzählt diese Geschichte

## Orb-Änderungen gegenüber Phase 1

- **Break-Animation nicht mehr klickbar** im Splash — Click-Listener in `src/splash.ts` (Zeile 26-28) entfernen (nicht in sarahHexOrb.ts, `triggerBreak()` bleibt public)
- Break wird **getimed** ausgelöst wenn Piper ready ist (Schritt 6)
- Break startet **100-300ms vor** dem TTS-Satz (damit es aussieht als käme der Break von Sarah)
- Bestehende Reveal-Animation (spotlight → reveal) bleibt, wird aber an Router-Ready gekoppelt statt an festen Timer

## IPC-Kommunikation

### Preload-Phase (parallel zu Phase 1)

1. Main: Importiert Whisper/Router Module, erstellt Provider-Instanzen
2. Main: Startet `whisperProvider.init()` + `routerService.init()` sofort (parallel)
3. Main: Puffert Ergebnisse (whisper-done, router-done Flags)
4. Main: Wartet auf `boot-ready` vom Renderer (Phase 1 fertig)
5. Nach `boot-ready`: Liefert gepufferte Status-Events nach oder wartet auf noch laufende Inits

### Boot-Sequence

3. Main: Aktiviert Whisper → sendet `boot-status` mit `{ step: 'whisper', message: 'Spracherkennung wird aktiviert ...' }`
4. Whisper ready → Main: Aktiviert Router → sendet `boot-status` mit `{ step: 'router', message: 'Sarah Protokoll wird initialisiert ...' }`
5. Router ready → Main: sendet `boot-status` mit `{ step: 'router-ready' }` → Renderer startet Orb-Reveal + Chat-Bubble
6. Main: Aktiviert Piper → sendet `boot-status` mit `{ step: 'piper', message: 'Sprachprotokolle werden geladen ...' }`
7. Piper ready → Main: sendet `boot-status` mit `{ step: 'piper-ready' }` → Renderer startet Break + TTS
8. TTS fertig → Renderer sendet `splash-done` → Transition-Sequence (siehe Transition-Spec)

### Neue Preload-APIs

- `sarah.onBootStatus(callback: (status: BootStatus) => void)` — Listener für Boot-Meldungen
- `sarah.bootReady()` — Signal vom Renderer dass Phase 1 fertig ist und Boot starten kann

### BootStatus Type

```typescript
type BootStatus = {
  step: 'whisper' | 'router' | 'router-ready' | 'piper' | 'piper-ready';
  message?: string;
};
```

## Änderungen an bestehenden Dateien

- **`src/main.ts`**: Service-Init umbauen — Preload parallel zu Splash, sequentielle Aktivierung nach `boot-ready`, Boot-Status IPC senden
- **`src/splash.ts`**: `hold`-Phase + `done`-Phase ersetzen durch Boot-Sequence-Listener. Statusmeldungen rendern, Chat-Bubble rendern, Break-Timing, TTS-Aufruf
- **`splash.html`**: Container für Statusmeldungen (unten links) + Chat-Bubble hinzufügen
- **`src/preload.ts`**: `onBootStatus`, `bootReady` APIs hinzufügen
- **`src/sarahHexOrb.ts`**: Click-Listener für Break im Splash entfernen (nur noch programmatisch triggerbar)

## Fehlerbehandlung

- **Whisper-Init schlägt fehl:** Fehler loggen, Status überspringen, weiter mit Router-Init. Spracherkennung ist dann im Dashboard nicht verfügbar, aber App startet trotzdem.
- **Router-Init schlägt fehl:** Fehler loggen, Orb-Reveal trotzdem auslösen (Sarah ist "da" aber eingeschränkt). Boot-Sequence läuft weiter.
- **Piper-Init schlägt fehl:** Fehler loggen, Break-Animation ohne TTS auslösen. `splashDone()` trotzdem feuern.
- **TTS-Aufruf schlägt fehl:** Break-Animation läuft trotzdem, Fallback-Timeout (6s) stellt sicher dass `splashDone()` feuert.
- **Grundregel:** Boot-Sequence darf niemals hängenbleiben oder abstürzen. Jede Phase hat einen Fallback/Timeout.

## Abgrenzung

- Phase-1 Text-Animation (fade-in, streak, dissolve etc.) wird NICHT verändert
- Transition zum SarahOrb-Screen ist in separater Spec (`2026-04-14-splash-transition-design.md`)
- Erste-Start-Erlebnis (Onboarding) kommt separat danach
