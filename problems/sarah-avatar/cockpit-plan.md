# Cockpit Dashboard — Plan

Branch: `feat/dashboard`
Ziel-Optik: `problems/sarah-avatar/cockpit-optimiert.png`
Referenz-Implementierung: `cockpit.md` + `cockpit.css` (als Inspiration, nicht 1:1)

## Design-Tokens

### Farben (an Referenz angepasst, saturiert)
```
--cockpit-bg-void:        #05070D   /* Haupt-Hintergrund */
--cockpit-bg-deep:        #0B1220   /* Panel Base */
--cockpit-bg-panel:       rgba(11,18,32,0.72)  /* Glass-Panel */

--cockpit-accent-cyan:    #00E5FF   /* Primary / CPU */
--cockpit-accent-violet:  #7C3AED   /* Purple / GPU */
--cockpit-accent-pink:    #FF2FD1   /* Pink / RAM */
--cockpit-accent-mint:    #22FFC0   /* Audio / positive states */
--cockpit-accent-red:     #FF3B3B   /* Error / Critical */

--cockpit-text-hud:       #D8F1FF
--cockpit-text-dim:       #7B86B8
```

### Metrik-Zuordnung
- CPU → Cyan
- GPU → Violet
- RAM → Pink
- Audio → Mint

### Fonts (Drei-Font-Stack)
- **Orbitron** — Panel-Titel, Header, HUD-Labels
- **Inter** — Body, normale Texte
- **JetBrains Mono** — Zahlen, Stats, CPU/GPU-Werte

### Gradients
```
/* Main Glow / Panel-Border */
linear-gradient(135deg, #00E5FF, #7C3AED)

/* Highlight */
linear-gradient(90deg, #FF2FD1, #00E5FF)

/* Background subtle */
radial-gradient(circle at center, #0B1220, #05070D)
```

## Panel-Pattern: Double-Layer Chamfer

Grund: `clip-path` schneidet `box-shadow` ab → kein echter Outer-Glow möglich.
Lösung: Wrapper mit Gradient-Hintergrund + `clip-path`, innerer Container mit dunklem BG + leicht kleinerem `clip-path`.

```
.panel-wrapper {
  background: linear-gradient(135deg, #00E5FF, #7C3AED);
  clip-path: polygon(12px 0, calc(100% - 12px) 0, 100% 12px,
                     100% calc(100% - 12px), calc(100% - 12px) 100%,
                     12px 100%, 0 calc(100% - 12px), 0 12px);
  padding: 1px;  /* = Border-Dicke */
}
.panel-inner {
  background: rgba(11,18,32,0.85);
  clip-path: polygon(11px 0, calc(100% - 11px) 0, ...);  /* 1px kleiner */
  backdrop-filter: blur(14px);
}
```

## Layout-Struktur

3-Column Grid:
```
┌─────────────────────────────────────────────┐
│              Banner (Willkommen + Clock)    │
├──────────┬───────────────────────┬──────────┤
│  Left    │                       │  Right   │
│  Panel 1 │      Hero Zone        │  Panel 1 │
│  Panel 2 │   (Gradient/Orb-ähnl.)│  Panel 2 │
│          │                       │          │
└──────────┴───────────────────────┴──────────┘
```

4 Panels (später befüllt):
- Links oben: CPU / GPU / RAM Ringe
- Links unten: Voice In/Out Meter
- Rechts oben: Termine / Schedule
- Rechts unten: Wetter + Musik

## Was wir NICHT aus cockpit.md übernehmen

- **Kein zweiter Three.js-Orb** — Sarah-View hat bereits einen. Hero bleibt statischer Gradient-Placeholder.
- **Einfacheres Grid** — Referenz hat 6 Bereiche (Nested Grid), wir haben 4.
- **Single-Layer Chamfer** — wir wollen echten Outer-Glow, deshalb Double-Layer.

## Phasen

### ✅ Phase 1: Scaffolding (fertig, noch nicht commited)
- `theme.css` um `--cockpit-*` Tokens erweitert
- `cockpit.css` angelegt (Grid, Banner, Stubs)
- `home.ts` neu geschrieben: Banner + Clock + 4 Stubs + Hero
- CSP für Google Fonts erweitert
- **TODO vor Commit:**
  - Palette auf saturierte Werte (`#00E5FF / #7C3AED / #FF2FD1`)
  - Font-Loading auf 3-Font-Stack: `<link rel="preconnect">` + `<link>` in `dashboard.html` / `dialog.html`, **nicht** `@import` in CSS
  - Alte Rajdhani-Referenz entfernen

