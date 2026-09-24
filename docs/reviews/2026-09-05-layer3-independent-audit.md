# Unabhängiges Layer-3-Audit – Grundplatte, Provider-Hub und Adapter

## Korrekturlauf und Kontrollaudit – 05./06.09.2026

Basis: `dev`, `0d6718d`. Korrekturbranch: `fix/layer3-provider-audit`. Der historische Erstbefund weiter unten beschreibt den unveränderten Ausgangsstand; seine Fehler- und Testergebnisse sind keine Aussage über den aktuellen Korrekturstand.

**Korrekturlauf abgeschlossen:** Alle bestätigten Ursachen behoben; zwei Kontrollrunden, abschließend 2.416 Tests sowie beide Typechecks und Produktionsbuild bestanden. Die praktische Live-Abnahme bleibt separat.

Der anschließende Auftrag erlaubt die Fehlerkorrektur und höchstens fünf unabhängige Kontrollrunden. **Abbruch bei weniger als drei bestätigten P0/P1/P2-Ursachen**, unabhängig von der Zahl der P3/P4-Befunde. Varianten derselben Ursache zählen einmal; bestätigte Restlücken werden beim Rundenergebnis mitgezählt.

| Kontrollrunde | P0 | P1 | P2 | Ergebnis |
| --- | ---: | ---: | ---: | --- |
| 1, einschließlich anschließender Fixverifikation | 0 | 0 | 3 | Zwei Restvarianten von N06/N07; ein zusätzlich im notwendigen Recovery-Regressionstest bestätigter Fehler. Alle drei korrigiert; deshalb Runde 2. |
| 2 | 0 | 0 | 1 | Neue Ursache: absolute Lautstärke verwirft Zeit-/Ausführungsbedingungen. Schwelle unterschritten; Korrektur und Abschlussprüfungen, keine Runde 3. |

Die Prüfer wechselten ihre Bereiche: Der Adapter-Implementierer prüfte Cloud-Text/Main/Router, der Grundplatten-Implementierer die Adapter/Health/Recherche. Der Hauptagent prüfte die Grundplatte. Während der Runde blieb der Produktivstand eingefroren. Die Prüfung umfasste zusätzliche adversariale Fälle außerhalb der ursprünglichen Reproduktionen.

### Korrekturen

| Befund | Änderung und Nachweis |
| --- | --- |
| N01 | Nativen Modellbezeichner `perplexity/sonar` gezielt erlaubt; echter Durchlauf über Health, Hub, verschlüsselte Credentials, Persistenz, Zustimmung und Task-Metadaten. |
| N02 | OpenAI- und Perplexity-Transporte setzen ausgewählte Authentifizierung und festes Anbieterziel selbst; fremde SDK-Umgebungsheader können Konto/Projekt nicht ersetzen. OpenAI-Health nutzt dieselbe Factory. |
| N03 | Ergebnisstatus bis zum Plan-Evaluator erhalten. `failed`, `incomplete` und `refused` sperren abhängige Aktionen; eine ausdrücklich unabhängige Aktion bleibt ausführbar. Keine automatische zweite Cloud-Anfrage. |
| N04 | Aktive Cloud-Text-Anfragen werden bei Schlüsselwechsel, Verbindungslöschung und Shutdown abgebrochen und begrenzt geleert. Alte Auswahl, Credentials und späte Deltas werden verworfen; Nutzung wird einmal erfasst. |
| N05 | Eigene OpenAI-Stream-Gesamtdeadline mit abbrechbarem Iterator. Geprüft bei ausbleibendem ersten Event und nach einer Teilantwort. |
| N06 | Text-Refusal-Events und terminale Inhalte werden sichtbar und als `refused` verarbeitet. Die Kontrollrunde fand zusätzlich die verbliebene Research-Variante, siehe unten. |
| N07 | Absolute Lautstärke bindet den Wert an `auf` und optional den Ausgangswert an `von`. Die Kontrollrunde fand zusätzlich die verbliebene relative Variante, siehe unten. |
| N08 | Lokaler Systemprompt und Kontextfenster werden nur für lokale Generierung aufgebaut. Warmer Cloud-Pfad mit 4.000-Zeichen-Eingabe und lokalem `num_ctx=4096` besteht; private Anfragen bleiben lokal. |
| E01 | Profil-Shortcut nimmt nur vollständige Einzelanfragen an. Kombinationen mit Komma oder `&` erreichen den Router und führen den angeforderten Timer aus. |

