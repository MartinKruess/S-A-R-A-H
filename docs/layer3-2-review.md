# Layer 3 → 2 — Unabhängiges Audit

**Stand:** 31.08.2026
**Branch:** `fix/layer3-2-audit-findings`
**Scope:** Schnittstelle Layer 3 (Intelligence, Decisions, Planning) → Layer 2 (Kontext, Memory, Regeln, Berechtigungen)
**Methode:** Fünf unabhängige Read-only-Audits in getrennten Prüfdomänen, erneute Einzelvalidierung jedes Befunds auf `dev` nach PR #37, domänenweise Korrektur bestätigter Ursachen und unabhängiger Closure-Reaudit.

Die Detailtexte in Abschnitt 3 beschreiben jeweils den verifizierten Zustand **vor** der Korrektur. Der aktuelle Abschlussstatus steht in Abschnitt 2.1 und 6.

## 1. Prüfdomänen

| Domäne | Gegenstand |
|---|---|
| A | DecisionContext, Prompt-Layer, Kontextbudget, Injection-Oberflächen |
| B | Privacy/Inkognito, Persistenz und Logging von Entscheidungsdaten |
| C | Berechtigungen, ActionPolicy, Bestätigungsvertrag, Parameter-Grounding |
| D | Nutzerregeln, Custom Commands, `effectiveText`, Provenienz |
| E | Memory-Recall, Kurator-Auslösung, Ergebnisbewertung |

Bereits dokumentierte Befunde (L3-A01…A07, L3-B01…B06, L3-C01…C04, L3-D01…D04, TIMER-A\*, REM-A\*) waren jeder Domäne vorab bekannt und durften nicht erneut gezählt werden. Aufgenommen wurden nur neue Ursachen oder belegbar unvollständige Fixes.

## 2. Ergebnis

23 Rohbefunde, nach Zusammenlegung dreier Doppelungen **20 eigenständige Ursachen**: **1 × P0, 9 × P1, 10 × P2**. Die erneute Detailprüfung bestätigte 18 Ursachen. Zwei Punkte bleiben bewusst plausibel, aber ohne deterministisch nachgewiesene Produktwirkung.

Die Abbruchschwelle von fünf neuen Befunden ist deutlich überschritten. Der Grund ist klar benennbar: Die bisherige Auditserie hat den Layer-3→2-Vertrag entlang der **Conversation-/Memory-Achse** dicht gemacht. Zwei Achsen daneben sind unauditiert geblieben — die **Prompt-Budgetrechnung** und die **zweite persistente Datendomäne `reminders`**. Genau dort liegen alle schweren Befunde.

| ID | Prio | Kurzfassung | Status |
|---|:---:|---|---|
| L32-01 | P0 | Reminder-Schreibpfad besitzt kein einziges Layer-2-Gate | bestätigt, behoben |
| L32-02 | P1 | Antwortbudget verdrängt bei Default-`num_ctx` die gesamte Layer-2-Kontextzusammenstellung | bestätigt, behoben |
| L32-03 | P1 | Layer-2-Konfiguration kann jeden Turn hart scheitern lassen; Fehlermeldung nennt falsche Ursache | bestätigt, behoben |
| L32-04 | P1 | Routing-Prompt ist größer als das fest verdrahtete Router-`num_ctx` | bestätigt, behoben |
| L32-05 | P1 | Unverankertes Confirm-Muster verbraucht eine Rückfrage als verbindliche Zustimmung | bestätigt, behoben |
| L32-06 | P1 | Einmaliges `/anonymous <Text>` sperrt Persistenz und Kurator für die restliche Session | bestätigt, behoben |
| L32-07 | P1 | Retroaktive Layer-2-Löschung erfasst `reminders` nicht | bestätigt, behoben |
| L32-08 | P1 | Nicht-Log-Vertrag endet vor dem Executor | bestätigt, behoben |
| L32-09 | P1 | Reminder-Fälligkeit verliert Eingabemodus und Privatkontext | bestätigt, behoben |
| L32-10 | P1 | Recall liefert widersprechende Erinnerungen ohne Aktualitätssignal | bestätigt, Signal ergänzt |
| L32-11 | P2 | Bestätigungsstufe `minimal` bestätigt faktisch nie etwas | bestätigt, behoben |
| L32-12 | P2 | Recall-Block ist längenungebunden und alles-oder-nichts | bestätigt, behoben |
| L32-13 | P2 | `cancel_reminder:id=N` ist allein durch das Vorkommen der Ziffer gegroundet | bestätigt, behoben |
| L32-14 | P2 | Interner Expansions-Kittext gelangt wörtlich ins kuratierte Gedächtnis | bestätigt, behoben |
| L32-15 | P2 | Fremdinhalte erreichen den Prompt ohne Trust-Anweisung | bestätigt, behoben |
| L32-16 | P2 | Kuratierte Erinnerung verweist auf einen nie persistierten Quell-Turn | bestätigt, behoben |
| L32-17 | P2 | Fail-open Defaults für Berechtigungseingaben, toter zweiter Policy-Einstiegspunkt | bestätigt, behoben |
| L32-18 | P2 | `persistMessage` ist ein Persistenzpfad ohne Layer-2-Gate | bestätigt, latent, beseitigt |
| L32-19 | P2 | `confirmationLevel` wird an den Worker geliefert, der nicht handeln kann | plausibel, kein Bugbeweis |
| L32-20 | P2 | Aus Recall abgeleitete Antworten werden erneut kuratiert (Echo-Duplikate) | plausibel, kein Bugbeweis |

### 2.1 Abschlussvalidierung und umgesetzter Vertrag

