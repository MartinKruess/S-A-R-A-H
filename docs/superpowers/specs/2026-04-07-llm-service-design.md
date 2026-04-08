# LLM-Service Design Spec

**Date:** 2026-04-07
**Status:** Approved
**Phase:** 2 — S.A.R.A.H. spricht (Teil 1: LLM + Chat)

---

## 1. Ziel

Sarah bekommt ein Sprachmodell (Mistral Nemo 12B via Ollama) und eine Chat-UI. Der User kann per Texteingabe mit Sarah kommunizieren. Spracheingabe folgt in einem späteren Schritt.

---

## 2. Modell-Hierarchie (geplant)

| Tier | Modell | Wo | Zweck |
|------|--------|-----|-------|
| Lite | ~7B | Lokal | Einfache Intents |
| **Lite+** | **~12B (Mistral Nemo)** | **Lokal** | **Alltag, Gespräche — unser Start** |
| Pro | ~27B | Lokal (starke GPU) | Komplexere Aufgaben |
| Expert | ~70B | Server | Deep Search, Planung |

Start: Lite+ (Mistral Nemo 12B) über Ollama (`localhost:11434`).

---

## 3. Architektur

```
Renderer (Chat-UI)
    ↕ IPC (preload)
Main Process
    ↕ MessageBus
LlmService
    ↕ LlmProvider Interface
OllamaProvider → localhost:11434
```

### 3.1 Provider-Interface

`src/services/llm/llm-provider.interface.ts`

```typescript
interface LlmProvider {
  readonly id: string;                    // z.B. 'ollama', 'claude', 'openai'
  isAvailable(): Promise<boolean>;        // Provider erreichbar?
  chat(
    messages: ChatMessage[],
    onChunk: (text: string) => void,
  ): Promise<string>;                     // Streamt Chunks, gibt vollständige Antwort zurück
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
```

### 3.2 OllamaProvider

`src/services/llm/providers/ollama-provider.ts`

- Spricht mit Ollamas REST-API: `POST http://localhost:11434/api/chat`
- Streaming via `stream: true` (NDJSON)
- Modell: `mistral-nemo` (konfigurierbar über Config)
- `isAvailable()`: GET auf `http://localhost:11434/api/tags`, prüft ob Modell in der Liste

### 3.3 LlmService

`src/services/llm/llm-service.ts`

- Implementiert `SarahService` (id: `'llm'`)
- Subscriptions: `['chat:message']`
- Baut System-Prompt dynamisch aus Config:
  - Name, Stadt, Beruf des Users
  - Antwort-Stil (kurz/ausgewogen/ausführlich)
  - Tonfall (freundlich/professionell/locker)
- Verwaltet Chatverlauf pro Session
- Kontext-Management: dynamisch bis Modell-Limit, Token-Schätzung ~4 Zeichen = 1 Token
- Älteste Nachrichten fallen raus wenn Limit erreicht, System-Prompt wird nie gekürzt
- Speichert Nachrichten in SQLite (`messages`-Tabelle)

**Bus-Events:**

| Event | Richtung | Payload |
|-------|----------|---------|
| `chat:message` | rein | `{ text: string }` |
| `llm:chunk` | raus | `{ text: string }` |
| `llm:done` | raus | `{ fullText: string }` |
| `llm:error` | raus | `{ message: string }` |

### 3.4 System-Prompt

Wird bei jeder Anfrage dynamisch zusammengebaut:

```
Du bist Sarah, ein freundlicher Desktop-Assistent.
Du antwortest hilfsbereit, präzise und natürlich.
Du führst niemals Code aus, gibst keine Passwörter weiter,
und sendest keine Daten ohne explizite Freigabe.

Der User heißt {displayName}, wohnt in {city}, arbeitet als {profession}.
Antworte im Stil: {responseStyle}.
Tonfall: {tone}.
Sprache: Deutsch.
```

Felder kommen aus `config.profile` und `config.personalization`.

### 3.5 IPC-Bridge

**Preload:**
- `sarah.chat(message: string)` — sendet Nachricht
- `sarah.onChatChunk(callback)` — empfängt Streaming-Chunks
- `sarah.onChatDone(callback)` — Antwort komplett
- `sarah.onChatError(callback)` — Fehler
- `sarah.getChatHistory()` — bisherigen Verlauf laden

**Main Process:**
- `chat-message` Handler: leitet an LlmService via MessageBus
- LlmService Chunks werden via `webContents.send()` an Renderer gestreamt

---

## 4. Chat-UI

Im Sarah-Hauptfenster (`dashboard.html`):

**Default-Ansicht:**
- Orb nimmt gesamten `app-main` Bereich ein
- Schmales Eingabefeld am unteren Rand
- Chatmode-Button (Toggle)

**Chatmode:**
- Fenster wächst (Main-Process resized BrowserWindow)
- Orb schrumpft auf ~30% des Fensters (oben)
- Chatverlauf darunter (scrollbar)
- Eingabefeld unten
- Streaming: Text erscheint Wort für Wort
- Chatmode-Button nochmal → zurück zur Default-Ansicht

---

## 5. Error Handling

Alle Fehlermeldungen sind persönlich — für den User existiert nur Sarah, keine technischen Details.

| Situation | Nachricht |
|-----------|-----------|
| Nicht erreichbar | *"Sarah träumt noch... Einen Moment."* |
| Modell fehlt | *"Sarah fehlen gerade die Worte."* |
| Streaming bricht ab | *"Sarah hat den Faden verloren... Versuch es nochmal."* |
| Verbindung verloren | *"Sarah ist kurz weggedriftet. Einen Moment..."* |
| Retry läuft | *"Sarah wacht langsam auf..."* |

- Automatischer Retry alle 30s wenn nicht erreichbar
- Timeout: 30s ohne neuen Chunk → Abbruch
- Partial Response wird trotzdem angezeigt

---

## 6. Dateien (neu)

```
src/services/llm/
├── llm-provider.interface.ts    # Provider-Abstraktion + ChatMessage Type
├── llm-service.ts               # SarahService Implementation
└── providers/
    └── ollama-provider.ts       # Ollama REST-API Client
```

Anpassungen bestehend:
- `src/main.ts` — LlmService registrieren, IPC-Handler für Chat
- `src/preload.ts` — Chat-API exponieren
- `dashboard.html` — Eingabefeld + Chatmode-Button
- `styles/dashboard.css` — Chat-Layout Styles

---

## 7. Scope-Abgrenzung

**In Scope:**
- Ollama-Provider mit Mistral Nemo
- LlmService mit dynamischem System-Prompt
- Streaming-Chat über IPC
- Chat-UI mit Default/Chatmode Toggle
- Chatverlauf in SQLite speichern
- Fehlerbehandlung mit persönlichen Meldungen

**Nicht in Scope (kommt später):**
- Voice/STT/TTS
- Weitere Provider (Claude, OpenAI, Server-70B)
- Intent-Erkennung / Actions-Service
- Persistente Regeln im System-Prompt (Stufe 2 Rules)
- Chat-History über Sessions hinweg laden