### Befunde aus Kontrollrunde 1 und ihrer Fixverifikation

**R1-01, P2, Variante von N06:** OpenAI Deep Research übersprang `ResponseOutputRefusal` in `responseResult`. Der echte Spezialisten-Runtime-/Store-Durchlauf endete als `completed` mit leerem Ergebnis. Refusal-Inhalte müssen auch dort sichtbar bleiben und fachlich als fehlgeschlagene Recherche mit erhaltenen Nutzungsdaten enden.

**R1-02, P2, Variante von N07:** `Senke Spotify auf 20 Prozent` ließ sich als `spotify_volume_adjust:-20` kompilieren; `Senke Spotify von 80 auf 20 Prozent` sogar als `-80`. Beide erhielten `semantic_grounding`. Die absolute Zielangabe legitimiert keine relative Änderung. Diese beiden Reproduktionen zählen als eine verbleibende Ursache.

Beide Restlücken wurden geschlossen. Recherche-Ablehnungen liefern jetzt sichtbaren, begrenzten Text sowie `failed` / `research_refused` und erhaltene Nutzungsdaten. Relative Lautstärke verlangt eine eindeutige Richtung und bei Zahlen eine ausdrückliche `um`-Angabe; absolute Ziele, Dezimalwerte, weitere Zahlen und konkurrierende Richtungen werden verweigert. Unterstützte Standardänderungen und `etwas leiser/lauter` bleiben erhalten.

**R1-03, P2, neue Ursache:** Der dafür ergänzte echte Research-Recovery-Test deckte auf, dass `SpecialistRuntimeService.reconcile` die Methode `adapter.retrieve` vom Objekt löste und ohne ihren Receiver aufrief. Klassenadapter verloren `this`; ein bereits angenommener Auftrag ließ sich nicht regulär wiederherstellen. Die minimale Korrektur ruft `retrieve.call(adapter, ...)` auf. Der zuvor rote Recovery-Test besteht. Diese dritte Ursache wurde noch vor Abschluss berücksichtigt; die zwischenzeitlich angekündigte Beendigung nach Runde 1 wurde deshalb verworfen.

### Befund aus Kontrollrunde 2

**R2-01, P2, neue Ursache:** `Stelle die Systemlautstärke erst morgen auf 20 Prozent und öffne Spotify` erhielt für den ersten Schritt `semantic_grounding`. Der echte Plan-Compiler, `RouterActionFlow` und `ActionService` führten sofort `setVolume(20)` auf dem simulierten OS-Adapter aus. Auch `Stelle die Systemlautstärke auf 20 Prozent, wenn Spotify läuft` wurde akzeptiert. Die Zahlenrolle war korrekt, aber die absolute Lautstärkeprüfung ignorierte nicht unterstützte Zeit-/Bedingungszusätze. Beide Fälle zählen als eine Ursache fehlender vollständiger Klauselsemantik.

Auch R2-01 ist korrigiert: Die absolute Lautstärkeprüfung konsumiert die gesamte unterstützte Klausel für System beziehungsweise Spotify. Zeitangaben, Bedingungen und weitere Ziele erhalten keine semantische Freigabe. Die 178 dauerhaften Grounding-/Compiler-Tests und alle zehn Root-Probes bestehen. Anschließende Regressionstests sind keine weitere unabhängige Audit-Runde.

### Prüfprotokoll des eingefrorenen Initialfixstands

