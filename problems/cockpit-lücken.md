# Cockpit Dashboard — Plan-Lücken & offene Fragen

**Analyse-Datum:** 2026-04-18  
**Referenz:** `cockpit-plan.md`  
Copilot: Lies CLAUDE.md. Neue Branch pro Thema: `feat/cockpit-metrics-ipc`, `feat/cockpit-panel-component` usw.

---

## 1. IPC für Live-Metriken fehlt vollständig (Phase 4)

### Problem
Der Plan sagt "Datenquelle: `systeminformation` via main-process IPC" — aber:
- `get-system-info` liefert **statische** OS-Infos (CPU-Modell, Kerne, RAM-Total gesamt)
- Es gibt **keine** IPC-Kanäle für Live-CPU-Last, GPU-Auslastung oder RAM-Verbrauch
- `systeminformation` ist **noch nicht in package.json** als Dependency

### Lücken im Detail

| Was fehlt | Wo | Konsequenz |
|---|---|---|
| `get-system-metrics` IPC-Channel | `ipc-contract.ts` → `IpcCommands` | Phase 4 nicht implementierbar |
| `system:metrics` Push-Event | `ipc-contract.ts` → `IpcEvents` | Kein Push-Modell definiert |
| `SystemMetrics`-Typ | `ipc-contract.ts` | SVG-Ringe wissen nicht was sie empfangen |
| `systeminformation` als npm-Dep | `package.json` | Paket fehlt |
| GPU-Stats auf Windows | Nirgends | `systeminformation` liefert GPU-Load für Nvidia/AMD nicht garantiert |

### Offene Entscheidungen
- **Push vs. Pull?** Interval-basiertes polling (`setInterval` im Renderer, `invoke` pro Tick) oder Main sendet proaktiv via `webContents.send`?
- **Intervall?** < 500 ms = der Fetch selbst erzeugt CPU-Last. > 5 s = Meter wirkt eingefroren. Empfehlung: **1000 ms**.
- **GPU-Fallback?** Wenn GPU-Load nicht verfügbar (z. B. integrierte Grafik), was zeigen die Ringe?

---

## 2. Voice-Waveform-Daten für Phase 5 nicht definiert

### Problem
Phase 5 sagt "Datenquelle: Voice-Service Events" — aber:
- `voice-audio-chunk` sendet `number[]` (rohe PCM-Samples, 16-bit LE) — kein Level-Meter-Payload
- Es gibt kein Event mit vorberechneten Pegel- oder FFT-Daten
- Waveform-Bars brauchen entweder RMS-Level oder einen Bucket-Array

### Lücken im Detail

| Was fehlt | Empfehlung |
|---|---|
| `voice:level`-Event mit `{ rms: number; bars: number[] }` | Main berechnet RMS aus Chunks vor dem Forwarding |
| Typ-Definition in `IpcEvents` | `'voice:level': { rms: number; bars: number[] }` |
| Spec: Anzahl Bars, Normalisierungsbereich | Im Plan festlegen (z. B. 16 Bars, 0–1) |

---

## 3. `sarah-panel` Web Component ohne API-Spec (Phase 2)

### Problem
Phase 2 nennt nur "Panel-Titel-Slot" und "Panel-Body-Slot" — keine vollständige Definition.

### Offene Punkte

| Frage | Optionen |
|---|---|
| Shadow DOM oder Light DOM? | Shadow = Isolation; Light = einfachere Style-Overrides |
| Attribute? | `accent="cyan"`, `title="CPU"`, `loading`, `error` |
| CSS Custom Properties von außen? | Welche `--cockpit-*`-Variablen sickern durch? |
| Custom Element Name | `sarah-panel` — kein Konflikt mit `sarah-svg` (bereits registriert) |
| Error-State / Loading-State | Im Plan **nicht erwähnt** (siehe Punkt 5) |

---

## 4. Kein Ladestate / Error-State für Panels definiert

### Problem
Der Plan beschreibt keine Zustände für die Panels außer dem Betriebszustand.

### Fehlende Zustände

| Zustand | Wann | Aktuell im Plan |
|---|---|---|
| Loading | Metriken-IPC noch nicht geantwortet | ❌ nicht definiert |
| Error | IPC-Call schlägt fehl / Service offline | ❌ nicht definiert |
| Stale | Voice-Service antwortet nicht mehr | ❌ nicht definiert |

Mindestanforderung: Panel zeigt `--` oder `?` statt 0, wenn keine Daten verfügbar.

---

## 5. Font-Loading-Strategie widersprüchlich

### Problem
- `cockpit.css` hat `@import url('https://fonts.googleapis.com/...')` für **Rajdhani** (veraltet)
- `dashboard.html` hat **keinen** `<link>`-Tag für Orbitron / Inter / JetBrains Mono
- Plan fordert Drei-Font-Stack, aber kein Laden dieser Fonts ist implementiert

### Konsequenz
Orbitron, Inter und JetBrains Mono werden nie geladen → Fallback auf System-Font.