| ID | Ergebnis der erneuten Prüfung und Korrektur |
|---|---|
| L32-01 | Reminder-Erstellung durchläuft jetzt `memoryAllowed`, Ausschlüsse, Secret-Matrix und `privateContext`; nicht zulässige Inhalte werden vor dem Insert abgewiesen. |
| L32-02 | Optionale History und Recall erhalten Budget oberhalb einer garantierten Antwortreserve; ein großer Antwortwunsch reduziert zuerst `num_predict`, statt sämtlichen Kontext zu verdrängen. |
| L32-03 | Konfigurationsblöcke werden gegen das reale Workerfenster begrenzt; echte geschützte Überläufe liefern einen eigenen `ContextWindowError` mit ehrlicher Nutzerfehlermeldung. |
| L32-04 | Router und Runtime verwenden einen gemeinsamen Kontextvertrag mit 16.384 Token; Systemprompt plus maximal akzeptierte Nutzereingabe werden vor dem Provider-Aufruf fail-closed geprüft. |
| L32-05 | Bestätigungssätze sind vollständig verankert; Fragen, Negationen und Erklärwünsche können den offenen Gate nicht mehr verbrauchen. |
| L32-06 | One-shot Anonymous beeinflusst höchstens einen abhängigen Folgeturn transient; danach kann ein normaler Turn wieder persistieren. Ein abgelehntes Anonymous-Kommando vergiftet keine Folgezüge. |
| L32-07 | Policy-Purge erfasst ausgeschlossene, unbedingt private und nicht mehr lesbare Reminder samt rekursiver Quarantänekopien. `/deletememory all` löscht geplante Termine weiterhin nicht, weil das eine eigene Produktentscheidung wäre. |
| L32-08 | Launcher und Dashboard protokollieren nur noch Strukturwerte; Query, Programmname, Pfad, Antworttext und vollständige Event-Payloads bleiben aus Logs heraus. |
| L32-09 | `originMode` und `privateContext` bleiben von Erstellung bis Fälligkeit erhalten. Schema v3 migriert nicht rekonstruierbare Altbestände fail-closed auf Chat/privat. |
| L32-10 | Recall-Daten tragen nun `createdAt`. Automatisches Zusammenführen oder Ersetzen widersprüchlicher Erinnerungen bleibt eine spätere Memory-Autor-Funktion, nicht Teil dieses Befunds. |
| L32-11 | `cancel_reminder:all` ist `critical` und verlangt dadurch auch auf Stufe `minimal` eine korrelierte Bestätigung. |
| L32-12 | Recall besteht aus einzeln budgetierbaren, priorisierten Datenblöcken; ein übergroßer Treffer verdrängt kleinere relevante Treffer nicht mehr. |
| L32-13 | Interne Reminder-IDs werden niemals aus bloßen Ziffern im Nutzertext gegroundet, sondern ausschließlich aus dem kurzlebigen korrelierten Auswahlkontext. |
| L32-14 | Bei Custom-Command-Memory wird nur das echte Nutzerargument gespeichert, nie Promptpräfix oder interner Glue-Text. |
| L32-15 | Externe Such- und lokale Programmdaten erhalten eine System-Level-Trust-Anweisung und bleiben transiente Daten, keine Anweisungen. |
| L32-16 | Erfolgreiches explizites Merken persistiert den echten User-Quellturn separat und policy-geprüft. Bei realem DB-Ausfall bleibt die nicht atomare Auditspur ehrlich als Storage-Degradation sichtbar. |
| L32-17 | Fehlende Webfreigabe wirkt fail-closed, ActionService-Policy-Getter sind verpflichtend und der tote zweite Confirmation-Einstiegspunkt ist entfernt. |
| L32-18 | Assistant-Ausgaben ohne aktiven Turn-Draft dürfen nicht mehr in History oder Datenbank geschrieben werden; der ungeregelte `persistMessage`-Pfad existiert nicht mehr. |
| L32-19 | Der Codezustand ist real, eine falsche Action oder Zusage aber nicht deterministisch belegt. Ohne Produktentscheidung über Worker-Persona/Capability-Kontext kein spekulativer Umbau. |
| L32-20 | Der mögliche Echo-Pfad ist modellabhängig und nicht reproduziert. Eine spätere Deduplizierung gehört in den geplanten Memory-Autor und wird nicht als aktueller Fix vorgetäuscht. |

---

## 3. Ausgangsbefunde und Validierung vor Korrektur

### L32-01 — P0 — Der Reminder-Schreibpfad besitzt kein einziges Layer-2-Gate

**Bestätigt.** Unabhängig in drei Prüfdomänen (B, C, D) gefunden — hier zusammengelegt, weil es eine Ursache ist.

Layer 2 setzt „was darf dauerhaft bestehen bleiben" über genau eine Gate-Funktion durch: `mustKeepTurnTransient()` plus die unveränderliche Secret-Matrix `containsUnconditionallyPrivateData()` (`src/core/memory-policy.ts:176`, `:218`). Eine repo-weite Suche zeigt: Alle Aufrufer liegen in `memory-policy.ts`, `conversation-store.ts`, `layer2-memory-store.ts`, `router-service.ts` und `sensitive-turn-guard.ts`. **Kein einziger** liegt in `src/services/reminders/*` oder `src/services/actions/*`.

`ActionService` reicht den gegroundeten Nutzertext direkt weiter (`src/services/actions/action-service.ts:432`), `ReminderStore.create()` prüft nur technische Verfügbarkeit und Formate (`src/services/reminders/reminder-store.ts:121-128`). `privateContext` wird auf `action:request` korrekt mitgesendet (`src/services/llm/router-service.ts:1360`) und im ActionService ausschließlich an `system.setTimer` weitergereicht — der einzige persistierende Zweig ignoriert es. `ActionPolicyContext` (`src/services/actions/action-policy.ts:19-27`) besitzt kein Feld für Privatkontext, Layer 2 kann die Grenze also nicht einmal ausdrücken.

Drei Teilfälle, jeder für sich reproduzierbar:

**(a) Secret-Matrix — dies ist der P0-Anteil.** „Erinnere mich morgen um 9 Uhr an WLAN-Passwort Sonne123." Der Conversation-Turn wird korrekt nicht persistiert (`SECRET_LABEL_PATTERN` greift). `/remember` mit demselben Text würde `null` liefern. Derselbe String liegt trotzdem dauerhaft als `reminders.text` in der DB und wird morgen um 9 Uhr vorgelesen. Das ist exakt die Ursache, die der Layer-2-Erstaudit als P0 Nr. 2 geführt hat — nur über eine Tabelle, die es damals noch nicht gab. Die UI-Zusage „Sarah merkt sich dein Verhalten und Muster, aber niemals Passwörter, Bank- oder Versicherungsdaten" (`src/renderer/dashboard/views/sections/trust-section.ts:38`, `src/renderer/wizard/steps/step-trust.ts:87`) ist damit erneut technisch nicht erfüllt.

**(b) Inkognito.** `REMEMBER_INTENT_PATTERN` (`router-service.ts:116`) deckt `merk dir`, `erinnere **dich**`, `behalte das/dies`, `speichere als Erinnerung` ab — **nicht** `erinnere **mich**`. `/anonymous` → „Erinnere mich in 30 Minuten an das Vorstellungsgespräch" läuft daher regulär in `set_reminder`. Der Turn bleibt transient, der Datensatz überlebt Abschnittsende und Neustart. Die Zusage lautet wörtlich „Dieser Abschnitt wird nicht gespeichert." (`router-service.ts:985`) beziehungsweise „Der private Abschnitt wurde verworfen." (`:1000`).

**(c) `memoryAllowed` und Ausschlusskategorien.** Bei deaktiviertem Gedächtnis oder aktiver Kategorie „Gesundheit" wird derselbe Inhalt aus `messages`, `memory_staging` und `curated_memories` ferngehalten und landet unverändert in `reminders`.

Mildernd: `reminders.text` steht nicht in `PASSTHROUGH_COLUMNS` (`src/core/storage/encrypted-storage.ts:25-32`) und ist damit at rest verschlüsselt. Das ist aber nicht der Vertrag — `curated_memories.content` ist ebenfalls verschlüsselt und wird trotzdem verweigert.

Kein Test im Repository deckt Reminder plus Privacy ab.

### L32-02 — P1 — Das Antwortbudget verdrängt bei Default-`num_ctx` die gesamte Layer-2-Kontextzusammenstellung

**Bestätigt und empirisch reproduziert** gegen den vorhandenen Build.

