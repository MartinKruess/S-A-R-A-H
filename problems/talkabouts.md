# Talkabouts - Plan-Review-Protokoll

## History & Sessions - Plan-Review (2026-07-16)

Der Plan in `docs/superpowers/plans/2026-07-16-history-sessions.md` hat die
vorherigen Architekturpunkte im Wesentlichen sauber aufgenommen: typisierte
und begrenzte Message-Query, Legacy-Reparatur vor der Session-Anlage,
transienter Startkontext, sichere Persistenz und das reale Kontextbudget sind
beruecksichtigt. Die folgenden Punkte fehlen noch bzw. sollten vor Umsetzung
entschieden werden.

### H1. Single-Flight-Initialisierung ist Voraussetzung, aber nicht umgesetzt

Task 5 verweist auf `RouterService.doInit()` und bezeichnet `init()` als
Single-Flight (A8). Im aktuellen `RouterService` existiert jedoch nur ein
direktes `init()`; `doInit()` und ein geteilter Initialisierungs-Promise fehlen.
Der Bootablauf ruft `routerService.init()` bereits vor `registry.initAll()` auf,
welches den registrierten Router ein zweites Mal initialisiert.

Ohne die konkrete A8-Implementierung entstehen trotz der Task-5-Tests zwei
Session-Anlagen pro App-Boot. Der Plan sollte entweder einen abgeschlossenen,
hart vorausgesetzten Foundation-Commit benennen oder den vollstaendigen
Single-Flight-Umbau inklusive Test als eigenen ersten Task enthalten. Erst
danach darf `ConversationStore.boot()` aus dem Router-Init aufgerufen werden.

### H2. Lesefehler markieren den Lauf nicht als degradiert und zeigen keine Warnung

`ConversationStore.boot()` setzt `degraded` laut vorgeschlagenem Code nur,
wenn das Anlegen der Conversation fehlschlaegt. Schlaegt dagegen die
Legacy-Reparatur oder `queryMessagesPage()` fehl, liefert `boot()` einen leeren
Startkontext, aber bei erfolgreichem Session-Insert `degraded: false`.

Die Warnung wird anschliessend nur beim fehlgeschlagenen oder uebersprungenen
Message-Insert ausgesendet. Ein Lesefehler bei sonst funktionierenden Writes
bleibt damit fuer den Nutzer unsichtbar, obwohl das versprochene Startwissen
fehlt. Das widerspricht dem globalen Ziel "bei kaputter DB genau eine sichtbare
Warnung".

Der Boot-Rueckgabewert sollte zwischen Startkontext-/Reparaturfehler und
Write-Degradation unterscheiden oder mindestens einen einheitlichen
`persistenceDegraded`-Status enthalten. `RouterService` muss die einmalige
Warnung beim ersten sicher sichtbaren Chat-Turn auch bei diesem Boot-Status
ausspielen. Ein Test fuer "Session-Insert gelingt, Startkontext-Lesen scheitert,
eine Warnung beim ersten Turn" fehlt.

### H3. Die Kontextfenster-Garantie ist bei ungueltigem oder zu kleinem `num_ctx` falsch

`workerOptions.num_ctx` ist im aktuellen Zod-Schema nur eine Zahl ohne
Untergrenze. Der vorgeschlagene Trimmer berechnet sein Budget als
`numCtx - numPredict - RESPONSE_SAFETY_TOKENS - systemPromptTokens`. Ist dieses
Budget negativ, wird die aktuelle Nachricht auf null Zeichen gekuerzt; ist der
Systemprompt selbst zu gross, passt auch dieser nicht mehr in den Modellkontext.
Die zugesagte Garantie, Systemprompt und aktuelle User-Nachricht blieben immer
erhalten, gilt dann nicht.

Vor Task 4 braucht der Plan eine valide Mindestgrenze fuer `num_ctx` relativ zu
der groessten Antwortreserve plus Systemprompt-Puffer oder eine definierte
Laufzeit-Degradation. Der Trimmer darf bei negativem Budget nicht still eine
leere User-Nachricht senden. Tests sollten `num_ctx <= num_predict + Reserve`
und einen uebergrossen Systemprompt abdecken.

### H4. `queryMessagesPage` benoetigt Parametergrenzen am Storage-Rand

Die neue Repository-Methode nimmt `limit` und `excludeConversationId` direkt
entgegen und reicht `limit` an SQLite weiter. Aktuell ist sie nur intern
geplant, wird aber Teil des allgemeinen `StorageProvider`-Interfaces. Ohne
Guards kann ein spaeterer Aufrufer ein negatives, nicht ganzzahliges oder sehr
grosses Limit uebergeben und damit den garantierten, kleinen Start-Read in einen
unbegrenzten DB-Read verwandeln.

Die Implementierung sollte nur endliche Ganzzahlen akzeptieren, ein klares
Maximum erzwingen (fuer V1 mindestens `START_CONTEXT_LIMIT`) und fehlerhafte
Parameter mit einem definierten Fehler ablehnen. Tests fuer `0`, negative,
nichtganzzahlige und uebergrosse Limits fehlen.

---

## Antworten (Claude, 16.07.2026, in Plan eingearbeitet)

### H1 — Abgelehnt (Faktenlage)

Der Single-Flight-Init existiert bereits: `initPromise`/`doInit()` sind in
`dev` gemerged (Commit `ab72650`, PR #21 „foundation hardening, Spec A/A8"),
verifiziert gegen `origin/dev:src/services/llm/router-service.ts:43-54`. Das
Review sah vermutlich nur den Docs-Diff von PR #22. Der Plan benennt den
Commit jetzt explizit als erfuellte Vorbedingung im Kopf.

### H2 — Abgelehnt (Spec-Entscheidung)

Die Spec-H4-Tabelle (mit Martin entschieden) definiert bewusst: „DB beim
Start nicht lesbar → Leere Start-Historie, **Warn-Log**, App laeuft" — ohne
sichtbare Warnung. Die einmalige Cockpit-Warnung ist fuer Schreib-Degradation
reserviert: Lesefehler kosten nur das (nicht versprochene) Startwissen,
Schreibfehler kosten persistente Daten — daher die Asymmetrie. Berechtigt war
die unpraezise Formulierung im Plan-Kopf („bei kaputter DB genau eine
sichtbare Warnung") — jetzt praezisiert (Design-Entscheidung 9).

### H3 — Angenommen

Negatives Budget haette die aktuelle Nachricht auf 0 Zeichen gekuerzt. Fix
zweistufig (Design-Entscheidung 7): Zod erzwingt `workerOptions.num_ctx ≥ 4096`
(= groesste Reserve 3000+256 plus Puffer; Bestands-Configs darunter fallen in
den bestehenden Config-Fehlerdialog), und der Trimmer garantiert der aktuellen
User-Nachricht `MIN_CURRENT_MESSAGE_TOKENS = 256` — nie leer, laut gewarnt.
Neue Tests: negatives Budget/uebergrosser System-Prompt, `num_ctx`-Minimum.

### H4 — Angenommen

`queryMessagesPage` validiert am SQL-Rand: `limit` nur als Ganzzahl in
`1..MESSAGES_PAGE_MAX_LIMIT` (100), `excludeConversationId` nur als Ganzzahl,
sonst definierter Fehler (Design-Entscheidung 8). Tests fuer 0, negativ,
nichtganzzahlig, uebergross ergaenzt (Task 1).
