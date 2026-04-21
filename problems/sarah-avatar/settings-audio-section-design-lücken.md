# Lücken-Analyse: settings-audio-section-design.md

**Datum:** 2026-04-21  
**Reviewer:** Copilot Kontrollplane  
**Status:** Plan umsetzbar — 3 Lücken, keine blockierenden Fehler

---

## Gesamtbewertung

Der Plan ist architektonisch korrekt. Alle referenzierten Interfaces (`AudioSchema`, `hud-select`, `audio-config-changed` IPC, `AudioBridge.applyAudioConfig`, `createSectionHeader`, `createSpacer`, `save`, `showSaved`, das `sections/`-Pattern) existieren tatsächlich und haben genau die im Plan beschriebenen Signaturen. Die Einschätzung "keine offenen Punkte" stimmt für den Kern — aber es gibt 3 Lücken, die beim Implementieren zum Stolpern führen können.

---

## Lücke 1 — Code-Snippet: `feedback` ist undefiniert (Compile-Fehler)

**Schwere:** Mittel — führt direkt zu einem TypeScript-Fehler

Der Datenfluss-Abschnitt zeigt den Change-Handler mit:

```ts
showSaved(feedback);
```

`feedback` wird im Code-Snippet nirgends definiert. `createSectionHeader('Audio')` gibt `{ header: HTMLElement; feedback: HTMLElement }` zurück (verifiziert in `settings-utils.ts`), aber die notwendige Destrukturierung

```ts
const { header, feedback } = createSectionHeader('Audio');
```

erscheint weder im Datenfluss-Block noch in einem anderen Code-Ausschnitt des Plans. Der UI-Abschnitt erwähnt `createSectionHeader` nur in Prosa.

**Konsequenz:** Ein Implementierer, der nur die Code-Snippets übernimmt, erhält einen Compile-Fehler (`Cannot find name 'feedback'`). Das Pattern ist zwar in anderen Sections (z. B. `controls-section.ts`) vorhanden, aber der Plan sollte es zeigen statt es vorauszusetzen.

---

## Lücke 2 — Timing: `hud-select` value-Set vor `connectedCallback`

**Schwere:** Mittel — potenziell stille Fehlfunktion bei erstem Öffnen

Der Datenfluss beschreibt:

```ts
const inputEl = document.createElement('hud-select');
section.appendChild(inputEl);
inputEl.value = audio.inputDeviceId ?? '';
```

Zum Zeitpunkt dieses Aufrufs ist `section` noch **nicht** im Live-DOM (der Plan-Mount passiert in `settings.ts` nach `return`). Damit hat `connectedCallback` von `HudSelect` noch nicht gefeuert, d. h. `enumerateDevices()` ist noch nicht gelaufen und die Options-Liste ist leer. Der value-Setter ruft `syncOptionSelection()` auf — aber ohne Optionen findet er nichts und setzt keinen visuellen Zustand.

**Kritische Frage:** Syncronisiert `HudSelect` den gesetzten Wert nach der Device-Enumeration automatisch nach? Wenn ja (z. B. durch erneuten `syncOptionSelection()`-Call am Ende von `connectedCallback`/`loadDevices()`), ist es kein Bug. Wenn nicht, zeigt der Picker beim ersten Öffnen immer "System-Standard", selbst wenn ein gespeichertes Gerät existiert.

Der Plan schweigt dazu vollständig. Das sollte explizit verifiziert und dokumentiert werden, idealerweise durch Blick auf `HudSelect.connectedCallback`/`loadDevices` im Quellcode.

---

## Lücke 3 — Falsche Prämisse: hud-select-Tests aus Phase 3

**Schwere:** Gering — irreführende Aussage, kein funktionaler Fehler

Der Plan behauptet:

> `hud-select` hat bereits Tests aus Phase 3

Tatsächlich decken die Tests in `src/renderer/components/hud-select.test.ts` nur `toDeviceOptions` (eine pure Funktion in `hud-select-options.ts`) ab. Die `HudSelect`-Klasse selbst hat **keine** DOM-Tests (kein `connectedCallback`, kein `value`-Setter, kein `change`-Event-Test).

Das ist relevant für den Satz "Unit: keine neuen" — das stimmt zwar für die neue `audio-section.ts`, aber die Prämisse "hud-select ist bereits abgedeckt" suggeriert falsches Vertrauen in die Komponentenreifegrad. Zusammen mit Lücke 2 (Timing-Frage) fehlt hier ein einfacher manueller Smoke-Test für den value-pre-init-Pfad.

---

## Bestätigte Korrektheit (kein Handlungsbedarf)

| Aussage im Plan | Befund |
|---|---|
| `hud-select` ist in dashboard registriert | ✅ `registerComponents()` in `dashboard.ts` registriert `hud-select` — kein Extra-Import in `audio-section.ts` nötig |
| `save('audio', audio)` ruft `saveConfig({ audio })` | ✅ Exakt so in `settings-utils.ts` implementiert |
| Main feuert `audio-config-changed` → `AudioBridge.applyAudioConfig` | ✅ Vollständig verdrahtet in `ipc-config.ts` und `audio-bridge.ts` |
| Section-Mount-Punkt (zwischen Controls und Wizard-Button) | ✅ `settings.ts` hat Controls als letzten append vor dem Wizard-Block |
| `value \|\| undefined` hält Schema sauber | ✅ Korrekt, `AudioSchema` hat beide Device-IDs als `optional()` |
| Keine Live-Sync-Subscription nötig | ✅ Korrekt — frischer `getConfig()`-Call beim View-Mount ist ausreichend |
| `sections/`-Pattern existiert | ✅ 5 bestehende Section-Files vorhanden, Muster klar |