`src/services/llm/context-window.ts:116-128` klemmt `effectiveNumPredict = min(requested, availableForResponse)`. Sobald `requested >= available` ist, beansprucht die Antwortlänge **den gesamten freien Rest**, und `budget` wird strukturell exakt 0 — Live-History **und** Recall fallen vollständig weg, bevor irgendeine Priorisierung greift. Auslieferungsdefault sind `num_ctx: 4096` (`src/core/llm-defaults.ts:8`) und `responseStyle: mittel` → `numPredict: 1600` (`src/services/llm/llm-types.ts:30-34`).

Messung mit realistischer Systemprompt-Größe, drei Turns Historie und einem Recall-Treffer:

```
sysBytes 1675   effNP 1600   msgs 5   system,system,user,assistant,user
sysBytes 2112   effNP 1600   msgs 4   system,user,assistant,user        <- Recall weg
sysBytes 2286   effNP 1498   msgs 2   system,user                       <- Historie UND Recall weg
sysBytes 2881   effNP  903   msgs 2   system,user
```

`sysBytes 2112` entspricht einem im Wizard normal ausgefüllten Profil im Chat-Modus, `2286` demselben Profil im Voice-Modus. Ab dort enthält der Worker-Prompt nur noch Systemprompt und die aktuelle Frage.

Der Sonderfall in `router-service.ts:1776-1784` rettet ausschließlich **privaten** Verlauf, indem er `numPredict` auf `MIN_EFFECTIVE_NUM_PREDICT` senkt. Für normale History und für den Recall-Block existiert kein Äquivalent. Der zugehörige Test (`router-service.test.ts:320-339`) sichert genau diesen einen Pfad ab.

Kein bestehender Test widerlegt den Befund: `context-window.test.ts:47-111` prüft „volles Profil @ 4096" mit **leerer** History, sodass der Verlust nicht sichtbar wird; alle Router-Tests laufen mit leerem Profil (`sysBytes ≈ 1675`), wo der Effekt noch nicht greift.

Wirkung: Layer 2 stellt Kontext und Recall vertragsgemäß bereit, Layer 3 wirft beides bei der Prompt-Zusammenstellung geräuschlos weg. Kein Log, kein `storage:degraded`, keine Degradationsanzeige. `/showcontext` listet die Erinnerungen weiterhin und bestätigt dem Nutzer damit ein Gedächtnis, das in der Antwort nicht ankommt.

### L32-03 — P1 — Layer-2-Konfiguration kann jeden Turn hart scheitern lassen; der Nutzer sieht einen Verbindungsfehler

**Bestätigt und empirisch reproduziert.**

`context-window.ts:118-122` wirft fail-closed einen `RangeError`, wenn der geschützte Prompt das Fenster sprengt. Das ist richtig. Falsch ist die Attribution: Der Fehler läuft über `runWorker` → `runWorkerWithFallback` → `executeTurn` (`router-service.ts:721-725`) und wird dort auf `ERROR_MESSAGES.connection` abgebildet — „Sarah ist kurz weggedriftet. Einen Moment…".

Auslöser sind Layer-2-Konfigurationsfelder, die im Schema unbegrenzt sind (`src/core/config-schema.ts:31-33`, `:119`: `usagePurposes`, `hobbies`, `linkPreferences`, `characterTraits` ohne `.max()`). Die Prompt-Schicht kappt nur pro Eintrag (200 Zeichen) und auf 20 Einträge; die UI bietet unbegrenztes Nachlegen an (`src/renderer/dashboard/views/sections/profile-section.ts:192-201`).

Gemessen (Voice, `num_ctx` 4096, Stil `mittel`):

```
links= 5   sysBytes 2881   effNP 903
links=10   sysBytes 3763   THROW RangeError: response=21, required=128
links=15   sysBytes 4653   THROW RangeError: response=0,  required=128
```

Ab etwa zehn gepflegten Link-Präferenzen scheitert **jeder** Chat- und Voice-Turn. Nichts im System nennt die Konfiguration als Ursache; ein Rollback ist nur durch Raten möglich.

### L32-04 — P1 — Der Routing-Prompt ist größer als das fest verdrahtete Router-`num_ctx`

**Bestätigt und empirisch gemessen.**

`buildRoutingPrompt()` erzeugt aktuell **8.050 Zeichen / 8.100 Bytes**. Der Router-Provider wird mit `num_ctx: 2048` fest verdrahtet (`src/services/llm/model-runtime.ts:150`), und `routing-service.ts:22-26` ruft `buildContextWindow` **nicht** auf — der Router ist der einzige Modellpfad ohne Budgetgrenze. Selbst bei einer optimistischen BPE-Abschätzung von 3,2 Bytes/Token sind das ≈ 2.531 Token, also mehr als das Fenster, noch vor Nutzertext (bis 4.000 Zeichen, `src/core/chat-limits.ts:1`) und `num_predict`.

Wachstum bei unverändertem `num_ctx`:

```
b8bcfa7 (Layer-0-Fix)      routing-prompt.ts  2.269 B
4b2fff9 (Timer V2, #33)    routing-prompt.ts  4.290 B
e630006 (Reminders, #34)   routing-prompt.ts  8.875 B  == HEAD
```

Dass 2048 tatsächlich gesendet wird, sichert `routing-service.test.ts:31-41` ausdrücklich ab. Kein Test prüft, ob der Prompt hineinpasst.

Wirkung: Der Prompt wird serverseitig gekürzt. Welcher Teil des Regelwerks dabei verloren geht — Reminder-Regeln, Timer-Label-Regeln, die Few-Shot-Beispiele oder die Fallback-Regel „For every non-action message return `[ROUTE:9b]`" — ist nicht kontrolliert. Die zuletzt ergänzten Reminder-Beispiele stehen am Ende und sind am stärksten gefährdet, obwohl sie den jüngsten Vertrag tragen. Mildernd: `parseRouteTag` fällt bei fehlendem Tag auf `[ROUTE:9b]` zurück; das schützt gegen „kein Tag", nicht gegen ein *falsches* Tag.

Der Routing-Prompt **ist** der Systemvertrag der Layer-3-Entscheidung. Layer 2 hat mit `buildContextWindow` eine kontrollierte, fail-closed Kontextzusammenstellung etabliert; der Router umgeht sie vollständig.

### L32-05 — P1 — Ein unverankertes Confirm-Muster verbraucht eine Rückfrage als verbindliche Zustimmung

**Bestätigt und empirisch reproduziert.** Der Effekt ist stärker als zunächst gemeldet.

`src/core/action-confirmation.ts:74` ist das einzige Confirm-Muster ohne Verankerung — `.*` läuft über den ganzen Satz:

```ts
if (/\b(?:diese\s+aktion|den\s+auftrag)\b.*\bbestätig(?:e|en)\b/u.test(normalized)) return 'confirm';
```

Gegen `resolveActionConfirmationIntent` aus dem Build gemessen:

```
"Muss ich diese Aktion wirklich bestätigen?"                    -> confirm
"Kann ich diese Aktion später bestätigen?"                      -> confirm
"Ich weiß nicht, ob ich diese Aktion wirklich bestätigen soll"  -> confirm
"Warum soll ich den Auftrag bestätigen?"                        -> confirm
"Was passiert, wenn ich diese Aktion nicht bestätige?"          -> confirm
```

