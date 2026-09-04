# Review: AI Specialist Provider Hub Implementation Plan

## Kurzfazit

**Bewertung: 7/10 – gut konzipiert, aber noch nicht implementation-ready.**

Der Plan ist fachlich konsistent mit dem derzeitigen Architektur-Ziel und passt in den bestehenden Layer-3-Ansatz: Provider-neutraler Router, explizite Intents und feste Capability-Snapshot-Contracts. Die wichtigsten Entwurfsentscheidungen sind sinnvoll und die Trennung zwischen Router/Role-Auswahl und lokaler Provider-Selektionslogik ist richtig.

Die eigentliche Gefahr liegt aber nicht bei der Provider-API-Logik, sondern bei der Laufzeit- und Resume-Architektur: Der aktuelle Code hat bereits eine robuste, aber noch terminale Plan-Ausführung und noch keine echte "waiting_confirmation"- oder "pending specialist task"-Semantik. Genau dort muss der Plan vor Umsetzung verfestigt werden, sonst entsteht ein Design-Split zwischen Architekturpapier und realem Code.

---

## Was der aktuelle Code bereits unterstützt

Der Plan trifft auf einen realen, vorhandenen Baseline-Kontext:

- Die Formulierung von provider-neutralen Spezialisten ist bereits im Modell vorhanden: [../../../src/core/intent-plan.ts](../../../src/core/intent-plan.ts) kennt `coding`, `research` und `vision` als `SpecialistCapability`.
- Die Capability-Abstraktion ist bereits als bounded Contract ausgeprägt: [../../../src/core/decision-context.ts](../../../src/core/decision-context.ts) enthält `DecisionCapabilitySnapshot` mit `specialists`.
- Die derzeitige Runtime-Abbildung ist explizit noch deaktiviert: [../../../src/services/llm/decision-capability-snapshot.ts](../../../src/services/llm/decision-capability-snapshot.ts) setzt `coding`, `research` und `vision` auf `no_adapter`.
- Der Router kennt bereits proposal-basierte Multi-Intent-Planungslogik und validiert sie im Contract: [../../../src/services/llm/router-proposal-contract.ts](../../../src/services/llm/router-proposal-contract.ts), [../../../src/services/llm/router-plan-validator.ts](../../../src/services/llm/router-plan-validator.ts).
- Die Ausführung von Plans ist ebenfalls bereits als strukturierter, injizierbarer Step-Executor modelliert: [../../../src/services/llm/intent-plan-executor.ts](../../../src/services/llm/intent-plan-executor.ts).

Das zeigt: Der Plan ist nicht „von Null“; er baut auf bestehende Schichten auf, was gut ist.

---

## Wichtige Abweichungen zum aktuellen Code

### 1) Der größte Gap ist nicht OpenAI/Anthropic/Perplexity, sondern der Pending-Plan-Lifecycle

Der Plan fordert ausdrücklich ein `waiting_confirmation`- und Resume-Modell, inklusive in-memory pending plan store, Replay-Validierung und spätere Wiederaufnahme.

Der aktuelle Code hat das aber noch nicht:

- [../../../src/core/plan-execution-state.ts](../../../src/core/plan-execution-state.ts) kennt nur `running`, `completed`, `partially_completed`, `failed` und `canceled`.
- [../../../src/services/llm/intent-plan-executor.ts](../../../src/services/llm/intent-plan-executor.ts) läuft synchron durch den Plan und akzeptiert nur terminale Ergebnisse.
- [../../../src/services/llm/router-worker-flow.ts](../../../src/services/llm/router-worker-flow.ts) prüft zwar `handoff_confirmation`/`specialist_handoff` auf Capability-Verfügbarkeit, aber es gibt keine echte Pausen-/Resume-Architektur für einen offenen Spezialisten-Grant.

Das ist der wichtigste technische Mismatch im Plan. Slice 2 ist nicht nur „extra Funktion“, sondern der eigentliche Architektur-Hebel. Wenn das nicht sauber gelöst wird, bleiben die späteren Provider-Adapter nur theoretisch nutzbar.

### 2) Der Plan spricht von einem neuen `SpecialistRuntimeService`, aber der aktuelle Code trennt noch nicht sauber zwischen lokalem ModelRuntime und Spezialisten-Lebenszyklus

Der Plan fordert bewusst: `ModelRuntime` bleibt lokal und `SpecialistRuntimeService` übernimmt Unternehmens-/Task-Lifecycle.

Das ist an sich korrekt, aber in der aktuellen Codebasis gibt es noch keine eindeutige Trennung zwischen:

- lokalem Worker-/Router-Lifecycle;
- Plan-Executionszustand;
- Spezialisten-Task-Status;
- Benutzer-Consent / Confirmation-Grant.

Die vorhandenen Interfaces in [../../../src/core/decision-context.ts](../../../src/core/decision-context.ts) und [../../../src/services/llm/decision-capability-snapshot.ts](../../../src/services/llm/decision-capability-snapshot.ts) sind bewusst klein. Das ist gut für die Router-Architektur, aber das gilt noch nicht als fertige Spezialisten-Task-Foundation.

### 3) Die aktuelle Connection-/Integrations-Schicht ist noch OAuth- und Spotify-spezifisch

Der Plan geht davon aus, dass eine generische AI-Connection-Schicht mit API-Key/managed-login-Speichern entsteht. Der aktuelle Code zeigt genau das Gegenteil:

