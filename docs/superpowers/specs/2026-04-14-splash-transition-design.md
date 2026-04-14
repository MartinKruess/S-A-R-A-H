# Splash → SarahOrb Transition — Design Spec

## Überblick

Nach Abschluss aller Splash-Phasen wird das Fenster animiert von Splash-Größe (800x600, zentriert) auf Dashboard-Größe (`screenH * 0.3` x `screenH * 0.33`, Position oben-links 0,0) verkleinert und verschoben. Der Orb schaukelt dabei leicht seitlich wie bei einem Transport. Ein schwarzer Overlay verdeckt den Seitenwechsel zum SarahOrb-Screen.

## Phasen-Timeline (~2.1s gesamt)

| Phase | Zeitraum | Fenster | Orb |
|-------|----------|---------|-----|
| **shrink-start** | 0–300ms | Schrumpft (kein Move) | Wird leicht transparent, erstes Schaukeln beginnt |
| **shrink-move** | 300–1500ms | Schrumpft weiter + bewegt sich nach oben-links | Schaukelt seitlich (~0.5rem), leicht transparent |
| **fade-out** | 1200–1500ms | Letzte 300ms überlappend: schwarzer Overlay fadet ein | Schaukeln klingt aus |
| **swap** | ~1500ms | Schwarz, Seitenwechsel zu SarahOrb-Screen | — |
| **fade-in** | 1500–1800ms | Overlay fadet weg (~300ms) | Orb steht ruhig an seinem Platz |

## Technische Details

### Resize/Move (Main-Process)

- Gesteuert über `mainWindow.setBounds()` in einem `setInterval`/`requestAnimationFrame`-artigen Loop im Main-Process
- Start-Bounds: aktuelle Fenstergröße und -position (800x600, zentriert)
- Ziel-Bounds: `{ x: 0, y: 0, width: Math.round(screenH * 0.3), height: Math.round(screenH * 0.33) }`
- Easing: Ease-out cubic `1 - Math.pow(1 - p, 3)`
- Bewegung beginnt verzögert bei 300ms (shrink-start ist nur Größe)
- Gesamtdauer Resize+Move: 1500ms

### Orb-Schaukeln (Renderer)

- Horizontaler Offset via `orb.setOrbOffset(x, y, z)` — nur X-Achse
- Damped oscillation: `amplitude * Math.sin(freq * t) * Math.exp(-decay * t)`
- Amplitude: ~0.5rem äquivalent (normalisiert auf Orb-Einheiten)
- Beginnt bei shrink-start, klingt über die Dauer natürlich ab
- Orb-Transparenz: leicht reduziert während Transport (z.B. 0.8 opacity auf dem Container)

### Overlay (Renderer)

- Schwarzes `div` über dem gesamten Viewport, initial `opacity: 0`, `pointer-events: none`
- Fade-in bei ~1200ms über 300ms zu `opacity: 1`
- Nach Seitenwechsel: gleiches Overlay auf dashboard.html, startet bei `opacity: 1`, fadet auf 0

### IPC-Kommunikation

1. Splash-Renderer: `sarah.splashDone()` → Main empfängt `splash-done`
2. Main: Startet `setBounds`-Animation-Loop
3. Main: Sendet `transition-fade` an Renderer bei t=1200ms
4. Renderer: Fadet Overlay ein (300ms), sendet `fade-complete` an Main
5. Main: Lädt `dashboard.html`, wartet auf `did-finish-load`
6. Main: Sendet `transition-reveal` an Dashboard-Renderer
7. Dashboard-Renderer: Fadet Overlay von 1→0 weg (300ms)

### Preload-Erweiterungen

- `sarah.onTransitionFade(callback)` — Listener für fade-Trigger vom Main
- `sarah.fadeComplete()` — Signal zurück an Main dass Overlay schwarz ist
- `sarah.onTransitionReveal(callback)` — Listener für reveal-Trigger auf Dashboard-Seite

### Änderungen an bestehenden Dateien

- **`src/main.ts`**: `splash-done` Handler erweitern — statt direktem `loadFile` die Resize-Animation starten, dann IPC-Choreografie
- **`src/splash.ts`**: `done`-Phase bleibt `sarah.splashDone()`. Neuer Listener für `transition-fade` der Overlay + Schaukel-Logik startet
- **`splash.html`**: Schwarzes Overlay-`div` hinzufügen
- **`dashboard.html`**: Schwarzes Overlay-`div` hinzufügen (startet sichtbar)
- **`src/preload.ts`**: Neue IPC-Bridges für Transition-Events
- **`src/renderer/dashboard/dashboard.ts`**: Listener für `transition-reveal`, Overlay-Fade-out

## Abgrenzung

- Der Splash-Inhalt selbst (Phasen fade-in bis hold) wird hier NICHT verändert
- Diese Spec betrifft nur den Übergang NACH allen Splash-Phasen
- Die `hold`-Phase (aktuell 5000ms) bleibt bestehen — die Transition startet wenn `splashDone()` gefeuert wird