Der letzte Fall ist der schwerwiegendste: eine ausdrückliche **Verneinung** wird als Zustimmung gelesen. Die Cancel-Regeln greifen davor nicht, weil sie `\bnicht\s+(?:bestätigen|…)` als direkte Folge verlangen.

Verbraucht wird das in `router-service.ts:679` → `confirmSpokenAction` → `dispatchConfirmedAction` (`:1717-1734`) **ohne erneutes Grounding**. Konkret bei `confirmationLevel: 'standard'`: „Lösche alle Erinnerungen" öffnet den Gate (`cancel_reminder:all` ist `sensitive`), die Rückfrage „Muss ich diese Aktion wirklich bestätigen?" löscht sie. `action-confirmation.test.ts:60-75` testet nur isolierte Kurzformen; der unverankerte Zweig ist ungetestet.

REM-A07 behauptet ausdrücklich „Nur isolierte beziehungsweise deiktische Bestätigungsantworten bedienen den offenen Gate". Dies ist der belegte Restpfad, der diese Behauptung bricht.

### L32-06 — P1 — Einmaliges `/anonymous <Text>` sperrt Persistenz und Kurator für die restliche Session

**Bestätigt** durch vollständigen Code-Trace.

`/anonymous <args>` erzeugt `command.kind === 'anonymous'` **ohne** Incognito-Toggle (`togglesIncognito` verlangt `arguments.length === 0`, `router-service.ts:629-630`). Der Draft trägt trotzdem `privateTurn: true` und `privateContext: true` (`:633`, `:654`).

Beim Commit ist `this.incognitoActive === false`, der Turn landet daher **nicht** in `incognitoHistoryTurnIds` (`:1935`) — und nur dieses Set wird beim Incognito-Ende wieder aus der History entfernt (`:988`). Die History-Zeile wird mit `privateContext: draft.privateContext` gepusht (`:1920`, `:1930`).

Die Kette ist selbsttragend:

1. Turn N+1 liest `inheritedTransient: this.history.some(entry => entry.privateContext)` → `true` (`:647`) und setzt selbst wieder `privateContext: true` (`:654`).
2. `commitTurn` setzt daraus `transient = true` (`:1896`) → **kein** `persistTurn`, also kein Staging und kein `memoryCurator.schedule()`.
3. Der Filter in `:1907` entfernt zwar die alten transienten Einträge, läuft aber **vor** dem Push — und der neue Eintrag trägt erneut `privateContext: true`.

`privateContext` wird an keiner anderen Stelle gelöscht (Zuweisungen nur `:654`, `:1920`, `:1930`; Entfernung nur `:988` und `destroy()`).

Wirkung: Nach einem einzigen `/anonymous Wie hoch ist mein Blutdruck normalerweise?` wird für den Rest des App-Laufs **kein** Turn mehr persistiert, kein Staging geschrieben, keine Erinnerung kuratiert — und `warnPersistenceOnce()` löst nicht aus, es gibt also keinerlei UI-Hinweis. Auswege sind nur ein Neustart oder ein vollständiger Incognito-Zyklus.

Zweite Variante mit identischer Wirkung: Bei `trust.anonymousEnabled === false` antwortet Sarah „Der Anonymous-Modus ist in den Einstellungen deaktiviert." (`:665`), der Draft trägt aber trotzdem `privateTurn: true` und `suppressHistory: false` — dieselbe Dauersperre nach einem **abgelehnten** Kommando.

Der bestehende Test `router-service.test.ts:296-317` schreibt genau dieses Verhalten fest: Der dritte Turn enthält den privaten Inhalt beweisbar nicht mehr im Prompt und wird trotzdem nicht persistiert. Der Test endet nach drei Turns; der Code endet nie.

Die Richtung ist fail-closed, es entsteht kein Datenleck. Der Layer-2-Plan verlangt für `/anonymous <Text>` aber ausdrücklich Flüchtigkeit für *einen* Turn, nicht für die Session.

### L32-07 — P1 — Die retroaktive Layer-2-Löschung erfasst `reminders` nicht

**Bestätigt.** Gegenstück zu L32-01 an anderer Codestelle.

`Layer2MemoryStore.applyPolicy` ist die einzige retroaktive Purge-Routine. Sie liest und löscht ausschließlich `messages`, `memory_staging`, `curated_memories`, `learned_facts`, `persistent_rules` und `session_rules` (`src/core/storage/layer2-memory-store.ts:397-411`). Das Wort `reminders` kommt in der gesamten Datei nicht vor. `/deletememory all` fährt ebenfalls nur über `curated_memories` (`router-service.ts:903-906`).

Wirkung: Ein Nutzer hat „Erinnere mich am Freitag an die Blutdruckmessung beim Hausarzt" gespeichert und aktiviert später die Ausschlusskategorie „Gesundheit". Messages, Staging und Erinnerungen mit Gesundheitsbezug werden rückwirkend gelöscht und aus der Live-History gefiltert; der Reminder bleibt und liest den Inhalt am Freitag vor. Aus Nutzersicht ist „lösche alles / vergiss Gesundheitsdaten" nachweislich unvollständig.

### L32-08 — P1 — Der Nicht-Log-Vertrag endet vor dem Executor

**Bestätigt.**

