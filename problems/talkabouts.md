# Talkabouts - Plan-Review-Protokoll

# Action-Layer V1 — Spec-Review (2026-07-17)

**Grundlage:** `2026-07-16-action-layer-design.md` Rev. 3 gegen den aktuellen Working Tree (`feat/action-layer`)

---

## Kritisch — muss vor Plan-Phase geklärt werden

### K1 — Dev nicht gemergt: 46 Dateien aus Spec B fehlen im Working Tree

Der Branch `feat/action-layer` basiert auf `ab72650` (Spec A / PR #21). PR #22 (Spec B, `0f451a7`) ist in `origin/dev` gemergt, aber **nicht** in den lokalen Tree übernommen.

Folgendes fehlt komplett im Working Tree:

- `persistMessage()` — die Spec erwähnt ihn 9× als einzigen Schreibpfad
- `ConversationStore` — Session-Management, per-Boot-Session
- `buildContextWindow` — das kontrollierte Budget-Fenster
- `src/services/llm/router-service.test.ts` — der Integrations-Harness den Spec §10 nennt
- `src/services/llm/context-window.ts/.test.ts`
- `storage:degraded` Bus-Event in `bus-events.ts`
- `src/core/storage/conversation-store.ts`

Der aktuelle `router-service.ts` hat zwei rohe `db.insert('messages', { conversation_id: 1, ... })` Aufrufe — Spec B hat beides durch `persistMessage()` + ConversationStore-Session ersetzt.

**Konsequenz:** Kein einziger Implementierungsschritt aus §11 kann beginnen, bevor `dev` in `feat/action-layer` gemergt ist. Das ist die allererste Aktion — vor allem anderen.

---

### K2 — Interface-Lücke: Wer diskriminiert Route vs. Action?

Die Spec (§3) sagt: "`ParsedRoute` wird diskriminierte Union: `{ kind: 'route', … } | { kind: 'action', action, param, feedback }`."

`RoutingService.route()` gibt aber `RoutingResult` zurück (`{ route, feedback, tookMs, hadTag }`) — das ist ein anderer Typ. Die Frage, wer die Diskriminierung übernimmt, ist nicht beantwortet:

**Option A:** `RoutingService.route()` gibt direkt die Union zurück → bricht seine Schnittstelle, `tookMs`/`hadTag` müssen in beide Union-Arme.

**Option B:** `RouterService.routeAndRespond()` ruft `parseRouteTag()` direkt auf (Bypass von `RoutingService`) → `RoutingService` bleibt ROUTE-only, RouterService verwaltet beides selbst.

**Option C:** `RoutingService.route()` gibt einen Supertyp zurück der `ParsedRoute | RoutingResult` abdeckt → schlechtes API-Design.

Empfehlung: **Option A** — `RoutingResult` bekommt eine `parsed: ParsedRoute`-Property (die Union), `tookMs` und `hadTag` bleiben als flache Felder. Der Plan muss diese Entscheidung treffen bevor Schritt 1 beginnt.

---

### K3 — LLM-Provider-Zugang für SearchService nicht spezifiziert

`summarize-results.ts` braucht einen LLM-Aufruf (phi4-mini). Die Spec sagt das Modell ist "warm" und "kein VRAM-Swap nötig." Aber `SearchService` bekommt in §4 keinen Provider-Parameter.

Das Problem: Wenn RouterService gerade einen VRAM-Swap zu 9B durchgeführt hat (Worker läuft), ist phi4-mini nicht mehr im VRAM. Eine Suche die während eines Worker-Streams abgeschlossen wird, würde einen Cold-Load von phi4-mini triggern — was den laufenden Worker verdrängt. Dieser Race existiert in der aktuellen Spec nicht.

Mögliche Ansätze:

- SearchService bekommt den routerProvider im Konstruktor übergeben
- Zusammenfassung wartet in der `emitAssistantResponse`-Queue bis 9B-Turn fertig ist, dann ist phi4-mini wieder warm
- Zusammenfassung läuft nur wenn `activeModel === '2b'` (pragmatisch, aber sperrt Suche während Worker)

Der Plan muss eine explizite Entscheidung treffen.

---

### K4 — `hadTag` erkennt ACTION-Tags nicht

`routing-service.ts` berechnet: `hadTag = response.trimStart().startsWith('[ROUTE:')`.

Nach der Erweiterung gibt das Modell `[ACTION:...]` zurück → `hadTag = false` → `[Router] No route tag in 2B response, falling back to self` warnt für **jede** Aktion, obwohl alles korrekt funktioniert.

Fix ist trivial (OR-Condition auf `[ACTION:`), muss aber als expliziter Teilschritt in Implementierungsschritt 1 stehen damit er nicht vergessen wird.

---

## Major — muss im Implementierungsplan adressiert werden

### M1 — `routing-prompt.ts`: Photoshop-Beispiel ist noch drin

Die Spec (§3, Review-Punkt 6) sagt explizit: "Die bestehenden `[ROUTE:self]`-Beispiele fürs Programmöffnen werden **entfernt**."

Aktuell steht im Prompt:

```
User: "Öffne Photoshop" → [ROUTE:self] Natürlich, ich öffne Photoshop!
```

Dieser Eintrag muss durch ein `[ACTION:open_program:...]`-Beispiel ersetzt werden — als **erster Teilschritt von Implementierungsschritt 1**, noch vor dem Parser. Sonst konkurrieren ROUTE:self und ACTION-Signal im Modell und das Routing wird instabil.

---

### M2 — `emitAssistantResponse`: Serialisierungsmuster nicht konkretisiert

Die Spec sagt "Intern über eine Promise-Kette serialisiert." Das korrekte Muster ist:

```ts
private _outputQueue: Promise<void> = Promise.resolve();

private emitAssistantResponse(text: string): Promise<void> {
  this._outputQueue = this._outputQueue
    .then(() => this._doEmit(text))
    .catch(() => {});
  return this._outputQueue;
}
```

Ein naiver `isRunning: boolean`-Lock würde bei Exceptions dauerhaft blockieren. Das Muster muss im Plan explizit stehen damit es korrekt implementiert wird.

---

### M3 — SandboxBrowser/Timer-Cleanup fehlt in `main.ts`

`SandboxBrowser` und der Timer-Registry in `system-actions.ts` sind keine `SarahService`-Einträge (Spec §4: "Infrastruktur, kein Service"). `appContext.shutdown()` ruft nur `registry.destroyAll()` auf — die beiden werden **nicht** automatisch aufgeräumt.

In `app.on('window-all-closed')` muss explizit:

- `sandboxBrowser.close()` aufgerufen werden
- Alle laufenden Timer via `system-actions`-Cleanup gecancelt werden

Der Plan muss das als konkreten Schritt in den `main.ts`-Änderungen (§4) führen.

---

### M4 — Spikes als Blocker-Gates im Plan markieren

Die Spec nennt zwei offene Spikes:

- **appx-Spike** (Implementierungsschritt 3): `explorer.exe shell:AppsFolder\<AUMID>` vs. PowerShell — muss auf echtem Store-Eintrag (Spotify) verifiziert werden **bevor** `program-launcher.ts` implementiert wird
- **set_volume-Spike** (Implementierungsschritt 4): Package-Kandidat auf Adminrecht-Freiheit + Electron-Kompatibilität prüfen **bevor** Dependency ins Lockfile kommt

Im Plan müssen diese als explizite Blocker-Gates stehen: "Schritt X startet erst nach Spike-Abschluss."

---

### M5 — Namenskollision `router-service.test.ts` auflösen

Es gibt zwei Testdateien mit identischem Namen:

- `src/services/llm/router-service.test.ts` — Spec B Integrations-Harness (kommt mit dem dev-Merge)
- `tests/services/llm/router-service.test.ts` — alte Mock-Tests (existieren heute)

Die Spec warnt davor ("nicht verwechseln"), sagt aber nicht was zu tun ist. Die Mock-Tests überlappen inhaltlich mit der Integration-Harness. Empfehlung: **Die alte Datei nach `tests/services/llm/router-service-mock.test.ts` umbenennen** (oder löschen wenn die Abdeckung durch die Integrations-Tests vollständig ist). Muss vor Implementierungsschritt 2 entschieden sein.

---

### M6 — `RouterService.subscriptions` ist nach dem Umbau unvollständig

Aktuell: `readonly subscriptions = ['chat:message'] as const`.

Nach dem Umbau subscribed RouterService auch auf `action:result` und `action:notify` (§3). Das Array muss auf `['chat:message', 'action:result', 'action:notify'] as const` erweitert werden. Wenn das vergessen wird, kommen keine Action-Ergebnisse beim Router an — kein Fehler, nur Stille.

---

## Minor — Implementierung beachten

### Mi1 — ActionService darf nie `context.db.insert()` direkt aufrufen

"Historien-Eigentum bleibt beim RouterService. ActionService fasst Historie/DB nie an." (Spec §3)

`AppContext` hat `context.db` und jeder Service mit AppContext-Zugang könnte direkt schreiben. Im Plan notieren: ActionService bekommt **keinen** direkten `AppContext`-Zugang — nur Bus-Referenz und spezifische Infrastruktur-Deps (ProgramLauncher, SearchService, system-actions).

### Mi2 — `conversation_id: 1` nach dev-Merge obsolet

Nach Spec B nutzt `ConversationStore` eine Per-Boot-Session-ID. Der aktuelle Code hat hardcoded `1`. Das ist nach dem dev-Merge gefixt. Bei der Action-Layer-Implementierung sicherstellen: Kein neuer Code schreibt irgendwo `conversation_id: 1` hard — alles läuft über `persistMessage()`.

### Mi3 — AbortSignal ↔ Electron BrowserWindow-Brücke

Electron `BrowserWindow` kennt keinen nativen AbortSignal. Die Brücke muss explizit gebaut werden:

```ts
signal.addEventListener('abort', () => win.webContents.stop(), { once: true });
```

Zusätzlich: Ein `did-finish-load`-Handler der nach dem Abort feuert muss das Result verwerfen (Spec §6: "ein spätes `did-finish-load` nach Abbruch erzeugt keine veraltete Summary"). Das ist ein subtiler Lifecycle-Punkt der in Schritt 5 explizit getestet werden muss.

### Mi4 — `show_browser`-Session ist nicht requestId-indiziert

Die Ergebnis-Session hat `{ requestId, results[] }`, aber `show_browser` schaut **nicht** nach dem requestId der Suche. Es gibt nur **eine** aktuelle Session. Der requestId in der Session gehört zum `web_search`-Request, nicht zum `show_browser`-Request.

Ein Implementierer könnte fälschlicherweise versuchen die Session per requestId zu finden. Plan muss klarstellen: Session = single-slot, bei `show_browser` immer die aktuelle (oder keine), kein requestId-Lookup.

### Mi5 — Timer-Monotonizität: Konkreten Mechanismus festlegen

"Monotone Zeitbasis (`process.hrtime`/Date-Differenz statt blindem Vertrauen in `setTimeout`)" ist richtig motiviert, aber offen. Praktische Empfehlung: `Date.now()`-Startzeit merken, im Callback prüfen ob `Date.now() - start >= durationMs`, sonst `setTimeout(remaining)` neu ansetzen. Das ist einfach und testbar mit `vi.useFakeTimers`. Der Plan muss eine Entscheidung treffen.

### Mi6 — `show_browser`-Race bei gleichzeitiger neuer Suche

`SandboxBrowser` startet mit `show: false`. `show_browser` ruft `show(url)` auf. Wenn parallel eine neue Suche läuft (Partition-Clear + neue Navigation), zeigt `show()` kurzzeitig eine leere oder falsche Seite.

Empfehlung: Die Ergebnis-Session bekommt ein `loaded: boolean`-Flag, das erst nach erfolgreichem `did-finish-load` der Ergebnis-URL gesetzt wird. `show()` nur wenn `loaded === true`.

### Mi7 — `ipc-programs.ts` vs. `ProgramLauncher`: Zuständigkeit dokumentieren

Beide benutzen `program-utils.ts`. Im Plan explizit notieren: `ProgramLauncher` registriert **keinen** IPC. `ipc-programs.ts` **startet nie** Programme. Zuständigkeiten überlappen nicht — aber der Reflex, beides zu vereinen, ist naheliegend.

---

## Zusammenfassung Prioritäten

| #     | Typ          | Titel                                                          |
| ----- | ------------ | -------------------------------------------------------------- |
| K1    | **Kritisch** | `dev` in `feat/action-layer` mergen — erster Schritt überhaupt |
| K2    | **Kritisch** | Interface-Entscheidung: wer diskriminiert Route vs. Action     |
| K3    | **Kritisch** | LLM-Provider-Zugang für SearchService + VRAM-Race klären       |
| K4    | **Kritisch** | `hadTag` für ACTION-Tags fixen                                 |
| M1    | Major        | Photoshop-Beispiel aus Routing-Prompt entfernen                |
| M2    | Major        | `emitAssistantResponse` Promise-Chain-Muster konkretisieren    |
| M3    | Major        | SandboxBrowser/Timer-Cleanup in `main.ts` verdrahten           |
| M4    | Major        | Spikes als Blocker-Gates im Plan markieren                     |
| M5    | Major        | Namenskollision `router-service.test.ts` auflösen              |
| M6    | Major        | `subscriptions`-Array in RouterService erweitern               |
| Mi1–7 | Minor        | Siehe oben                                                     |

---

## Antworten + Konsolidierung (Claude, 17.07.2026 — in Spec Rev. 4 eingearbeitet)

Zwei Reviews lagen vor: Copilot (K1–K4, M1–M6, Mi1–Mi7, oben) und ein frisches
Architektur-Review gegen den gemergten Tree (F1–F11). Konsolidierung:

**In Spec Rev. 4 eingearbeitet:**
- K1: erledigt — dev gemergt (`6a5330b`), Suite 427/427 grün.
- F1 + K3 (verwandt): **Heuristik-Gate im 9B-Fenster** (Entscheidung Martin):
  Worker bleibt warm, `ACTION_HINT_WORDS` triggern den Swap zum Router; die
  Heuristik führt nie selbst aus. Summary läuft immer auf dem gerade warmen
  Modell — eine Summary löst nie einen Modell-Load aus. Neue Spec-Sektion §3.
- F2: Renderer-Vertrag — `llm:chunk` ohne offene Bubble erzeugt neue
  Assistant-Bubble; `dashboard.ts` in §4 aufgenommen.
- K2: Option A festgeschrieben (`RoutingResult.parsed: ParsedRoute`).
- K4: `hadTag` erkennt `[ACTION:` mit (Spec §3 explizit).
- F4: Sicherheits-Behauptung korrigiert (Worker-Prompt enthält Profildaten);
  Rest-Risiko „Aussprechen persönlicher Daten" dokumentiert.
- F5: Programm-Matcher als Neubau benannt, Match-Semantik in §5 festgelegt
  (Normalisierung, exakt → Alias → Fuzzy, Rückfrage bei Gleichstand).
- F6 + Mi6: Fenster-Doppelrolle entschieden — neue Suche beendet Anzeige;
  show_browser während Suche → ehrliche Absage; loaded-Flag.
- F7: Kennzeichnungssatz präzisiert (nur Worker-Prompt; Routing bleibt
  historienfrei — strukturelle Garantie bleibt erhalten).
- F8: explizite Call-Optionen für Summary (Temperatur, num_predict ~256);
  ChatOptions-Erweiterung nötig.
- F9: verzögerte Ansagen warten, bis der VoiceService nicht mehr aufnimmt.
- F10: show_browser-Schema `.min(1)`; `mode`-Feld aus action:request gestrichen.
- F11: `encodeURIComponent` auf Query vor URL-Bau (§7).
- M3: main.ts-Cleanup-Pflicht in §4-Shutdown; M5: Umbenennung
  `router-service-mock.test.ts` festgelegt; M6: subscriptions-Warnung in §4.

**Bleiben Plan-Phase-Notizen (nicht Spec):** M1 (Prompt-Beispiel-Reihenfolge),
M2 (Promise-Chain-Snippet, in §11 Schritt 2 referenziert), M4 (Spike-Gates),
Mi1–Mi5, Mi7 (unverändert gültig).
