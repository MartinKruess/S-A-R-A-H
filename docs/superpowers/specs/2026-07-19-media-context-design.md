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

Ein neuer, deterministischer, in-memory Baustein `MediaContext`, der (a) den letzten Medienbefehl mitschreibt und (b) knappe Folgeworte innerhalb des Fensters auflöst. Er sitzt **vor** dem 2B-Router.

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
| „nochmal", „nochmal von vorn" | — | `media_previous` | „Nochmal von vorn." |
| „stop", „stopp", „halt", „pause" | — | `media_pause` | „Pausiert." |

**Begründung „weiter":** Nach einem **Pause** heißt „weiter" = *fortsetzen* (`media_play`). Nach einem **Skip** oder während der Wiedergabe heißt „weiter" = *nächstes* (`media_next`). Das ist der Kernnutzen des Kontexts.

Ist das Fenster **kalt** oder die Äußerung **kein** Terse-Wort → `null` → der Router entscheidet wie bisher (bare „weiter" bei kaltem Kontext bleibt `media_play`/resume, per bestehendem Prompt).

`nochmal` → `media_previous` ist ein Kompromiss (echtes Wiederholen ist Repeat = Schicht 2); ein einzelnes `media_previous` startet bei den meisten Playern den aktuellen Titel neu. Kann in V1 auch weggelassen werden — Review-Entscheidung.

## Hook in `RouterService`

- **Vor** dem Aufruf des 2B-Routers: `const hit = mediaContext.resolve(transcript, Date.now());` — bei Treffer den `action:request` direkt emittieren (mit der Speak-Bestätigung aus der Tabelle) und **den Router überspringen**.
- **Nach** jeder `media_*`-Ausführung: `mediaContext.record(action, Date.now())`.
- `MediaContext` ist ein Plain-Objekt/kleine Klasse (kein Registry-Service nötig), injizierbar in `RouterService` für Tests — analog wie andere Deps dort.

## Tests

`media-context.test.ts` (deterministisch, keine Zeit-Flakiness → `now` als Parameter):
- „weiter" nach `media_pause` (im Fenster) → `media_play`; nach `media_next` → `media_next`.
- „zurück" → `media_previous`; „stop" → `media_pause`.
- Fenster kalt (`now - atMs > 12 s`) → `null` (Passthrough).
- Ganzer Satz (> 3 Wörter, z. B. „erzähl mir mehr weiter unten") → `null`.
- `record` frischt das Fenster auf (Sequenz „next" → 10 s → „weiter" → 5 s → „weiter" skippt weiter).
- Unbekanntes Wort → `null`.

## Verifikation

- `npm run typecheck`, `npm test`, `npm run build` grün (Claude).
- Manuell (Martin, `npm start`): Musik läuft → „nächstes Lied" → kurz warten → „weiter" (soll skippen, nicht nur resumen) → „zurück" → „stop". Und: 20–30 s plaudern, dann „weiter" (Fenster kalt → soll *nicht* skippen). Auch im 9B-warmen Fenster (Gate holt zurück → Resolver greift davor).

## Doku-Nachzug

`problems/features.md`: „Feature: Medien-Konversationskontext" nach Merge auf umgesetzt schieben.