- Vollständige Suite: **182 Dateien bestanden, eine übersprungen; 2.369 Tests bestanden, einer übersprungen**.
- Beide Typechecks bestanden.
- Unabhängige Kontrollprobes: vier Grundplatten-, drei Adapter- und vier Cloud/Main/Router-Tests. Drei Tests reproduzieren die beiden oben beschriebenen Restursachen; die übrigen bestätigen korrektes Verhalten.
- Zusätzlich bestanden 58 reguläre Adapter-/Health-Tests und 69 Cloud-/Accounting-/Router-/Privacy-/Lifecycle-Tests während der unabhängigen Prüfung.
- Keine echten Provider-Anfragen, bezahlten Generierungen, Systemlautstärkeänderungen oder realen Timer. Externe SDK-Transporte und äußere Aktionen waren simuliert; lokale Stores, Runtime, Router und Plan-Compiler liefen produktiv.

### Prüfprotokoll von Kontrollrunde 2

- Vollständige Suite am eingefrorenen Stand: **183 Dateien bestanden, eine übersprungen; 2.401 Tests bestanden, einer übersprungen**. Beide Typechecks bestanden.
- Grundplatte: acht zusätzliche Sollverhalten-Probes bestanden, zwei rote Probes belegten R2-01. Ein weiterer Durchlauf bestätigte den tatsächlichen Aufruf des simulierten OS-Adapters.
- Adapter/Health/Research: 63 reguläre Tests und sechs unabhängige SDK-/Runtime-/Store-Probes bestanden. OpenAI und Perplexity wurden bei laufendem Auftrag, gespeichertem Abbruch und abgelaufener Deadline geprüft.
- Cloud/Main/Router/Runtime: sechs weitere unabhängige Recovery-Probes mit echten OpenAI- und Perplexity-Adaptern bestanden. Fertige, wartende und abzubrechende Aufträge behalten Remote-ID und ursprüngliche Credential-Generation; Wiederaufnahme erzeugt keinen neuen bezahlten Auftrag und nur einen terminalen Usage-Eintrag.
- N06-Research-Korrektur und Receiver-Korrektur wurden somit von anderen Prüfern unabhängig kontrolliert. Keine weitere P0/P1/P2-Ursache in diesen Bereichen bestätigt.

### Abschlussstand

- Alle acht ursprünglichen neuen Ursachen, E01 sowie die zusätzlich gefundenen Recovery- und Zeitbedingungsfehler sind korrigiert. Keine bestätigte Ursache aus diesem Lauf bleibt offen.
- Audit-Zyklus nach **zwei Kontrollrunden** beendet. Runde 2 blieb mit einem P2 unter der festgelegten Schwelle; keine dritte Runde. Der letzte Fix wurde gezielt verifiziert, nicht in einer zusätzlichen vollständigen unabhängigen Runde auditiert.
- Letzte vollständige Suite: **183 Dateien bestanden, eine übersprungen; 2.416 Tests bestanden, einer übersprungen**.
- Beide abschließenden Typechecks und der vollständige Produktionsbuild bestanden. SQLite wurde nach allen Node-Tests wieder für Electron hergestellt; `git diff --check` bestand ebenfalls.
- Produktivcode und Regressionstests liegen lokal auf `fix/layer3-provider-audit`; kein Commit, Push oder Merge. Die vier bereits vorhandenen unversionierten Voice-Trainingsdateien wurden nicht verändert.
- Praktische Gesamtfreigabe für Chat, Voice und echte Provider bleibt außerhalb dieses automatisierten Audits. Kein Login und keine kostenpflichtige Generierung ausgeführt.

Wiederholbare dauerhafte Regressionen liegen unter `tests/main/ai-provider-runtime.test.ts`, `tests/services/providers/cloud-text-service.test.ts`, `tests/services/providers/openai/research-refusal.test.ts`, `tests/services/providers/openai/responses-adapters.test.ts`, `tests/services/integrations/ai-provider-perplexity-model.test.ts` und den erweiterten Router-/Grounding-Tests. Die temporären Repros unter `.audit-tmp` dokumentieren teils ausdrücklich historisches Fehlverhalten und sind nach Korrektur nicht durchgängig als grüne Suite gedacht.

## Historisches Erstaudit – Ausgangsstand 05.09.2026

