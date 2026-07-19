# Medien-Konversationskontext (Design)

**Datum:** 2026-07-19
**Status:** Spec — Implementierung in eigener, frischer Session (Brainstorming zwischen Martin & Claude abgeschlossen, Design abgesegnet).
**Baut auf:** Schicht 1 Mediensteuerung (`media_*`, PR #28, `docs/superpowers/specs/2026-07-19-media-control-design.md`).

## Ziel

Knappe Folgebefehle sollen natürlich funktionieren. Nach einem Medienbefehl bleibt für ein kurzes Fenster ein Kontext „warm", sodass terse Äußerungen richtig gedeutet werden:

- „schalte ein Lied weiter" → dann Sekunden später nur **„weiter"** → `media_next` (nicht „Wiedergabe fortsetzen").
- „zurück" → `media_previous`.

**Kern-Einsicht:** „weiter" ist von Natur aus zweideutig — „mach weiter" = fortsetzen (`media_play`), „ein Lied weiter" = nächstes (`media_next`). Die **letzte Aktion/Richtung** löst die Zweideutigkeit auf. Wie beim Menschen: „weiter!" ohne frischen Kontext versteht niemand.

## Nicht-Ziele (V1 / YAGNI)

- **Kein** Repeat/„Dauerschleife", **keine** Playlist-Folgebefehle („mach mal ein zweiter") — das ist Schicht 2 (Spotify-Web-API), zieht später nach.
- **Kein** Mic-/Zuhör-Timer — schon gelöst (Keyword → 30-s-Fenster; PTT diskret). Dieses Feature ist **rein** Intent-Kontext.
- **Kein** Ziel-Gedächtnis nötig — die aktive Session (GSMTC) *ist* schon „was gerade läuft"; terse Befehle treffen dieselbe Session automatisch.
- **Kein** LLM im Auflösungspfad — die Kernworte werden **deterministisch** aufgelöst (das kleine 2B-Modell ist dafür zu unzuverlässig).

## Architektur

Ein neuer, deterministischer, in-memory Baustein `MediaContext`, der (a) den letzten Medienbefehl mitschreibt und (b) knappe Folgeworte innerhalb des Fensters auflöst. Er sitzt **vor jeglichem Routing** (2B-Router UND warmes 9B — siehe Hook-Placement unten, kritisch).

```
Transkript
   ↓
MediaContext.resolve(text, now)  ──►  trifft zu? → direkt media_*-Action emittieren (kein LLM)
   ↓ (null)
2B-Router (wie bisher)           ──►  bei media_*-Ausführung: MediaContext.record(action, now)
```

### Zustand

```ts
interface MediaContextState {
  lastAction: 'media_play' | 'media_pause' | 'media_toggle' | 'media_next' | 'media_previous';
  atMs: number; // Zeitpunkt der letzten Medien-Aktion
}
```

Gleitendes Fenster: `MEDIA_CONTEXT_WINDOW_MS = 12_000` (in Martins 10–15-s-Rahmen). Jede Medien-Aktion frischt `atMs` auf. `now - atMs > WINDOW` → Kontext **kalt** → `resolve` gibt `null` → normale Route.

### `record(action, nowMs)`

Setzt `lastAction` + `atMs`. **Keine Bus-Subscription nötig:** beide Wege, über die eine `media_*`-Action entsteht, laufen durch den `RouterService` — er ruft `record` direkt an der Stelle auf, an der er den `action:request` emittiert (sowohl bei Resolver-Treffer als auch beim normalen Router-Pfad). Es zählt das *Absetzen* des Befehls (Richtung/Kontext), nicht der Erfolg — also am Emit-Punkt, nicht am `action:result`.

### `resolve(text, nowMs): ResolvedMedia | null`

Gibt `{ action, speak }` zurück, wenn (a) das Fenster warm ist **und** (b) `text` (normalisiert) ein bekanntes terse Folgewort ist; sonst `null`.

## Auflösungs-Tabelle (Kern — bitte im Review prüfen)

Normalisierung: lowercase, NFC, getrimmt; nur „knappe" Äußerungen (≤ ~3 Wörter) werden überhaupt betrachtet, damit ganze Sätze normal geroutet werden.

| Terse-Äußerung (Beispiele) | Bedingung | Aufgelöste Action | Speak |
|---|---|---|---|
| „weiter", „und weiter", „noch eins", „nächstes" | `lastAction === media_pause` | `media_play` | „Läuft wieder." |
| „weiter", „und weiter", „noch eins", „nächstes" | sonst (Skip/Playing) | `media_next` | „Nächstes Lied." |
| „zurück", „eins zurück", „das vorherige" | — | `media_previous` | „Zurück." |
| „stop", „stopp", „halt", „pause" | — | `media_pause` | „Pausiert." |

**Begründung „weiter":** Nach einem **Pause** heißt „weiter" = *fortsetzen* (`media_play`). Nach einem **Skip** oder während der Wiedergabe heißt „weiter" = *nächstes* (`media_next`). Das ist der Kernnutzen des Kontexts.

Ist das Fenster **kalt** oder die Äußerung **kein** Terse-Wort → `null` → der Router entscheidet wie bisher (bare „weiter" bei kaltem Kontext bleibt `media_play`/resume, per bestehendem Prompt).

**`nochmal` bewusst NICHT in V1** (Review-Entscheidung): echtes Wiederholen ist Repeat = Schicht 2. `media_previous` startet je nach Player-State entweder den aktuellen Titel neu (< 3 s gespielt) oder springt zum vorherigen — also **nicht deterministisch** kontrollierbar. Weglassen ist die sichere Wahl; kommt mit Schicht 2 als echtes Repeat zurück.

## Hook in `RouterService` (verifiziert gegen den Code, 19.07.)

**Placement — kritisch.** Der Resolver muss in `runTurn()` **vor** dem `if (this.activeModel === '9b')`-Zweig laufen, NICHT in `routeAndRespond()`. Grund: im warmen 9B-Fenster geht ein terse Wort wie „weiter" (bewusst nicht in `ACTION_HINT_STEMS`) über den `else`-Zweig direkt in `runWorker()` — `routeAndRespond()` wird nie erreicht. Als allererster Schritt fängt der Resolver **beide** Modell-Zustände ab.

```ts
private async runTurn(text: string, mode: 'chat' | 'voice'): Promise<void> {
  await this.persistMessage('user', text);

  // MediaContext — vor jeglichem Routing (fängt aktives 2B UND warmes 9B ab)
  const hit = this.mediaContext.resolve(text, Date.now());
  if (hit) {
    const requestId = randomUUID();
    this.pendingActions.set(requestId, { action: hit.action });
    this.context.bus.emit(this.id, 'action:request', { requestId, action: hit.action, param: '' });
    this.mediaContext.record(hit.action, Date.now()); // Fenster auffrischen — auch im Shortcut-Pfad!
    await this.emitAssistantResponse(hit.speak);
    return;
  }

  try {
    if (this.activeModel === '9b') { /* … bestehende Gate-/Worker-Logik unverändert … */ }
    else { await this.routeAndRespond(text, mode); }
  } catch (err) { /* … unverändert … */ }
}
```

- **Kein Modell-Swap** im Resolver-Pfad: die `media_*`-Action läuft über den Action-Layer/GSMTC-Helper, unabhängig vom geladenen LLM — im warmen 9B einfach dort bleiben (spart den Swap). (Idle-Timer im V1 nicht anfassen — mögliche spätere Verfeinerung: bei aktivem 9B `resetIdleTimer()`, da der Nutzer aktiv ist.)
- **`record` auch im normalen Router-Pfad:** in `routeAndRespond()`, dort wo bereits ein `action:request` für ein `media_*`-Action emittiert wird (~Zeile 196–199), zusätzlich `this.mediaContext.record(action, Date.now())` aufrufen — nur für `media_*`-Actions. So frischt jeder Medienbefehl das Fenster auf, egal über welchen Pfad.
- **Speak optimistisch:** `hit.speak` wird — wie die Router-Feedbacks — vor der Ausführung gesprochen. Bei stillem Erfolg (`{ok:true}`) bleibt's dabei; bei Fehler folgt die ehrliche Ansage über `action:result` → `speakAfterCurrentTurn` (konsistent mit dem bestehenden Action-UX).

### Constructor — Breaking Change vermeiden

`RouterService` wird an 1 Produktionsstelle (`main.ts`) + **13+ Testdateien** mit **3** Argumenten instanziiert. `MediaContext` deshalb als **optionaler 4. Parameter mit Default** — alle bestehenden Tests bleiben ohne Änderung compilierbar:

```ts
constructor(
  private context: AppContext,
  private routerProvider: LlmProvider,
  workerProvider: LlmProvider,
  private mediaContext: MediaContext = new MediaContext(),
) { … }
```

`media-context.test.ts` testet `MediaContext` isoliert; `RouterService`-Tests, die das Zusammenspiel prüfen, injizieren eine Instanz mit vorbelegtem Zustand.

## Tests

`media-context.test.ts` (deterministisch, keine Zeit-Flakiness → `now` als Parameter):
- „weiter" nach `media_pause` (im Fenster) → `media_play`; nach `media_next` → `media_next`.
- „zurück" → `media_previous`; „stop" → `media_pause`.
- Fenster kalt (`now - atMs > 12 s`) → `null` (Passthrough).
- Ganzer Satz (> 3 Wörter, z. B. „erzähl mir mehr weiter unten") → `null`.
- `record` frischt das Fenster auf (Sequenz „next" → 10 s → „weiter" → 5 s → „weiter" skippt weiter).
- Unbekanntes Wort → `null`.

`router-service.test.ts` (Integration, der kritische Fall): bei `activeModel === '9b'` und warmem Kontext emittiert eine terse „weiter"-Nachricht ein `media_next`-`action:request` und ruft **nie** `runWorker` auf (Resolver vor dem 9B-Zweig). Gegenprobe: kalter Kontext + „weiter" bei aktivem 9B → geht in `runWorker` (kein Shortcut).

## Verifikation

- `npm run typecheck`, `npm test`, `npm run build` grün (Claude).
- Manuell (Martin, `npm start`): Musik läuft → „nächstes Lied" → kurz warten → „weiter" (soll skippen, nicht nur resumen) → „zurück" → „stop". Und: 20–30 s plaudern, dann „weiter" (Fenster kalt → soll *nicht* skippen). Auch im 9B-warmen Fenster (Gate holt zurück → Resolver greift davor).

## Doku-Nachzug

`problems/features.md`: „Feature: Medien-Konversationskontext" nach Merge auf umgesetzt schieben.
