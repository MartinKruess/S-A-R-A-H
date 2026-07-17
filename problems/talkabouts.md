# Talkabouts - Plan-Review-Protokoll

# Action-Layer V1 — Spec-Review (2026-07-17)

                   |

| M5 | Major | Namenskollision `router-service.test.ts` auflösen |
| M6 | Major | `subscriptions`-Array in RouterService erweitern |
| Mi1–7 | Minor | Siehe oben |

---

**Bleiben Plan-Phase-Notizen (nicht Spec):** M1 (Prompt-Beispiel-Reihenfolge),
M2 (Promise-Chain-Snippet, in §11 Schritt 2 referenziert), M4 (Spike-Gates),
Mi1–Mi5, Mi7 (unverändert gültig).

---

# Action-Layer V1 — Spec-Review Rev. 4 (2026-07-17)

**Grundlage:** `2026-07-16-action-layer-design.md` Rev. 4 + Working Tree nach `dev`-Merge (`6a5330b`, Suite 427/427 grün).
Alle K- und die meisten M/Mi-Punkte des vorigen Reviews sind eingearbeitet. Neue Befunde unten.

---

## Kritisch — keine

Alle vier K-Punkte des Rev.-3-Reviews sind adressiert. Keine neuen kritischen Blocker.

---

## Major — 3 neue Punkte

### R4-M1 — Heuristik-Gate: `activeModel`-State nach Self-Route inkonsistent

Das Heuristik-Gate setzt im 9B-Fenster `vramManager.swapModels(workerModel)` — unlädt qwen, phi4-mini wird beim nächsten Aufruf automatisch geladen. Dann ruft es `routeAndRespond(text, mode)` auf.

**Problem:** Wenn `routeAndRespond` auf `self` routed (Heuristik hat korrekt getriggert, Aktion-Tag kommt aber zurück), gibt es eine Antwort und kehrt zurück — **ohne `activeModel` zu ändern**. `activeModel` bleibt `'9b'`.

Folge: Die nächste User-Nachricht trifft auf `activeModel === '9b'` → geht direkt zum Worker → Ollama lädt qwen, obwohl phi4-mini im VRAM liegt. Kein Fehler, aber unnötiger Cold-Load und falsche State-Logik.

**Fix:** Das Heuristik-Gate setzt `activeModel = '2b'` **vor** dem `routeAndRespond`-Aufruf. Wenn `routeAndRespond` auf 9B routed, überschreibt es `activeModel = '9b'` intern ohnehin. Wenn es auf self routed, bleibt `activeModel = '2b'` korrekt.

Der Plan muss diesen Teilschritt in §11 Schritt 2 (Router-Turn-Modell) explizit aufführen.

---

### R4-M2 — `voice-service.ts` fehlt in §4 Datei-Struktur-Tabelle

F9 beschreibt ein neues Verhalten: „Steht der VoiceService auf `listening`, werden verzögerte Sprachausgaben aufgeschoben, bis die Aufnahme endet."

Der aktuelle VoiceService-`onMessage`-Handler prüft nur `shouldSpeak` (`voiceMode !== 'off' && interactionMode !== 'chat'`). Es gibt **keine** Deferral-Logik für den `listening`-State. Die Implementierung von F9 erfordert eine Änderung in `src/services/voice/voice-service.ts` — diese Datei steht nicht in §4.

Konkret: Wenn `_voiceState === 'listening'`, muss `llm:chunk`/`llm:done` für TTS gepuffert werden. Die Chat-Bubble erscheint sofort (Dashboard ist von VoiceService unabhängig). Nach Ende der Aufnahme (`voice:transcript` → Übergang zu `processing`) wird der Puffer abgespielt.

**§4 Datei-Struktur muss `src/services/voice/voice-service.ts` als „ändern" aufführen.**

---

### R4-M3 — `llm-provider.interface.ts` und `ollama-provider.ts` fehlen in §4

F8 schreibt vor: „niedrige Temperatur, `num_predict`-Cap ~256 — Achtung: per-Call-Temperatur braucht eine kleine `ChatOptions`-Erweiterung im Provider-Interface."

Aktuelles Interface: `ChatOptions` hat `num_predict`, `keep_alive`, `signal` — kein `temperature`. Ohne diese Erweiterung kann `summarize-results.ts` keine Temperatur steuern.

Betroffene Dateien (beide fehlen in §4):

- `src/services/llm/llm-provider.interface.ts` — `ChatOptions` um optionales `temperature?: number` erweitern
- `src/services/llm/providers/ollama-provider.ts` — das Feld in den Ollama-Request-Body übernehmen

---

## Minor — 4 neue Punkte

### R4-Mi1 — `pendingActions` Map: Value-Typ und Entry-Lifecycle undefiniert

Die Spec schreibt: `pendingActions: Map<requestId, …>` — die Ellipse ist kein Typ. Es fehlt:

1. **Was hält der Value?** Für fire-and-forget-Aktionen (open_program, lock_screen) braucht die Map keinen Rückgabewert. Für web_search muss das Result über die Queue ankommen — der Value könnte z. B. ein Resolver-Callback für die Queue sein, oder einfach `true` als "wir warten noch".
2. **Wann wird ein Entry entfernt?** Nach `action:result` eingetroffen? Nach `emitAssistantResponse` abgeschlossen? Gar nicht (Leak bei nie-kommendem Result)?
3. **`destroy()`**: Offene Entries (laufende Suche) → hängende Promises, die nach Shutdown noch `action:result` emittieren wollen. Der Shutdown-Guard in `emitAssistantResponse` fängt das, aber die Map selbst sollte in `destroy()` geleert werden.