Geprüfter Ausgangsstand: `dev`, `0d6718d` (PRs #49–#58, einschließlich der Änderungen an den gemeinsamen Verträgen). Datum: 05.09.2026, Europe/Berlin.

## Ergebnis

**Nicht zur Gesamtfreigabe geeignet. Acht neue relevante Ursachen: drei P1, fünf P2. Zusätzlich eine bestehende P2-Integrationslücke reproduziert.** Es wurde kein P0 bestätigt. Die Abbruchschwelle von weniger als fünf neuen relevanten Ursachen ist in diesem Lauf nicht erreicht. Dies ist ein Auditbefund, kein durchgeführter Fix- oder Abnahmelauf.

Die Prüfung erfolgte in drei unabhängigen Prüflinien für Grundverträge/Ausführung, Hub/Spezialisten und konkrete Adapter. Zusätzlich wurden die Übergänge Cloud-Text → Router → Plan und die gemeldeten Reproduktionen separat kontrolliert. Bekannte Produktgrenzen und nicht produktiv erreichbare Vertragsprobleme sind nicht als neue Ursachen gezählt.

## Neue bestätigte Befunde

### L3-N01 – P1 – Perplexity kann nicht als Rechercheanbieter konfiguriert werden

- Ursache: `AiRoleBindingSchema.modelId` verbietet `/`; das einzige vom Perplexity-Adapter und seiner Health-Prüfung akzeptierte Modell heißt `perplexity/sonar`.
- Reproduktion mit echter Main-Komposition und echten Hub-/Credential-Stores, ausschließlich externen Health-Zugriffen als Testdouble: Schlüssel speichern erfolgreich, Health `healthy`, dann `replaceBindings(modelId: 'perplexity/sonar')` → `invalid_input`.
- Auswirkung: Der produktive Einstellungs-, IPC- und Routingpfad kann den Adapter nicht aktivieren. Ein kostenpflichtiger Verbindungstest könnte bereits erfolgt sein. Kein bezahlter Test wurde im Audit ausgeführt.
- Stellen: [ai-provider-contract.ts:158](G:/Projects/S-A-R-A-H/src/core/ai-provider-contract.ts:158), [perplexity-common.ts:5](G:/Projects/S-A-R-A-H/src/services/providers/perplexity/perplexity-common.ts:5).
- Korrekturziel: Durchgängig konsistenter Modellbezeichnervertrag; vollständiger Konfigurationsdurchlauf mit dem tatsächlich unterstützten Modell.

### L3-N02 – P1 – SDK-Umgebungsheader können die bestätigte API-Identität ersetzen

- Trigger: `OPENAI_CUSTOM_HEADERS` beziehungsweise `PERPLEXITY_CUSTOM_HEADERS` enthält einen `Authorization`-Header. Bei OpenAI kann zusätzlich `OpenAI-Project` überschrieben werden.
- Reproduktion verwendet die produktiven Client-Factorys und installierten offiziellen SDKs, mit einem Fake-Transport zur Kontrolle der tatsächlichen HTTP-Header. Der ausgewählte Sarah-Key wird durch den synthetischen Host-Key ersetzt. Die OpenAI-Modellprüfung meldet dadurch sogar einen ungültigen gespeicherten Sarah-Key als `healthy`.
- Auswirkung: Die gespeicherte Bestätigung, Credential-Generation und Nutzungszuordnung entsprechen nicht zwingend dem tatsächlich angefragten Konto/Projekt. Die Ursache betrifft beide Provider; sie wird einmal gezählt. Beim derzeit gesperrten Perplexity-Rollenpfad ist bereits die ausdrücklich auslösbare Health-Prüfung betroffen.
- Stellen: [responses-common.ts:7](G:/Projects/S-A-R-A-H/src/services/providers/openai/responses-common.ts:7), [api-key-health-service.ts:74](G:/Projects/S-A-R-A-H/src/services/providers/api-key-health-service.ts:74), [perplexity-common.ts:28](G:/Projects/S-A-R-A-H/src/services/providers/perplexity/perplexity-common.ts:28).
- Versionsbeweis: installiertes `openai` 7.10.0 und `@perplexity-ai/perplexity_ai` 0.38.5, deren Clientcode und tatsächliche SDK-Requests. Anthropic isoliert die Authentifizierungsheader bereits explizit.
- Korrekturziel: Autoritative feste Identitätsheader für Generierung und Health; fremde Host-Header dürfen diese nicht überschreiben.

### L3-N03 – P1 – Fehlgeschlagene Cloud-Antwort entsperrt abhängige Aktionen

- Trigger: `Erkläre Fahrräder und dann stelle einen Timer auf 10 Minuten`; die Cloud-Generierung schlägt ohne Antwort mit `TextGenerationError` fehl.
- Reproduktion über den echten `RouterService`: Ausgabe meldet die unterbrochene externe Antwort, anschließend wird trotzdem `action:request` für `set_timer:10m` ausgelöst. Der Aktionsadapter wurde nur für die Ergebnisrückmeldung simuliert; kein echter Timer wurde angelegt.
- Ursache: `CloudTextGenerator` verliert den strukturierten Erfolgsstatus. `selectCloudText` verwandelt den Fehler in einen normal erfüllten Text-Promise. `runWorkerTextWithFallback` liefert `true`, und `executeAnswer` meldet `succeeded`.
- Auswirkung: Der Evaluator kann einen fehlgeschlagenen Vorgänger nicht erkennen und führt explizit davon abhängige Arbeit aus. Auch unvollständige Antworten verlieren ihren strukturierten Status.
- Stellen: [cloud-text-service.ts:33](G:/Projects/S-A-R-A-H/src/services/providers/cloud-text-service.ts:33), [router-worker-flow.ts:354](G:/Projects/S-A-R-A-H/src/services/llm/router-worker-flow.ts:354).
- Korrekturziel: Normalisierte Ergebniszustände bis zum Plan-Evaluator transportieren; sichtbare Fehlermeldung und erfolgreicher Planschritt getrennt behandeln, ohne kostenpflichtige Wiederholung.

### L3-N04 – P2 – Laufende Cloud-Text-Anfrage überlebt Verbindungslöschung

- Reproduktion über die echte Main-Komposition: Eine gemockte Textgenerierung läuft; `hub.deleteConnection()` liefert `ok`, Verbindung und gespeicherter Schlüssel sind entfernt. Trotzdem bleibt das Request-Signal unabgebrochen, der Adapter-Resolver liefert den alten Schlüssel, und späte Deltas werden veröffentlicht.
- Ursache: `beforeConnectionChange` erfasst ausschließlich `SpecialistRuntime.cancelConnection`; Cloud-Text läuft außerhalb dieser Verwaltung und hält den zuvor aufgelösten Schlüssel in einer Closure.
- Stellen: [ai-provider-runtime.ts:43](G:/Projects/S-A-R-A-H/src/main/ai-provider-runtime.ts:43), [cloud-text-service.ts:22](G:/Projects/S-A-R-A-H/src/services/providers/cloud-text-service.ts:22).
- Korrekturziel: Verbindungsbezogene Abbruch-/Drain-Verwaltung auch für Text. Lokaler Abbruch darf nicht als garantierter Stopp der Anbieterabrechnung ausgegeben werden.

### L3-N05 – P2 – OpenAI-Textstream kann den Turn unbegrenzt blockieren

- Trigger: HTTP-Header und ein Text-Delta treffen ein; danach bleibt der SSE-Body offen.
- Reproduktion mit produktivem SDK und simulierten Timern: Nach 31.000 ms ist die Generierung trotz konfiguriertem 30.000-ms-Timeout weiterhin offen. Erst expliziter Abbruch beendet sie.
- Ursache: Der SDK-Timeout begrenzt diesen Streaming-Body nicht. Die Adapter-Schleife besitzt keine eigene Gesamtlaufzeitgrenze; der normale Turn-AbortController setzt ebenfalls keine Deadline.
- Stelle: [openai-text-adapter.ts:23](G:/Projects/S-A-R-A-H/src/services/providers/openai/openai-text-adapter.ts:23).
- Korrekturziel: Gesamtlaufzeit begrenzen, Stream abbrechen und Teilantwort ohne automatischen Retry erhalten. Der Anthropic-Adapter hat bereits einen entsprechenden separaten Zeitablauf.

### L3-N06 – P2 – OpenAI-Ablehnung wird als leere erfolgreiche Antwort ausgegeben

- Trigger: Dokumentierte `response.refusal.delta`-/`.done`-Events, gefolgt von `response.completed` mit Refusal-Content.
- Reproduktion mit dem produktiven Adapter: `status: 'completed'`, `fullText: ''`, kein Delta. Die eigentliche Anbieterablehnung geht verloren.
- Stelle: [openai-text-adapter.ts:24](G:/Projects/S-A-R-A-H/src/services/providers/openai/openai-text-adapter.ts:24). Der Eventvertrag ist in den installierten SDK-Typen enthalten.
- Korrekturziel: Refusal-Ausgaben sichtbar und strukturiert normalisieren; eine Ablehnung darf nicht als leere erfolgreiche Bearbeitung verschwinden.

### L3-N07 – P2 – Lautstärke-Grounding akzeptiert den Ausgangswert als Ziel

- Eingabe: `Setze die Systemlautstärke von 80 auf 20 Prozent und öffne Spotify`.
- Ein Modellvorschlag `set_volume:80` wird als `semantic_grounding` akzeptiert. Reproduktion über Plan-Compiler, `RouterActionFlow` und produktiven `ActionService`: Der gemockte OS-Adapter erhält tatsächlich `setVolume(80)`, obwohl das Ziel 20 ist.
- Ursache: Die Zahl muss nur irgendwo in der Klausel vorkommen; ihre Rolle als Ausgangs- oder Zielwert wird nicht gebunden.
- Stelle: [router-action-grounding.ts:199](G:/Projects/S-A-R-A-H/src/services/llm/router-action-grounding.ts:199), Weitergabe [action-service.ts:435](G:/Projects/S-A-R-A-H/src/services/actions/action-service.ts:435).
- Korrekturziel: Numerisches Ziel eindeutig aus der angeforderten Veränderung ableiten oder solche mehrdeutigen Vorschläge ablehnen. Keine echte Systemlautstärke wurde verändert.

### L3-N08 – P2 – Cloud-Text wird durch das unbenutzte lokale Kontextbudget abgewiesen

- Produktiver Zustand im Repro: Erst eine lokale Antwort erzeugen, dann Cloud-Text aktivieren; lokales `num_ctx=4096` ist eine erlaubte Konfiguration. Eine am IPC erlaubte Nachricht mit 4.000 Zeichen wird an den warmen Worker-Pfad übergeben.
- Obwohl die Cloud nur den aktuellen Text erhalten soll, baut `runWorker` zuerst den persönlichen lokalen Systemprompt und das lokale Kontextfenster. Dies wirft `ContextWindowError`; der Cloud-Generator wird keinmal aufgerufen.
- Stelle: [router-worker-flow.ts:234](G:/Projects/S-A-R-A-H/src/services/llm/router-worker-flow.ts:234), insbesondere Zeilen 237–248 vor der tatsächlichen Auswahl in 270–272.
- Korrekturziel: Nur den Kontext der gewählten Ausführung aufbauen und validieren; die erforderliche Privacy-Prüfung beibehalten. Der Repro nutzt den warmen Worker-Pfad und bleibt innerhalb der 4.000-Zeichen-Eingabegrenze.

## Bestehende Integrationslücke – nicht als neue Ursache gezählt

**L3-E01 – P2:** `Wie ist mein Name, stelle einen Timer auf zehn Minuten` wird vom aktuellen Multi-Intent-Detektor erkannt. Der vorher ausgeführte Profil-Shortcut antwortet trotzdem ausschließlich `Du heißt Auditname.`; keine Router-Inferenz, kein Timer, Turn `done`. Der bestehende Shortcut übersieht das Komma als Klauselgrenze. Dies ist eine erneut bestätigte Variante des bereits bekannten Problems verschluckter kombinierter Profilaufträge, kein neuer unabhängiger Ursachenkomplex.

Stellen: [router-service.ts:780](G:/Projects/S-A-R-A-H/src/services/llm/router-service.ts:780), [profile-response.ts:29](G:/Projects/S-A-R-A-H/src/services/llm/profile-response.ts:29). Nachweis mit echtem Bootstrap und synthetischer Datenbank in `foundation-profile.ts`.

## Verifikation und Grenzen

- Bestehende vollständige Suite: **177 Dateien bestanden, eine übersprungen; 2.305 Tests bestanden, einer übersprungen**.
- Beide Typechecks bestanden.
- Unabhängige Adapter-Repros: **5/5 bestanden**, weil sie das fehlerhafte Ist-Verhalten nachweisen.
- Grundplatten-Repros: **2/2 bestätigt**, einschließlich tatsächlichem Aufruf des gemockten OS-Lautstärkeadapters und echtem Router-/Turnabschluss.
- Vier zusätzliche Sollverhalten-Tests schlagen gezielt fehl und belegen N01, N03, N04 und N08. Diese Audit-Repros gehören nicht zur unveränderten regulären Suite.
- Der optionale native Windows-Codex-Smoke bestand zusätzlich: isolierter App-Server startet, `account/read` liefert `account:null`, keine `auth.json`. Kein Login und keine Generierung.
- SQLite wurde für Node/Vitest umgebaut und anschließend wieder für Electron hergestellt. Der vollständige Produktionsbuild (`npm run build`) bestand ebenfalls.
- `git diff --check` bestanden; keine Produktivdateien, bestehenden Tests oder Dependencies verändert, kein Commit, Push oder Merge.
- Keine echte kostenpflichtige Generierung, keine reale Kontoverbindung, keine praktische Chat-/Voice-/Provider-Gesamtabnahme. Gemockte SDK-Responses bestätigen lokale Vertragsfehler, nicht das Liveverhalten aller entfernten Anbieter.

## Bewusst nicht als Befund gezählt

- Codex-Coding ist in Main absichtlich gesperrt (`new CodexTaskAdapter(() => null)`). Der dokumentierte Nachweis einer verlässlichen Projektbegrenzung fehlt. Vorhandene Anmeldung/App-Server-Basis bedeutet keine freigegebene Coding-Ausführung.
- Vision sowie ein autonomer Planner mit Re-Planung bleiben dokumentierte Produktgrenzen.
- OpenAI `background:true` mit `store:false` ist laut aktueller [offizieller Hintergrundmodus-Dokumentation](https://developers.openai.com/api/docs/guides/background) zulässig.
- Eine isolierte 1.001-Zeichen-Handoff-Vertragsprobe scheitert an einem nachgelagerten Limit, ist über den aktuellen Router mit maximal 500 Zeichen Evidence aber nicht erreichbar. Sie ist kein produktiver Blocker und wird nicht mitgezählt.

## Reproduktionen

Die Dateien unter `.audit-tmp` sind ausschließlich Audit-Artefakte. Sie verwenden synthetische Daten, Fake-Transporte und gemockte äußere Nebenwirkungen.

```powershell
npm run rebuild:sqlite:node
npx vitest run --config .audit-tmp/root.config.ts --reporter=verbose
npx vitest run --config .audit-tmp/adapters-review.config.ts --reporter=verbose
npx vitest run --config .audit-tmp/hub-audit.config.ts --reporter=verbose -t 'deleting a connection|verified Perplexity'
npx esbuild .audit-tmp/foundation-volume.ts --bundle --platform=node --packages=external --format=cjs --outfile=.audit-tmp/foundation-volume.cjs
node .audit-tmp/foundation-volume.cjs
npx esbuild .audit-tmp/foundation-profile.ts --bundle --platform=node --packages=external --format=cjs --outfile=.audit-tmp/foundation-profile.cjs
node .audit-tmp/foundation-profile.cjs
npm run rebuild:sqlite:electron
```

Die roten Sollverhalten-Tests sind bis zu einer Korrektur erwartete Reproduktionen. Der ausgeklammerte 1.001-Zeichen-Test wird durch den oben angegebenen Filter nicht ausgeführt.