### Phase 2: Chamfered Panel Component
- `sarah-panel` Web-Component mit Double-Layer Chamfer (Shadow DOM)
- **API-Spec:**
  - Attribute: `accent` (`cyan|violet|pink|mint`, default `cyan`), `title` (string), `state` (`idle|loading|error|stale`)
  - Slots: default (body), `title` (override), `actions` (top-right)
  - CSS Custom Properties von außen: `--panel-accent` (override), `--panel-min-height`
  - Element-Name: `sarah-panel` (kein Konflikt)
- **State-Rendering:**
  - `loading`: Skeleton / dezentes Puls-Pattern
  - `error`: roter Akzent + Fehlertext
  - `stale`: gedimmter Inhalt + Warn-Icon
  - Fallback-Wert bei fehlenden Daten: `--` (nicht `0`)
- Stubs durch echte Panels ersetzen

### Phase 3: Hero Zone
- Gradient-Placeholder (kein Orb)
- Optional: CSS-only Planet-Look (radial gradients + glow)

### Phase 4: System Load (live)
- CPU/GPU/RAM Ringe mit SVG `stroke-dasharray`
- Animated Stroke
- Inner Glow bei Last > 80%
- **Datenquelle v1:** Node `os.loadavg()` + `os.freemem()/totalmem()` — dependency-frei
- **Datenquelle v2 (Phase 6):** `systeminformation` für echte GPU-Load
- **IPC-Design:**
  - Neuer Channel `get-system-metrics` in `IpcCommands`
  - Push-Event `system:metrics` in `IpcEvents` (Main sendet via `webContents.send`)
  - Intervall: **1000 ms** (zentral im Main, kein Renderer-Interval)
  - Typ `SystemMetrics = { cpu: number; ram: number; gpu: number | null; ts: number }`
  - GPU-Fallback: `null` → Ring zeigt `--` statt 0
- **Validation:** Zod-Schema für `SystemMetrics`, serverseitig geprüft bevor geschickt

### Phase 5: Voice I/O Meter
- Waveform Bars (live animiert)
- In/Out Level-Anzeige
- **Event-Design:**
  - Neuer Push-Event `voice:level` in `IpcEvents`
  - Payload: `{ rms: number; bars: number[] }` — 16 Bars, normalisiert 0–1
  - RMS-Berechnung im Main-Prozess aus bestehenden PCM-Chunks
- **Rate-Limit:** max 30 Events/Sek (vermeidet Renderer-Überlastung)

### Phase 6: Polish
- Noise-Layer Overlay: **SVG filter / static PNG** (kein Canvas-rAF — zu teuer)
- Idle-Animationen (2–4s ambient loops)
- Hover-Glow auf Panels
- Real GPU-Stats via `systeminformation` (jetzt erst, wenn Phase 4 stabil)

## Design-Prinzipien

- **Max. 1–2 starke Glows pro Panel** (sonst billig-Sci-Fi)
- **Timings**: UI-Interactions 150–250ms, Ambient 2–4s
- **Icons**: Outline + Neon, 1.5px stroke (Lucide)
- **Glassmorphism sparsam** einsetzen

## Cross-Cutting (aus cockpit-lücken.md)

### Electron Security
- Dialog-Window in `ipc-config.ts` bereits ok: `contextIsolation: true`, `nodeIntegration: false`
- **Add:** `sandbox: true` in `webPreferences` (Main + Dialog)
- **Add:** `minWidth: 1024, minHeight: 640` in BrowserWindow-Options

### IPC Runtime-Validation
- `save-config` Bug: `config.set()` läuft **vor** `SarahConfigSchema.parse()` → ungültige Daten werden persistiert. Reihenfolge fixen: **erst parsen, dann setzen**.
- Für alle neuen Cockpit-IPC (Phase 4/5): Zod-Schema + `safeParse` vor State-Mutation / Event-Emit.

### Scheduler / Lifecycle
- Kein zweites Renderer-Interval für Metriken — Main pusht.
- Clock-Interval bleibt im Renderer (ist ok, hat Disconnect-Guard).
- Bei View-Unmount: `webContents.send`-Subscriptions explizit abbauen (via Dispose-Pattern).

### Testing
- Unit-Test für CPU/RAM-Prozent-Berechnung aus `os.*`
- Unit-Test für RMS-Berechnung aus PCM-Samples
- Kein E2E-Test nötig für reine Visualisierung
