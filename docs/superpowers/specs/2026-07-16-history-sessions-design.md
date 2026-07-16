# History & Sessions — Design (Spec B)

**Datum:** 2026-07-16
**Status:** Entwurf, wartet auf Review
**Quelle:** `docs/analyze-fabel.md` 3.3, 3.4, 5.2 + Kontextbudget-Fund

Ziel: Sarahs Amnesie beheben. Heute speichert sie jede Nachricht in SQLite (`conversation_id: 1`, hartcodiert), liest aber beim Start nie etwas zurück — nach jedem Neustart ist der Kontext weg.

## Entschieden (mit Martin, 16.07.2026)

1. **Startwissen:** Beim App-Start werden die **letzten 20 Nachrichten** in die Historie geladen — über Session-Grenzen hinweg (sonst greift der Mechanismus ins Leere, wenn die direkt vorherige Session leer blieb).
2. **Session-Modell:** **Pro App-Start eine Session** (neue `conversation_id` je Lauf).
3. **Aufbewahrung: unbegrenzt.** Nichts wird gelöscht — die DB ist verschlüsselt und lokal; künftige Gedächtnis-Features brauchen genau diese Daten.

## Nicht-Ziele (V2+, bewusst raus)

- **Startwissen-Setting** (20 / 50 / komplette letzte Session zusammengefasst) — kommt später als Settings-Option, V1 ist fest 20.
- **Langzeit-Gedächtnis / Lernen über Sessions hinweg** („Sarah kennt meine vier Projekte inhaltlich, auch über Wochen") — das ist ein eigenes, großes Feature (separater Wissens-Speicher neben der Chat-Historie, Größe unbegrenzt ok, vermutlich Abruf per Suche/Embeddings). Kriegt eine **eigene Spec**, wenn es dran ist. Diese Spec legt nur das Fundament: saubere Sessions + nichts löschen.
- **Smarte Kontext-Zusammenfassung** bei langen Sessions (analyze-fabel 5.4) — V1 trimmt weiterhin hart, nur mit korrektem Budget (siehe unten).

## Design

### 1. Sessions-Schema

Neue Tabelle `conversations`:

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`messages.conversation_id` referenziert sie logisch (kein FK-Zwang nötig, SQLite-pragmatisch). **Migration:** Beim ersten Start mit neuem Code wird, falls `conversations` leer ist aber `messages` Einträge mit `conversation_id = 1` hat, eine Legacy-Zeile `id = 1` angelegt. Idempotent, kein Datenverlust.

### 2. Boot-Ablauf

1. `RouterService.init()` (bzw. ein kleiner `ConversationStore` in `src/core/storage/`, den der RouterService nutzt — Eigentum an Historie bleibt beim RouterService):
   - neue `conversations`-Zeile anlegen → `this.conversationId`
   - letzte 20 Nachrichten mit `conversation_id != this.conversationId` laden (`ORDER BY id DESC LIMIT 20`, dann umdrehen) → als Anfangs-`history`
2. Alle bisherigen `conversation_id: 1`-Hardcodes (`router-service.ts:79,106,141` — Zeilen verifiziert der Plan) nutzen `this.conversationId`.
3. Damit das Modell alte von neuen Nachrichten unterscheiden kann, wird der geladene Block beim Prompt-Bau mit einer einzelnen System-Zeile eingeleitet („Auszug aus der letzten Unterhaltung vom {Datum}:") — keine Vermischung mit der Live-Konversation in der DB, das ist reine Prompt-Darstellung.

### 3. Kontextbudget-Fix (der stille Bug)

`MAX_CONTEXT_TOKENS = 120_000` im RouterService-Trimmer — aber der Worker läuft mit `num_ctx 4096`. Der Trimmer erlaubt also ~30× mehr, als das Modell sieht; Ollama schneidet still ab (und zwar **vorne**, wo der System-Prompt steht — potenziell verliert Sarah ihre Instruktionen, nicht die älteste Nachricht!).

Fix:

- `num_ctx` wird **eine** Wahrheit: aus der LLM-Config gelesen (wo es heute für den Provider gesetzt wird — der Plan verifiziert den Ort) und an den Trimmer gereicht.
- Trimm-Budget = `num_ctx − Antwort-Reserve (1024 Tokens) − System-Prompt-Schätzung`. Die bestehende `estimateTokens`-Heuristik (4 Zeichen/Token) bleibt; sie ist für Deutsch konservativ genug, solange die Antwort-Reserve steht.
- Damit ist garantiert: System-Prompt überlebt immer, getrimmt wird älteste Historie zuerst — auch mit den 20 geladenen Startnachrichten.

### 4. Fehlerfälle

| Fall | Verhalten |
|---|---|
| DB beim Laden nicht lesbar | Leere Start-Historie, Warn-Log, App läuft normal (Amnesie wie bisher, aber kein Crash) |
| Vorherige Session leer/nicht vorhanden (Erststart) | Leere Start-Historie, kein Sonderfall nach außen |
| Migration trifft unerwartete Daten | Nichts löschen, Warn-Log, Legacy-Zeile trotzdem anlegen |

## Tests

- ConversationStore: neue Session je Init, letzte-20-Query (Reihenfolge!), Erststart, Legacy-Migration idempotent
- Trimmer: Budget aus num_ctx; System-Prompt überlebt bei Überfüllung; 20 Startnachrichten + lange Live-Session → älteste fliegen zuerst
- RouterService: `conversationId` statt `1` in allen drei Insert-Pfaden
- Manuell (Martin): Unterhaltung führen → App neu starten → „Worüber haben wir gerade gesprochen?" muss sinnvoll beantwortet werden

## Reihenfolge

Eigener Branch `feat/history-sessions`, nach Spec A und **vor** dem Action-Layer (der Action-Layer schreibt über `emitAssistantResponse` in dieselbe Historie — sauberer, wenn Sessions dann schon stehen).
