# Claude-Audit: Noch offene Punkte

Stand: 2026-04-09

Diese Datei enthält nur noch Punkte, die im aktuellen Stand tatsächlich offen sind.

## Verifikation offen

### V1. Phase-3 Renderer-/IPC-Weg ist noch nicht separat automatisiert geprüft

- **Problem:** Die Service-Seite ist gut abgesichert, aber für die Dashboard-/IPC-Schicht fehlen weiterhin eigene Tests.
- **Offen sind konkret:**
  1. `chatModeToggle -> setInteractionMode`
  2. `voice:transcript -> Bubble-Rendering`
  3. kompletter Flow `saveConfig -> main.ts -> applyConfig()`
- **Beleg:** Im Testbaum existieren nur Service- und `AudioBridge`-Tests, aber keine dedizierten Dashboard-/Renderer-Tests.
- **Bewertung:** Test-Infrastruktur-Lücke, kein Funktionsfehler. Renderer-Tests erfordern DOM-/IPC-Mocking das aktuell nicht aufgesetzt ist.
