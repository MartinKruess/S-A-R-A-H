# Füllsätze (Überbrückungssätze) — Design V1

**Branch:** `feat/filler-phrases` · **Stand:** 2026-07-18

## Problem

Beim Wechsel zwischen Router (2B) und Worker (9B) muss ein Modell geladen/entladen werden (VRAM reicht nicht für beide). Diese Swap-Pause ist im Sprachmodus **stille Totzeit** — der Nutzer hört nichts, bis die eigentliche Antwort/Ansage kommt. Live beobachtet: „Lass uns etwas planen" → mehrere Sekunden Stille → dann die 9B-Antwort.

## Ziel V1

Die Swap-Pause mit **einem** kurzen, gesprochenen Brückensatz aus einem statischen Pool überbrücken — an den **technischen Zustand** gekoppelt, nicht ans Thema. Danach folgt die echte Antwort/Ansage.

Vorlage: `problems/talkabouts.md`, Abschnitte 11–14 (Pools pro Zustand, `getFeedback` mit Historie, Timing-Regel).

## Scope

**In V1 (gebaut & verkabelt):**
- Modul `filler-phrases.ts` mit der `feedbackTexts`-Struktur (alle Kategorien aus dem Doc definiert, damit spätere Zustände reinpassen) + `getFeedback(category)` mit Anti-Wiederholungs-Historie.
- Verkabelt werden **nur die zwei Modell-Swaps** (beide Richtungen), ausschließlich im **Sprachmodus**:
  - **2B→9B** (`routeAndRespond`, Route zum Worker) → Kategorie **`frontendThinking`** („Lass mich das kurz durchdenken.").
  - **9B→2B** (`runTurn`-Gate, Gerätebefehl während 9B aktiv) → Kategorie **`switchingBack`** (kurz/neutral, z. B. „Einen Moment.", „Sofort.") — zum Swap-Start steht das Routing-Ziel noch nicht fest, und danach kommt meist die Action-Ansage.
- **Ein globaler Pool** (nicht pro Persönlichkeit).

**Nicht in V1 (bewusst):**
- Kategorien für Backend/Hintergrundaufgaben/Deep-Search/Queue (`backgroundAccepted`, `backendBusy`, `taskCompleted`, `programLoading/Ready`, Ressourcenkonflikt) — das zugehörige System existiert noch nicht. Die Texte werden im Modul **definiert**, aber **nicht ausgelöst**.
- Füllsätze für `self`/`action`-Routen ohne Swap — die sprechen bereits ihren Router-Feedback-Satz („Ich öffne Spotify"), kein Doppeln.
- Chat-Modus-Füller (dort bleibt der visuelle Routing-Hinweis).
- Pro-Persönlichkeit-Pools, Fortschrittsmeldungen, Status-auf-Nachfrage.

## Architektur

### Modul `src/services/llm/filler-phrases.ts`
- `feedbackTexts: Record<FillerCategory, string[]>` — die Pools (Vorlage `features.md`, ehem. talkabouts Abschnitt 12). **`switchingBack` ist dort nicht definiert und wird hier ergänzt** (Review-Befund 1):
  ```ts
  switchingBack: ['Einen Moment.', 'Sofort.', 'Mach ich gleich.'],
  ```
  Die 2B→9B-Verkabelung nutzt `frontendThinking`, die 9B→2B-Verkabelung `switchingBack`.
- `getFeedback(category, historySize = 4): string` — wählt zufällig, meidet die letzten `historySize` Ausgaben pro Kategorie (Vorlage Abschnitt 13); Fallback `'Einen Moment bitte.'` bei leerem Pool. **Modulinterne Funktion mit History-State (nicht pure)** → isoliert unit-testbar via gestubbtem RNG (Review-Befund 3).

### Verkabelung in `router-service.ts`
An den zwei `vramManager.swapModels(...)`-Stellen wird — **nur wenn `mode === 'voice'`** — direkt beim Swap-Start ein Füllsatz gesprochen (`frontendThinking` bzw. `switchingBack`), **bevor** der Swap awaited wird, damit die TTS-Synthese die Ladezeit füllt. Die echte Antwort/Ansage folgt danach über den bestehenden Pfad.

### Emit-Mechanismus (entschieden: Option B, Review-Befund 2)
`emitAssistantResponse` scheidet aus — es macht immer `history.push` + `persistMessage` (verifiziert Zeile 253-261). Stattdessen ein **dediziertes Bus-Event `llm:filler` `{ text }`**:
- **`router-service`** emittiert es per `bus.emit` beim Swap-Start (nur `mode === 'voice'`). Kein `history.push`, kein `persistMessage`, **kein `llm:done`** (der Füller beendet den Turn nicht — das macht weiter `runWorker`s eigenes `llm:done`, Zeile 237).
- **`voice-service`** abonniert `llm:filler` und hängt den Text direkt in die `ttsQueue` (nur Sprache).
- **Dashboard ignoriert `llm:filler`** → **keine Chat-Bubble** (der Füller ist Überbrückung, kein Turn-Inhalt; eine nicht-persistierte Bubble wäre beim Reload inkonsistent).

**Ordering (Review-Befund 4):** Turns sind serialisiert (`turnInFlight` in `dispatch`), es läuft also **nie** ein Worker-Stream parallel, wenn ein Füller emittiert wird. Der Füller wird vor `await swapModels(...)` emittiert, die Worker-Chunks erst nach dem Swap → der Füller landet garantiert **vor** der Antwort in der `ttsQueue`. Kein Rückgriff auf die `outputQueue` nötig.

### Gate / Timing
- Füller feuert **nur bei echtem Swap** — nicht wenn 9B schon warm ist und weiter im Worker geantwortet wird (kein Swap = keine Pause). Das erfüllt automatisch die „unter 2 s keine Meldung"-Regel (ein Swap dauert immer länger).
- **Nur Sprachmodus.**

## Nicht-Ziele / Risiken
- Bei 9B→2B kann direkt nach `switchingBack` die Action-Ansage kommen („Einen Moment." → „Ich öffne Spotify.") — gewollt, natürlicher Fluss.
- Seltener Edge-Case: ein vermeintlicher Gerätebefehl routet nach dem 9B→2B-Swap doch wieder zum Worker (2B→9B) → theoretisch zwei Füller. Für V1 akzeptiert.

## Tests
- Unit `filler-phrases.test.ts`: Anti-Wiederholung (keine Ausgabe aus den letzten `historySize`), Fallback bei leerem Pool, Single-Item-Pool, deterministisch via gestubbtem RNG.
- `router-service`-Test: Swap im Sprachmodus → ein Füller der richtigen Kategorie wird gesprochen; **kein** Füller im Chat-Modus; **kein** Füller wenn 9B warm bleibt (kein Swap); Füller landet **nicht** in der persistierten Historie.