`RoutingService` formuliert den Vertrag explizit und hält ihn ein (`src/services/llm/routing-service.ts:42-45`: „Never log raw model output or action parameters"); `ActionService` loggt ebenfalls nur `action`/`reason`. Der validierte Parameter wird aber unverändert weitergereicht und dort im Klartext protokolliert — `src/main/program-launcher.ts:120-127`:

```ts
console.log(
  `[ProgramLauncher] query=${JSON.stringify(safeQuery)} programs=${programs.length} → ${match.kind}` +
    (match.kind === 'hit' ? ` (${displayProgramName(match.program.name)}, type=${match.program.type}, path=${JSON.stringify(match.program.path)})` : ''),
);
```

`sanitizeLauncherText` (`:66-73`) entfernt nur Steuerzeichen und kürzt auf 100 Zeichen — es ist keine Redaktion. Weitere Fundstellen: `:174-177` (AUMID), `:237` (voller Pfad bei Spawn-Fehler).

Zweite Stelle derselben Vertragslücke im Renderer: `src/renderer/dashboard/dashboard.ts:351`, `:375`, `:379` geben mit `console.warn(..., data)` das komplette Ereignis inklusive `data.text` beziehungsweise `data.fullText` aus.

Wirkung: In einem `/anonymous`-Abschnitt wird der Turn korrekt nicht persistiert, der ausgewählte Programmname samt Pfad landet aber in Prozess-Stdout und damit in Terminal-Mitschnitten, Electron-Logdateien und jedem Diagnosemitschnitt. Der Layer-2-Plan nennt „Suchbegriffe, Programmnamen" wörtlich als Gegenstand dieses Vertrags. Es existiert kein Test für das Logverhalten des Launchers.

*Einschränkung meinerseits:* Der Parameter ist der Programmname aus dem Modelloutput, nicht die vollständige Nutzeräußerung — der Leak ist enger, als die Domänenmeldung ihn beschrieben hat, aber real.

### L32-09 — P1 — Die Reminder-Fälligkeit verliert Eingabemodus und Privatkontext

**Bestätigt.**

Der Bus-Vertrag sieht die Felder vor — `src/core/bus-events.ts:70`: `'action:notify': { …; originMode?: TurnMode; privateContext?: boolean }`. Der einzige Reminder-Emitter füllt sie nie (`src/main.ts:302-307`), und `CreateReminderInput`/`ReminderStore` besitzen die Felder gar nicht erst, die Herkunft wird also schon bei der Erzeugung verworfen.

Der Router ersetzt die fehlende Herkunft durch die jeweils **lautere und öffentlichere** Annahme (`router-service.ts:467-469`):

```ts
msg.data.kind === 'timer' ? 'voice' : msg.data.originMode ?? 'voice',
msg.data.privateContext ?? false,
```

und spricht daher immer laut (`:513`). Für Timer ist genau diese Unterscheidung implementiert und durch REM-A05 abgesichert — dort wird aber nur das *späte Ergebnis der Erstellung* korreliert (`action-service.ts:275-282`), nicht die Fälligkeit.

Wirkung: Ein im Chat oder im Anonymous-Abschnitt angelegter Reminder wird zur Fälligkeit hörbar vorgelesen. Fail-open statt fail-closed.

### L32-10 — P1 — Recall liefert widersprechende Erinnerungen ohne Aktualitätssignal

**Bestätigt.**

`retrieveStartContext` serialisiert je Treffer nur `id`, `kind` und `content` (`router-service.ts:1821-1825`). `created_at` existiert auf der Zeile (`layer2-memory-store.ts:37`) und wird in `/showcontext` sogar angezeigt, aber bewusst nicht in die Recall-Payload übernommen. Die Rangfolge entscheidet ausschließlich Token-Overlap (`:1808`), Aktualität nur als Tie-Break.

Auf der Schreibseite existiert kein Supersede- oder Dedup-Schritt: `rememberExplicit()` ist ein reines `insert` ohne Inhaltsvergleich (`layer2-memory-store.ts:346-361`), `completeMemoryStaging` dedupliziert nur über `source_staging_id`, und der Kurator sieht ausschließlich `job.source_content` — er kennt den bestehenden Erinnerungsbestand strukturell nicht und kann daher weder widersprechen noch ersetzen.

Wirkung: Gespeichert ist „Der User trinkt seinen Kaffee morgens immer schwarz ohne Zucker" (id 4). Später „Merk dir: Ich trinke Kaffee jetzt mit Hafermilch." → id 11, id 4 bleibt. Auf „Wie trinke ich morgens meinen Kaffee?" erhält id 4 den Score 3 (`morgens` zählt als langer Token doppelt), id 11 nur 1. Die **veraltete** Erinnerung steht an erster Stelle, beide werden als gleichwertig injiziert.

Abgrenzung: Das ist nicht L3-A04 (Evaluator-Kreislauf) und nicht der Layer-2-Punkt „keine Pflegewarteschlange" — Warteschlange und Provenienz existieren. Es fehlt ausschließlich die Layer-3-seitige Aktualitäts- und Ersetzungsentscheidung.

### L32-11 — P2 — Die Bestätigungsstufe `minimal` bestätigt faktisch nie etwas

**Bestätigt und empirisch reproduziert.** Gegen `evaluateActionPolicy` aus dem Build, über alle 17 Actions:

```
minimal   | confirm-Actions: KEINE       | cancel_reminder:all -> allow
standard  | confirm-Actions: lock_screen | cancel_reminder:all -> confirm
maximal   | confirm-Actions: 15 von 17   | cancel_reminder:all -> confirm
```

Grund: Keine Action trägt `risk: 'critical'`, `mayCostMoney` oder `externalCommitment`; die einzige mit `dataDisclosure !== 'none'` (`web_search`) schließt vorher über `persistentGrant` kurz. Die Risiko-Eskalation für `cancel_reminder:all` erzeugt nur `sensitive`, was `minimal` per Definition nicht erzwingt. Der `ActionConfirmationGate` ist auf dieser Stufe vollständig inert.

UI-Zusage: „Minimal — nur bei kritischen Aktionen (bezahlen, löschen, buchen)" (`src/renderer/wizard/steps/step-trust.ts:140`). Die Kategorie „löschen" existiert im Produkt (`cancel_reminder:all`), erreicht auf dieser Stufe aber nie eine Rückfrage.

Der Layer-2-Audit-Punkt 20 ist damit zur Hälfte geschlossen: `standard` und `maximal` sind jetzt materiell unterscheidbar, `minimal` ist von „nie bestätigen" nicht unterscheidbar. P2, weil kein unautorisierter Effekt entsteht — die Ausführung entspricht der ausdrücklichen, geerdeten Nutzeraufforderung; verletzt ist die zugesagte Sicherheitsnetz-Eigenschaft.

### L32-12 — P2 — Der Recall-Block ist längenungebunden und alles-oder-nichts

**Bestätigt.** In den Domänen A und E unabhängig gefunden.

`retrieveStartContext` packt Header und alle bis zu fünf Treffer in **eine einzige** System-Nachricht (`router-service.ts:1817-1827`). Kein `sanitizePromptField`, kein Längenlimit — anders als bei jedem Config-Block (200 Zeichen/Feld, 20 Einträge). Der Speicherpfad begrenzt ebenfalls nicht: `rememberExplicit` nimmt den Inhalt ungeprüft, Quelle ist `/remember <bis 4.000 Zeichen>`. Nur der Curator-Pfad ist auf 2.000 Zeichen begrenzt.

In `buildContextWindow` wird der vorgeframte Block als eine unteilbare Gruppe behandelt (`context-window.ts:74-78`, `:153-160`), und `keepNewestTurns` bricht beim ersten nicht passenden Element ab — alles oder nichts, ohne Teilübernahme und ohne Meldung.

Wirkung: Eine einzige lange Erinnerung genügt. Teilt sie einen Query-Token, kommt sie in `ranked`, der gemeinsame Block überschreitet das Budget, und **alle** Treffer fallen weg — auch kurze, hochrelevante. `/showcontext` zeigt sie weiterhin an. Zusammen mit L32-02 heißt das: Der Recall ist unter Default-Bedingungen doppelt gefährdet.

### L32-13 — P2 — `cancel_reminder:id=N` ist allein durch das Vorkommen der Ziffer gegroundet

**Bestätigt und empirisch reproduziert.**

`src/services/actions/reminder-grounding.ts:255-257` prüft für `kind === 'id'` nur `new RegExp('(?:^|\\D)' + id + '(?=$|\\D)')`. Gemessen:

```
"Lösche die Erinnerung um 3 Uhr"              id=3 -> true
"Ich habe 5 Erinnerungen, lösch die letzte"   id=5 -> true
"Lösch die Erinnerung an den Arzt"            id=7 -> false
```

Im Router ist das die Fallback-Alternative neben dem korrelierten Auswahlkontext (`router-service.ts:1470-1479`); `parseCancelReminderParam` akzeptiert `id=` aus beliebigem Modelloutput. Die Tests decken ausschließlich den Follow-up-Pfad ab.

Wirkung: Ohne offenen Auswahlkontext sagt der Nutzer „Lösche die Erinnerung um 3 Uhr". Gibt das Routing-Modell `[ACTION:cancel_reminder:id=3]` aus, gilt der Selektor als gegroundet — gelöscht wird Reminder #3, eine andere Erinnerung. Der Bestätigungs-Gate greift nicht, da nur `all` als `sensitive` eingestuft ist.

P2 statt P1, weil der Routing-Prompt `id=` nicht lehrt (`routing-prompt.ts:41` deklariert nur `all`, `text`, `at`) — das Muster ist off-contract, aber nicht verboten und wird von der Parameterebene akzeptiert. Für `all`, `text` und `at` ist die Herkunftsprüfung semantisch, für `id` degeneriert sie zur Ziffernsuche.

### L32-14 — P2 — Interner Expansions-Kittext gelangt wörtlich ins kuratierte Gedächtnis

**Bestätigt und empirisch reproduziert.**

`slash-command-resolver.ts:79` verkettet: `` `${prompt}\nZusätzliche Argumente des Nutzers: ${args}` ``. Dieser String ist `effectiveText`, und `runTurn` prüft ihn deterministisch gegen `EXPLICIT_REMEMBER_PATTERN`. Reproduziert mit Makro `/notiz` → Prompt „Merke dir folgende Notiz":

```
effectiveText: "Merke dir folgende Notiz\nZusätzliche Argumente des Nutzers: Kunde Meyer zahlt erst im Oktober"
gespeichert:   "folgende Notiz\nZusätzliche Argumente des Nutzers: Kunde Meyer zahlt erst im Oktober"
```

Der Makro-Präfix wird vom Merk-Muster abgeschnitten, der Rest samt internem Glue-Literal wandert unverändert in `curated_memories` — und von dort über `retrieveStartContext` zurück in den Worker-Prompt sowie in `/showcontext` und `/exportmemory`. Der Expansionsvertrag besitzt keine Struktur- oder Trennmarkierung, an der deterministische Konsumenten Makrotext von Argumenten unterscheiden könnten.

### L32-15 — P2 — Fremdinhalte erreichen den Prompt ohne Trust-Anweisung

**Bestätigt.**

`serializePromptData` erzeugt bewusst nur die Datenzeile; die Vertrauensanweisung bleibt laut eigener Dokumentation außerhalb (`src/services/llm/prompt-data.ts:24-33`). Für jeden Config-Block wird sie geliefert (`prompt-layers.ts:180`, `:195`, `:230`), für den Recall-Block ebenfalls (`START_CONTEXT_HEADER`). Für `external_search_data` und `local_program_data` existiert repoweit **keine** solche Zeile — verifiziert per Volltextsuche.

Die Wirkung ist heute auf Prosa begrenzt: Worker-Output wird nirgends auf Tags geparst, externe Turns sind transient und erreichen weder Persistenz noch Kurator, und die Snippets sind vorher scharf saniert. Der eingeplante Schutzmechanismus fehlt aber genau dort, wo der Inhalt tatsächlich fremd ist — und ist genau dort vorhanden, wo er es nicht ist.

### L32-16 — P2 — Kuratierte Erinnerungen verweisen auf einen nie persistierten Quell-Turn

**Bestätigt.**

Jeder explizite Merk-Turn setzt `suppressHistory` (`router-service.ts:653`, `:1022`), und `commitTurn` bricht dann vor `persistTurn` ab (`:1886-1889`). Die Erinnerung wird trotzdem mit `sourceConversationId`/`sourceTurnId` geschrieben und die Herkunft als prüfbar ausgegeben (`:836-838`: „Quelle: Session X, Turn Y").

Wirkung: `/showcontext` und `/exportmemory` weisen Session und Turn aus, in der Conversation-Persistenz existiert dieser Turn nicht. Bei einer Erinnerung aus einer Custom-Command-Expansion (L32-14) ist zusätzlich weder Makroname noch Originaltext irgendwo gespeichert.

Mildernd, von mir gegengeprüft: Der retroaktive Purge fällt dadurch nicht aus — kuratierte Erinnerungen werden zusätzlich über ihren eigenen Inhalt geprüft (`layer2-memory-store.ts:467`). Der Schaden ist auf die Auditierbarkeit begrenzt, nicht auf die Löschbarkeit.

### L32-17 — P2 — Fail-open Defaults für Berechtigungseingaben und ein toter zweiter Policy-Einstiegspunkt

**Bestätigt, latent.**

`action-policy.ts:65-69`: `webAccessAllowed` ist optional, und nur der explizite Wert `false` sperrt — `undefined` erlaubt. `action-service.ts:184-186` fällt bei fehlender Verdrahtung auf permissive Werte zurück (`'standard'`, `'specific-folders'`, `true`). `action-schemas.ts:104-109` exportiert einen zweiten, als „die Bestätigungsentscheidung" dokumentierten Einstiegspunkt, der `webAccessAllowed` und `param` weglässt und `fileAccess` hart verdrahtet — projektweit unbenutzt.

Kein aktiver Pfad: Produktiv sind alle drei Getter korrekt an `parsedConfig.trust` gebunden (`src/main.ts:322-325`). Der Schaden entsteht beim nächsten Aufrufer — `requiresActionConfirmation('standard', 'cancel_reminder')` liefert `false`, während die Live-Policy mit `param: 'all'` `confirm` liefert. Das ist exakt die Drift-Klasse aus L3-B02, diesmal als API im Code hinterlegt statt als Kopie im Router.

Für den *Action-Namen* ist die Grenze fail-closed und compile-time-vollständig. Für die *Berechtigungseingaben* ist sie es nicht: Eine fehlende Eingabe wird als „erlaubt" interpretiert statt als „unbekannt → gesperrt", und der Typ macht das Weglassen syntaktisch legal.

### L32-18 — P2 — `persistMessage` ist ein Persistenzpfad ohne Layer-2-Gate

**Bestätigt, derzeit unerreichbar.**

`publishAssistantResponse` enthält einen Zweig, der bei fehlendem Turn-Draft direkt in die Live-History pusht und `persistMessage` aufruft (`router-service.ts:1306-1318`). Der Aufruf umgeht `commitTurn` → `mustKeepTurnTransient` → `persistTurn` vollständig: keine `memoryAllowed`-Prüfung, keine Exclusions, keine Secret-Matrix, keine Inkognito-Prüfung — und die History-Zeile erhält `privateContext: false` fest verdrahtet.

Erreichbarkeit heute: `turnDrafts` wird in `executeTurn` für jeden Turn gesetzt, bevor irgendein `emitAssistantResponse` läuft; alle Aufrufstellen liegen innerhalb dieses Scopes und werden awaitet. Der einzige Emitter ohne Draft (`emitSystemNotification`) übergibt `recordInHistory: false`. Der Zweig ist damit tot — von mir gegengeprüft.

Er wird lebendig, sobald ein Layer-3-Feature eine Assistant-Ausgabe außerhalb eines Turn-Drafts erzeugt. Genau das sieht `filler-phrases.ts:84-88` mit der Kategorie `taskCompleted` bereits vor, und genau das brauchen der geplante Planner und ein Backend-Executor (L3-A04/L3-A06). Der Kommentar über `emitAssistantResponse` (`:1257-1259`) sagt „never a raw insert" — faktisch ist `persistMessage` der Raw Insert.

### L32-19 — P2 — `confirmationLevel` wird an den Worker geliefert, der nicht handeln kann

**Plausibel, nicht abschließend beweisbar.**

`prompt-layers.ts:58-62` schreibt die Berechtigungssemantik als Handlungsanweisung in den Systemprompt („Only ask before critical actions… Act independently otherwise."). Dieser Prompt geht ausschließlich an den Worker (`router-service.ts:1195`). Der Worker besitzt kein Tool-Interface; jede Ausführung und jede Bestätigung entsteht deterministisch im Router. Analog verspricht `buildCoreUser` dem Worker „When a query matches a preferred source description, prefer its URL." (`:147`), obwohl der Worker keine URL öffnen kann.

Der Vertragsbruch — Layer-2-Berechtigungstext an eine Komponente ohne Handlungsfähigkeit — ist im Code eindeutig. Die konkrete Folge (der Worker sagt eine Ausführung zu, die nie stattfindet) ist modellabhängig und nicht deterministisch belegbar. Deshalb plausibel statt bestätigt.

### L32-20 — P2 — Aus Recall abgeleitete Antworten werden erneut kuratiert

**Plausibel.**

`draft.recalledContents` (`router-service.ts:1788-1791`) wird ausschließlich für den Policy-Wechsel-Abbruch gelesen und nicht in die Transienz-Entscheidung eingerechnet (`:1896`). Ein Turn, dessen Antwort ausschließlich aus recalltem Gedächtnis stammt, ist damit nicht transient, wird persistiert und erneut kuratiert. Der Kurator kennt den Bestand nicht (siehe L32-10) und kann das Echo nicht als bekannt erkennen.

Folge: Aus id 3 „Der User mag keinen Koriander" entsteht id 9 mit neuer Provenienz. `/forget 3` entfernt nur die Erstfassung; id 9 überlebt und wird weiter recalled. Als plausibel markiert, weil Code-Pfad und fehlende Schranke verifiziert sind, die Extraktion durch den Kurator aber modellabhängig ist.

---

## 4. Geprüft und tragfähig befunden

Diese Punkte wurden aktiv gesucht und **nicht** als Fehler bestätigt. Sie dokumentieren die Abdeckung des Audits.

**Bestätigungs- und Berechtigungsvertrag**

- `action:request` wird ausschließlich im Router emittiert; `ActionService.execute` ist der einzige Ausführungsweg. `search.*`, `system.*`, `spotify.*`, `media.*` und `reminders.*` haben außerhalb davon keinen Aufrufer.
- Der Router-Spiegel driftet nicht: Beide Seiten rufen dieselbe `evaluateActionPolicy` mit denselben vier Feldern und demselben kanonisierten Parameter auf und lesen `parsedConfig.trust` zum Entscheidungszeitpunkt. `ipc-config.ts:126` ersetzt `parsedConfig` als Ganzes — keine Stale-Trust-Kopie.
- Eine Ankündigung erfolgt nie vor der Policy: `getActionAcknowledgement` wird zwar früher berechnet, aber erst nach `deny`/`prepare_only`/`confirm` ausgegeben.
- Trust-Wechsel während eines Turns wirkt immer in die strengere Richtung; `ipc-config.ts:159-163` leert bei jeder Trust-Änderung die offenen Bestätigungen.
- `consume` bindet ID, Vorschlags-Turn, Bestätigungs-Turn, Action, Param und `sourceRequestId` exakt. Replay und Einzel→`all`-Eskalation sind ausgeschlossen; `restorePending` kann eine bereits konsumierte Zustimmung nicht wiederbeleben, weil der Consume synchron im `bus.emit` läuft.
- Keine Action ohne Policy-Eintrag: `ACTION_PERMISSION_METADATA` ist ein compile-time-vollständiges `Record<ActionName, …>`; unbekannte Namen werden zweimal abgewiesen.
- `show_browser` bekommt seine URL nie vom Modell, sondern ausschließlich aus der über `sourceRequestId` referenzierten Session — ohne Session fail-closed.
- Ein breiter `text=`-Selektor kann keine Massenlöschung auslösen: Bei mehr als einem Treffer liefert der ReminderService `ambiguous` und löscht nichts.

**Custom Commands und Provenienz**

- Built-in-Shadowing ist dreifach ausgeschlossen (Resolver-Reihenfolge, `removeReservedCustomCommandCollisions` beim Boot und bei jedem Config-Save, Settings-UI).
- Keine Rekursion der Expansion: `resolveSlashCommand` läuft genau einmal, `expandedText` wird nie erneut aufgelöst. Ein Prompt `"/anonymous"` erreicht den Router nur als gewöhnlicher Nutzertext.
- Ein Makro kann keine Bestätigung erschleichen: Der Confirm-Matcher bekommt bewusst `normalizedText`, nicht `effectiveText`; `/ja`, `/ok`, `/bestätige` gelten nicht als Zustimmung. Der einzige Restpfad ist L32-05.
- Die Grounding-Quelle ist durchgängig `effectiveText` — Timer, Reminder-Set/Cancel, Misrouting-Korrekturen, Auswahl-Follow-up, MediaContext, Profil-Shortcut, Browser-Follow-up, Worker- und Retrieval-Query. Projektweiter Grep bestätigt: `originalText` erscheint produktiv nur an drei Stellen. L3-B03/L3-C04 halten.
- Der Persistenz-/Redaktions-Split ist dicht: `mustKeepTurnTransient` bewertet Originaltext **und** Expansion **und** alle Assistant-Teile gemeinsam.
- Der Kurator sieht die Expansion nie — Staging-Quelle ist ausschließlich `persistedUser` plus Assistant-Text.

**Kontext, Recall und Persistenz**

- Prompt-Grammatik ist nicht ausbrechbar: `serializePromptData` JSON-kodiert alle Werte, `sanitizePromptField` entfernt Zeilenumbrüche, U+2028/29 und `<>`.
- Untrusted Web-Content erreicht den Prompt nicht roh: Der LLM-Summarizer ist produktiv abgeschaltet; es geht nur `buildSafeSearchSummary` mit zitierten, gekürzten Titeln raus.
- Snippets und Fremdtext können Routing oder Action-Wahl nicht beeinflussen: Der Router bekommt ausschließlich Systemuhr und `effectiveText`, Worker-Output wird nirgends auf Tags geparst.
- Systemprompt und aktuelle Nutzernachricht werden nie still gekürzt — der Fail-closed-`RangeError` ist der einzige Ausgang (die Fehlerattribution ist L32-03).
- Trimm-Reihenfolge und Turn-Integrität stimmen: Start-Context fällt vor Live-History, Assistant-Nachrichten ohne User-Nachricht werden nie behalten.
- Live-History ist auf 24 Turns begrenzt, mit Turn-Grenzen-Erkennung statt Nachrichtenzählung.
- `commitTurn` prüft die Policy live nach und vereinigt Snapshot- und Live-Exclusions — fail-closed. Eine Deaktivierung des Gedächtnisses mitten in einem langen Turn kann nicht fail-open persistieren.
- Turns sind strikt serialisiert; `incognitoActive` wird nur in `toggleIncognito` gesetzt, ein Moduswechsel mitten in einem fremden Turn ist strukturell ausgeschlossen.
- `toggleIncognito` räumt den flüchtigen Entscheidungszustand in beide Richtungen: MediaContext, Reminder-Auswahl, offene Bestätigungen, private Suchsessions, Inkognito-History. L3-C02 hält.
- MediaContext speichert nur ein Action-Enum plus Zeitstempel, kein Medientitel. Filler-State ist ein Ringpuffer statischer Phrasen. `resolveProfileResponse` ist zustandslos.
- Der Sensitive-Guard hält über den Streaming-Pfad: Bei erkannten Literalen wird das Chunk-Streaming unterdrückt und nur der redigierte Volltext ausgegeben.
- Kein fremdautorisierter Inhalt erreicht den Kurator: `web_search`/`show_browser` sind `externalData`, `open_program`/`list_reminders`/`cancel_reminder` sind `localData`, beide damit transient. Insbesondere fließt keine OS-Media-Session-Metadata in eine Antwort.
- Commit-Grenze: `commitStarted` verhindert Doppel-Commit, Fehler-Turns löschen den Draft ohne Persistenz, ein abgebrochener Turn behält nur den User-Teil im Live-Kontext, teilgestreamte Antworten erreichen `recordAssistantOutput` nie.
- System-Turns (Timer-/Reminder-Fälligkeit) laufen ohne Draft und mit `recordInHistory: false` — weder persistiert noch gestaged. REM-A06 hält.
- Logging in `RoutingService`, `ActionService`, `MemoryCurator`, `SearchService`, Ollama-Provider und OAuth protokolliert nur Struktur. Der Leak liegt eine Ebene tiefer (L32-08).
- Timer sind reiner RAM-Zustand — kein Persistenz- oder Retention-Problem.
- `/deletememory all` läuft zwar an ActionPolicy und Gate vorbei, besitzt aber einen eigenen, an einen ID-Snapshot gebundenen Zwei-Schritt-Vertrag mit CAS-Prüfung und wörtlicher Bestätigung; durch eine LLM- oder Fremdäußerung nicht auslösbar.

---

## 5. Einordnung

Die schweren Befunde bilden zwei Muster, kein Streufeld:

**Muster 1 — die zweite persistente Domäne.** L32-01, L32-07, L32-09 und teilweise L32-13 haben dieselbe Wurzel: `reminders` ist eine Nutzerdaten-Domäne, die eingeführt wurde, ohne sie am Layer-2-Vertrag anzumelden. Persistenz-Gate, Secret-Matrix, Inkognito, Retention und Provenienz sind alle vorhanden und funktionieren — für `messages`, `memory_staging` und `curated_memories`. Für `reminders` gilt keiner davon. Das ist kein Einzelfehler, sondern eine fehlende Registrierung.

**Muster 2 — die unauditierte Budgetachse.** L32-02, L32-03, L32-04 und L32-12 zeigen, dass die Kontextbudgetrechnung selbst nie Gegenstand eines Layer-Audits war. Sie ist bewusst konservativ ausgelegt (`CHARS_PER_TOKEN = 1` überschätzt um Faktor 3–4), und genau diese Sicherheitsmarge kippt bei Auslieferungsdefaults in einen stillen Kontextverlust — beziehungsweise bei etwas mehr Konfiguration in einen harten Turn-Abbruch mit falsch benannter Ursache. Der Router hat gar keine Budgetrechnung und ist inzwischen über sein eigenes Fenster hinausgewachsen.

Beide Muster sind erst durch die letzten drei Merges entstanden (Timer V2 #33, Reminders #34, #35). Die vorangegangene Auditserie konnte sie strukturell nicht sehen, weil sie entlang der Conversation-/Memory-Achse geführt wurde.

Die beiden Muster sind im Fix gemeinsam geschlossen worden: Reminder sind jetzt am Layer-2-Vertrag registriert, und Worker wie Router besitzen eine explizite Budgetgrenze. Die nächste Arbeit darf diese Korrekturen nicht wieder als offene Layer-3-Architekturpunkte zählen.

## 6. Prüfstatus dieses Dokuments

- Jeder der 23 Rohbefunde wurde erneut am aktuellen Code nach PR #37 geprüft; drei Doppelungen bleiben zu 20 Ursachen zusammengeführt.
- 18 Ursachen sind bestätigt. Sie wurden domänenweise korrigiert und erhalten direkte Regressionstests.
- L32-19 und L32-20 bleiben bewusst als plausible Architektur-/Modellrisiken dokumentiert. Ohne reproduzierbaren Effekt wurden sie nicht als erledigte Produktfehler ausgegeben und nicht spekulativ umgebaut.
- L32-08 war enger als zunächst beschrieben: Der Launcher loggte Modelloutput-Programmname beziehungsweise Pfad, nicht die vollständige Nutzeräußerung. Der Nicht-Log-Vertrag ist dennoch jetzt bis Executor und Renderer durchgezogen.
- L32-16 betraf die Auditierbarkeit der Quelle, nicht die Löschbarkeit. Die Quelle wird nun policy-geprüft persistiert; ein Storage-Ausfall bleibt ehrlich degraded statt eine falsche Atomizität vorzutäuschen.
- Fokussierte Abschlussmatrix: 12 relevante Dateien, 350/350 Tests grün. Nach einem unabhängigen Closure-Hinweis wurde die Worst-Case-Reserve für beide Runtime-Trust-Anweisungen zusätzlich zentralisiert und mit der garantierten 512-Token-Nutzereingabe gegengeprüft.
- Vollständige Vitest-Suite: 113 Dateien, 1.630/1.630 Tests grün.
- Main- und Renderer-Typecheck: grün.
- Produktionsbuild: grün.
- `git diff --check`: ohne Fehler.
- Drei unabhängige Read-only-Closure-Reviews haben alle 20 Ursachen erneut gegen Code und Tests geprüft. Die ursprünglichen Verträge der 18 bestätigten Befunde sind geschlossen; L32-10 bleibt bewusst auf das ergänzte Aktualitätssignal begrenzt und L32-16 meldet den nicht atomaren DB-Ausfall ehrlich degraded.
- L32-07 schließt den bestätigten Policy-Purge einschließlich Reminder und Quarantäne. `/deletememory all` löscht weiterhin ausschließlich das semantische Langzeitgedächtnis; geplante Termine ohne ausdrücklichen Löschauftrag einzubeziehen wäre eine separate Produktentscheidung.
- L32-14 entfernt internen Glue-Text aus argumentbehafteten Custom Commands. Ein argumentloses, vom Nutzer selbst konfiguriertes Remember-Makro darf weiterhin seinen konfigurierten Inhalt ausführen und ist kein interner Textleck-Pfad.
- L32-19 und L32-20 bleiben plausible Architektur-/Modellrisiken ohne Bugnachweis und wurden nicht als behobene Produktfehler ausgegeben.
- Eine erneute praktische Windows-/Voice-Abnahme war für diese statischen Datenschutz-, Budget-, Policy- und Migrationsverträge nicht erforderlich; ihr Abschluss ist technisch, nicht als neue praktische Gesamt-Abnahme ausgewiesen.