Der Plan muss den Value-Typ und den vollständigen Lifecycle festlegen.

---

### R4-Mi2 — Timer-Monotonizität: konkreter Mechanismus immer noch offen

Aus Mi5 des Rev.-3-Reviews unverändert übernommen: „monotone Zeitbasis (`process.hrtime`/Date-Differenz statt blindem Vertrauen in `setTimeout`)" — keine Entscheidung, welcher konkrete Mechanismus gebaut wird.

Empfehlung für den Plan: `Date.now()`-Startzeit merken, im Callback prüfen ob `Date.now() - startMs >= durationMs`, sonst `setTimeout(remaining)` neu ansetzen. Testbar mit `vi.useFakeTimers`. Kein `process.hrtime` nötig — Wall-Clock reicht für Timer-Korrektheit nach Standby.

---

### R4-Mi3 — `lock_screen` ohne Zod-Schema in §5

Die §5-Tabelle zeigt für lock_screen die Spalte „Param-Schema" leer. Das Bus-Payload `action:request` hat immer `{ param: string }`. Wenn der Parser für `[ACTION:lock_screen]` (kein zweiter Doppelpunkt) einen leeren String liefert, muss ActionService entscheiden, wie er validiert.

Empfehlung: explizit `z.literal('').optional()` oder `z.undefined()` als Schema — damit ein fehlerhafter LLM-Output wie `[ACTION:lock_screen:jetzt_sofort]` als Zod-Fehler landet (unbekannter Param → `speak: 'Das kann ich noch nicht.'`), statt lautlos zu starten.

---

### R4-Mi4 — Allowlist-Import-Richtung undokumentiert

RouterService muss beim Empfang von `parsed.kind === 'action'` prüfen, ob `parsed.action` in der Allowlist steht — bevor `action:request` emittiert wird. Die Allowlist soll in `action-schemas.ts` liegen (`services/actions/`). RouterService liegt in `services/llm/`.

Der cross-service Import `llm → actions` ist kein circular dep (action-schemas importiert nichts aus llm). Aber er fehlt komplett in der Spec-Beschreibung: weder §3 noch §4 erwähnen, dass RouterService aus action-schemas importiert. Der Plan muss diesen Import explizit notieren — sonst entsteht im Router eine zweite, divergierende Allowlist-Kopie.

---

## Zusammenfassung Rev. 4

| #      | Typ       | Titel                                                                              |
| ------ | --------- | ---------------------------------------------------------------------------------- |
| R4-M1  | **Major** | Heuristik-Gate: `activeModel = '2b'` vor `routeAndRespond` setzen                  |
| R4-M2  | **Major** | `voice-service.ts` in §4 eintragen (F9 TTS-Deferral)                               |
| R4-M3  | **Major** | `llm-provider.interface.ts` + `ollama-provider.ts` in §4 eintragen (F8 Temperatur) |
| R4-Mi1 | Minor     | `pendingActions` Value-Typ + Entry-Lifecycle festlegen                             |
| R4-Mi2 | Minor     | Timer-Monotonizität: konkreten Mechanismus im Plan entscheiden                     |
| R4-Mi3 | Minor     | `lock_screen` Zod-Schema in §5 explizit machen                                     |
| R4-Mi4 | Minor     | Allowlist-Import `llm → actions` in §3/§4 dokumentieren                            |

---

## Antworten Rev.-4-Review (Claude, 17.07.2026 — in Spec Rev. 5 eingearbeitet)

Alle 7 Punkte angenommen, keiner kollidiert mit getroffenen Entscheidungen:

- R4-M1: **verifiziert am Code** (`activeModel='9b'` nur in der 9B-Route,
  router-service.ts:147; Self-Route lässt State stehen). Fix wie vorgeschlagen
  als Bullet in der Heuristik-Gate-Sektion (§3): `activeModel='2b'` vor
  `routeAndRespond`.
- R4-M2: `voice-service.ts` in §4 aufgenommen (TTS-Deferral bei `listening`,
  Chat-Bubble sofort).
- R4-M3: `llm-provider.interface.ts` + `ollama-provider.ts` in §4 aufgenommen
  (`ChatOptions.temperature?`).
- R4-Mi1: in der Spec festgelegt statt an den Plan delegiert:
  `Map<string, { action: string }>`; ActionService emittiert **genau ein**
  `action:result` pro Request (auch stille Erfolge) → räumt den Entry;
  `destroy()` leert die Map.
- R4-Mi2: entschieden (§5): Date.now()-Differenz + Restzeit-Nachschlag,
  kein hrtime.
- R4-Mi3: `lock_screen`-Schema `z.literal('')` (§5) — Nicht-Leer-Param ist
  Zod-Fehler, nie stiller Start.
- R4-Mi4: Allowlist-Import `llm → actions` in §3 dokumentiert (eine Quelle,
  keine Kopie im Router).

Spec Rev. 5 ist damit aus unserer Sicht plan-ready.