### Offene Entscheidung
- `@import` in CSS = blockiert Rendering länger, schwerer cachen
- `<link rel="preconnect">` + `<link>` in HTML = besser (wie in `cockpit.md`-Referenz)
- **Offline-Verhalten?** Fonts werden nicht lokal gebundled → bei fehlendem Internet FOUC/Fallback-Font

---

## 6. Sicherheit: fehlende Laufzeit-Validierung in IPC-Handlern

### Problem
`save-config` in `ipc-config.ts` merged Renderer-Input direkt mit bestehender Konfig:

```ts
const merged = { ...existing, ...config };  // Zeile 53 — kein Zod-Check
```

TypeScript-Typen sind nur compile-time. Im Renderer könnten manipulierte Objekte über die IPC-Brücke geschickt werden.

### Empfehlung
- `SarahConfigSchema.safeParse(merged)` **vor** dem `config.set()`-Aufruf ausführen
- Gilt auch für künftige Cockpit-relevante Handlers (Phase 4/5)

---

## 7. Sicherheit: `contextIsolation` und `nodeIntegration` nicht im Plan erwähnt

### Problem
Der Plan diskutiert IPC-Architektur aber nennt keine Electron-Security-Baseline.

### Status-Check (zur Verifikation bei Impl.)

| Setting | Sollwert | Wo prüfen |
|---|---|---|
| `contextIsolation: true` | ✅ muss aktiv sein | `main.ts` → `webPreferences` |
| `nodeIntegration: false` | ✅ muss deaktiviert sein | `main.ts` → `webPreferences` |
| `sandbox: true` | empfohlen für Renderer | `main.ts` → `webPreferences` |

Diese Settings sind Voraussetzung dafür, dass der Preload-IPC-Ansatz sicher funktioniert.

---

## 8. Polling ohne zentrales Scheduling / Cleanup

### Problem
- Clock-Interval läuft bereits in `home.ts` (mit Disconnect-Guard ✅)
- Phase 4 würde weitere Intervals für Metriken-Polling hinzufügen
- Kein zentraler Scheduler / kein gemeinsamer Tick definiert

### Risiko
Mehrere unabhängige 1-Sekunden-Intervals pro View führen bei schnellen View-Wechseln (falls Navigation eingebaut wird) zu Memory-Leaks wenn Cleanup nicht konsistent implementiert wird.

### Empfehlung
- Einen `MetricsScheduler`-Service im Renderer definieren, der einen einzelnen Interval hält und Subscriber benachrichtigt
- Oder: Main pusht via `webContents.send` — kein Renderer-seitiger Interval nötig

---

## 9. Kein Mindest-Viewport / Resize-Verhalten definiert

### Problem
Das Grid nutzt `clamp(260px, 22vw, 320px)` — aber kein `min-width` für das Fenster ist definiert.

| Fensterbreite | Konsequenz |
|---|---|
| < ~800px | Spalten überlappen / Grid bricht zusammen |
| < ~500px | Layout komplett kaputt |

**Empfehlung:** `minWidth` und `minHeight` in `main.ts` → `BrowserWindow`-Optionen setzen (z. B. 1024 × 640).

---

## 10. Phase 6 "Film Grain" ohne Performance-Entscheidung

### Problem
"Noise-Layer Overlay (Film Grain)" ist im Plan genannt, aber:
- Canvas + `requestAnimationFrame` = dauerhaft laufende Render-Loop (CPU-intensiv)
- CSS `filter: url(#svg-noise)` oder `backdrop-filter` mit Static-PNG wäre performanter
- Kein Budget definiert (Budget-Empfehlung: < 1 ms/Frame für den Noise-Pass)

---

## 11. Kein Test-Konzept für Phasen 4 & 5

### Problem
Phasen 4 und 5 führen Daten-Pipelines ein (IPC → Transformation → SVG-Update).

### Was fehlt
- Unit-Test für die Metrik-Transformation (raw bytes → Prozentwert)
- Unit-Test für RMS-Level-Berechnung aus PCM-Samples
- Vorhandenes Test-Setup (`vitest.config.ts`) ist vorhanden — es fehlt nur ein Plan

---

## Priorität-Übersicht

| # | Thema | Priorität | Blockiert Phase |
|---|---|---|---|
| 1 | Live-Metriken IPC fehlt | 🔴 Hoch | 4 |
| 2 | Voice-Waveform-Event fehlt | 🔴 Hoch | 5 |
| 3 | Web Component API-Spec | 🟡 Mittel | 2 |
| 4 | Ladestate / Error-State | 🟡 Mittel | 2, 4, 5 |
| 5 | Font-Loading | 🟡 Mittel | 1 (TODO) |
| 6 | Laufzeit-Validierung IPC | 🔴 Hoch | 4, 5 |
| 7 | Electron Security Baseline | 🔴 Hoch | alle |
| 8 | Polling / Scheduling | 🟡 Mittel | 4, 5 |
| 9 | Mindest-Viewport | 🟢 Niedrig | alle |
| 10 | Film Grain Performance | 🟢 Niedrig | 6 |
| 11 | Test-Konzept | 🟡 Mittel | 4, 5 |
