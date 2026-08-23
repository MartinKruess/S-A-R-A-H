# Talkabouts — Review-Scratch

> Flüchtige Arbeitsdatei: wird bei jedem Review/jeder Diskussion überschrieben.
>
> **Dauerhafte Bugs, Ideen und offene Plan-Punkte stehen in [`features.md`](./features.md).**

---

## Review: `2026-07-19-media-context-design.md`

**Stand:** 2026-07-19 (2. Durchgang — tiefere Code-Analyse)

> Schicht 1 (`media_*`-Actions, `media-controller.ts`, Routing-Prompt, `action-schemas.ts`, Wiring in `main.ts`) ist **vollständig implementiert** und in Produktion. Die Spec beschreibt den Kontext-Layer darüber.

---

### 🔴 Hook-Placement schlägt im 9B-Fenster fehl

**Spec:** „Vor dem Aufruf des 2B-Routers" → impliziert Platzierung in `routeAndRespond()`.

**Problem:** `routeAndRespond()` wird in `runTurn()` nur aufgerufen wenn `activeModel === '2b'` ODER der Gate-Check positiv ist (`looksLikeActionCommand`). Terse Wörter wie `„weiter"`, `„zurück"`, `„stopp"` sind **bewusst nicht** in `ACTION_HINT_STEMS` — kein Gate-Treffer. Im warmen 9B-Fenster gehen sie direkt in `runWorker()`, `routeAndRespond()` wird nie erreicht, Resolver feuert nie.

Das Architektur-Diagramm der Spec zeigt den Resolver als **allerersten Schritt vor jeglichem Routing** — die Prosa weicht davon ab.

**Fix:** Hook in `runTurn()` **vor** dem `if (this.activeModel === '9b')`-Block. Shortcut-Pfad sieht dann vollständig so aus:

```ts
private async runTurn(text: string, mode: 'chat' | 'voice'): Promise<void> {
  await this.persistMessage('user', text);

  const hit = this.mediaContext.resolve(text, Date.now());
  if (hit) {
    const requestId = randomUUID();
    this.pendingActions.set(requestId, { action: hit.action });
    this.context.bus.emit(this.id, 'action:request', { requestId, action: hit.action, param: '' });
    this.mediaContext.record(hit.action, Date.now());
    await this.emitAssistantResponse(hit.speak);
    return;
  }

  // ... bestehende 9b/2b-Logik
```

---

### 🟡 Constructor: optionaler 4. Parameter, sonst 13 Tests kaputt

`new RouterService(ctx, routerP, workerP)` steht in **13 Testdateien** (`router-service.test.ts`, `router-service-mock.test.ts`, alle Plan-Docs). Ein Pflicht-Parameter `mediaContext` bricht alles auf einmal. Lösung: Default-Instanz:

```ts
constructor(
  private context: AppContext,
  private routerProvider: LlmProvider,
  workerProvider: LlmProvider,
  private mediaContext: MediaContext = new MediaContext(),
)
```

Alle bestehenden Tests bleiben unverändert compilierbar. `media-context.test.ts` injiziert explizit. Die Spec erwähnt Injection, aber keine Strategie — hier ist die einzig nicht-brechende.

---

### 🟡 `record` fehlt in beiden Pfaden der Spec-Beschreibung

**Shortcut-Pfad:** Die Spec beschreibt `record` nur für den normalen Router-Pfad. Im Shortcut-Pfad muss `record` ebenfalls aufgerufen werden — sonst frischt ein `„weiter"→next`-Shortcut das Fenster nicht auf; die nächste Äußerung 5 s später sieht einen kalten Kontext. (Fix-Code oben enthält `record` bereits.)

**Guard im Router-Pfad:** In `routeAndRespond()` wird `action:request` für **alle** Actions emittiert. `record` muss auf `media_*` eingeschränkt werden — sonst überschreibt z. B. `set_volume` die `lastAction`. Die Spec sagt „nach jeder `media_*`-Ausführung" — die explizite Guard-Bedingung fehlt im Prosa-Abschnitt „Hook in RouterService":

```ts
this.context.bus.emit(this.id, 'action:request', { requestId, action, param });
if (action.startsWith('media_')) this.mediaContext.record(action, Date.now()); // ← Guard nötig
await this.emitAssistantResponse(feedback);
```

---

### 🟡 `MediaAction`-Typ bereits vorhanden — nutzen

`media-controller.ts` exportiert bereits:
```ts
export type MediaAction = 'media_play' | 'media_pause' | 'media_toggle' | 'media_next' | 'media_previous';
```

`ResolvedMedia.action` sollte als `MediaAction` getypt sein (nicht `string`), dann ist `isActionName`-Check im Shortcut überflüssig und der Compiler verhindert Tippfehler. Spec erwähnt den Typ nicht.

---

### 🟡 Test-Lücke: Kein RouterService-Integrationstest

Die Spec-Testliste beschreibt nur `media-context.test.ts` (isolierte Unit-Tests). Es fehlt ein `RouterService`-Test der den Resolver-Shortcut im warmen Kontext verifiziert — also den kritischen Pfad: warmes Kontext-Fenster + 9B aktiv + `„weiter"` → `action:request` mit `media_next`, **kein** `runWorker`. Das ist der Hauptgrund für den Feature.

---

### ⚪ Bekannte Einschränkung: Named-Target geht im Kontext verloren

Nach `„Pausiere Spotify"` (param = `'spotify'`) speichert `record` nur `lastAction: 'media_pause'`, kein Target. Der Shortcut für `„weiter"` feuert dann `media_play:''` (aktive Session). Falls Windows in der Zwischenzeit eine andere Session als aktiv führt, wird nicht Spotify fortgesetzt. Kein Bug der Spec — bewusstes YAGNI — aber es sollte dokumentiert sein, dass Named-Target-Kontext V2 ist.

---

### ⚪ Bekannte Einschränkung: `media_toggle`-Ausgang unbekannt

Nach `media_toggle` weiß der Kontext nicht ob die Wiedergabe jetzt läuft oder pausiert. `„weiter"` fällt auf `media_next` (else-Branch der Tabelle). Wenn Toggle pausiert hat, wäre `media_play` semantisch korrekt — aber nicht erreichbar ohne GSMTC-Status abzufragen. Für V1 akzeptabel, bekannte Einschränkung.

---

### ✓ `nochmal` → `media_previous` weglassen

Spec sagt selbst „kann in V1 auch weggelassen werden". Player-Verhalten bei `media_previous` hängt von der aktuellen Abspielposition ab (< 3 s → Neustart des Titels, sonst vorheriger). Nicht deterministisch. **Empfehlung: weglassen.**