- [../../../src/services/integrations/oauth-connection-service.ts](../../../src/services/integrations/oauth-connection-service.ts)
- [../../../src/services/integrations/token-store.ts](../../../src/services/integrations/token-store.ts)
- [../../../src/main/ipc-connections.ts](../../../src/main/ipc-connections.ts)

Das ist zwar ein klarer und sauberer, schon vorhandener Pattern-Block, aber er ist nicht AI-generic. Der Plan muss hier sehr strikt auf Trennung achten: AI-Connection-Speicher darf nicht in den OAuth-Schema-Container hineinwachsen. Das wäre ein echtes Architekturproblem.

### 4) Die Product-Claims im Plan sind grundsätzlich gut, aber einige „Acceptance“-Sätze sind zu breit für die erste reale Slice-Reihenfolge

Beispiele:

- „No specialist receives the goal before confirmation“ – technisch sauber, aber implementatorisch hängt das an dem Pending-Plan-System und dem Confirmation-Grant zusammen.
- „A preparation action can finish, the plan can pause, and confirmation can resume the exact remaining step in a later turn“ – das ist ein echtes Systemfeature, kein bloßes Adapter-Feature.
- „No settings render causes a charged request“ – gut, aber nur dann konsistent, wenn die Health-Checks und Test-Aktionen explizit nicht automatisch ausgelöst werden.

Das heißt: Slice 2 und Slice 1 sind nicht nur Vorbereitung; sie sind die eigentlichen Sicherheits- und Zustands-Kerne.

---

## Konkrete Risiken

### Risiko A: Pausen-/Resume-Logik wird im Code später „nachträglich“ ergänzt und erzeugt Races

Die aktuelle Plan-Execution ist nicht designed for long-lived, user-confirmed suspension. Wenn wir das in Slice 2 nachträglich hineinbauen, besteht ein hohes Risiko für:

- doppelte Ausführung desselben Schritts;
- Stale Binding / stale confirmation grant;
- false completion of the specialist branch;
- late-event races nach app restart.

### Risiko B: Connection/Secret-Architektur wird zu eng an OAuth-Token-Store gekoppelt

Die bestehende Token-Store-Architektur ist gut für OAuth, aber der Plan verlangt ein separates, AI-spezifisches Secret-File mit eigener AAD/BACKUP-Strategie. Das muss sauber getrennt werden. Wenn das nicht streng in Slice 1 gemacht wird, wird später eine ungewollte Cross-Dependency entstehen.

### Risiko C: Der Router darf niemals provider-spezifische Details sehen

Der Plan adressiert das richtig. Der aktuelle Code in [../../../src/services/llm/router-proposal-contract.ts](../../../src/services/llm/router-proposal-contract.ts) und [../../../src/core/decision-context.ts](../../../src/core/decision-context.ts) stimmt hier mit dieser Absicht überein. Das ist eine gute Architekturentscheidung und sollte als unverhandelbare Grenze im Slice-Design stehen.

### Risiko D: OpenAI/Anthropic/Perplexity-Diversität ist real, aber die Slice-Reihenfolge ist sinnvoll

Die Plan-Slice-Reihenfolge ist logisch; die faktische Schwierigkeit liegt aber im Task-Lifecycle und nicht in den Adaptern. Wenn der Task-Contract nicht zuerst stabilisiert wird, werden die einzelnen Provider-Adapter mit fehlerhaftem Lifecycle-Model aufgesetzt.

---

## Was ich vor der Umsetzung unbedingt ändern würde

1. **Slice 2 als Blocker definieren**
   - Das ist der Kern, nicht nur ein vorbereitender Schritt.
   - `waiting_confirmation` muss Teil der gemeinsamen Plan-Execution-Contract-Sprache werden.

2. **Pending-Plan-State explizit modellieren**
   - In-memory store + expiration
   - live revalidation on resume
   - clear cancellation semantics
   - approvals tied to exact plan fingerprint and binding revision

3. **AI-Secret-Layer von OAuth-Layer trennen**
   - separate encrypted file per AI connection
   - separate backup / deletion isolation
   - not stored in config or renderer

4. **Spezialist-Adapter nur über gemeinsame Contract-Interfaces aktivieren**
   - kein `ModelRuntime`-Heuristik-Wildwuchs
   - keine direkte SDK-Objekte in Router/Plan/Renderer

5. **Die "fake adapter"-Tests in Slice 2 als bindendes TDD-Verpflichtung betrachten**
   - das ist hier der echte Regression-Schutz, nicht nur das Provider-API-Playground

---

## Empfehlung

Der Plan ist inhaltlich gut genug für die Umsetzung, aber nur mit einer klaren Reihenfolge und einer festen Architekturgrenze:

- **Phase A:** AI Connection Hub + Secret isolation + non-secret binding layer
- **Phase B:** Specialist runtime + confirmation gate + waiting-confirmation state + fake adapter contract tests
- **Phase C:** Provider adapters
- **Phase D:** cross-provider behavior and audit

Ohne diese Reihenfolge wird der Plan in der Praxis an genau den Punkten scheitern, an denen der aktuelle Code heute noch am stärksten erkennbar ist: `PlanExecutionState`, `IntentPlanExecutor`, `DecisionCapabilitySnapshot` und der OAuth-Integrations-Layer.

**Fazit:** Der Plan ist als Architektur-Entwurf gut, aber vor der Implementierung muss Slice 2 als harte Voraussetzung und nicht als optionale Fortschrittsstufe verstanden werden.
