# Voice Performance — Ideen & Optimierungen

## Priorisierung

| Prio | Idee | Impact | Aufwand | Status |
|---|---|---|---|---|
| 1 | System-Prompt Komprimierung | Niedrig jetzt, Hoch langfristig | Mittel | Offen |
| 2 | Performance-Profile (GPU Layer Settings) | Mittel | Mittel | Offen |
| 3 | 9B Q3_K + num_ctx reduzieren | Sehr hoch | Niedrig | Offen |
| — | Pause & Bewertung | — | — | — |
| 4 | Dual-LLM Routing (2B + 9B) | Hoch | Hoch | Offen |
| 5 | faster-whisper (v2.7) | Sehr hoch | Mittel | Offen |
| 6 | Konversations-Zusammenfassung | Mittel | Hoch | Offen |

**Reihenfolge-Logik:**
- Prio 1+2 bereiten den 9B-Einbau vor (kleinerer Prompt = mehr Context-Budget, Layer-Settings = kontrolliertes VRAM-Management)
- Prio 3 braucht 1+2 als Grundlage
- Nach Prio 3: Pause, bewerten ob 9B stabil laeuft
- Prio 4 setzt funktionierendes 9B voraus — 2B Router entscheidet ob 9B geweckt wird
- Prio 5 ist unabhaengig und kann jederzeit gemacht werden

---

## 1. System-Prompt Komprimierung [PRIO 1]

**Warum jetzt:** Bevor weitere Features (Routing, 2B-Instruktionen) den Prompt aufblaehen, einmal sauber umstellen. Spaeter wird es deutlich aufwaendiger.

**Ansatz:**
- Strukturierte Formate statt Prosa: `NEVER_STORE: [passwords, bank_data, ...]`
- ~60-70% Token-Ersparnis bei Regellisten
- Layered Architecture: Basis → User-Settings → Sicherheit → Hard Rules
- Keine Dopplungen, jede Regel genau einmal
- Token-Budget des System-Prompts regelmaessig messen

**Settings-Werte ueberarbeiten:**
- Persoenlichkeits-Traits als englische Keys: `personality: [snarky, calm, playful]` statt deutsche Woerter
- Antwortsprache als explizites Setting: `response_language: de`
- Regeln in komprimiertem Englisch: `Never store any item in MEMORY_BLOCKLIST.` statt ausformulierte deutsche Saetze
- Alle Settings-Werte pruefen: was kommt aktuell raus bei Verhalten, Ton, Quirks etc.?
- LLM versteht englische Prompts besser + kuerzer, Antwortsprache separat steuern

**TODO:**
- [ ] Aktuellen System-Prompt Token-Verbrauch messen
- [ ] Alle Settings-Werte inventarisieren (was geht aktuell in den Prompt)
- [ ] Komprimiertes Format entwerfen (englische Keys, strukturiert)
- [ ] Antwortsprache als eigenes Setting
- [ ] Refactoring des Prompt-Builders in `llm-service.ts`
- [ ] Vorher/Nachher Token-Vergleich

---

## 2. Performance-Profile (GPU Layer Settings) [PRIO 2]

**Idee:** UX + Technik kombiniert. User waehlt in Settings wie viel GPU Sarah nutzen darf.

**Modi:**
| Modus | GPU Layers | Wirkung | Sinn |
|---|---|---|---|
| Leistung | auto (Ollama verteilt) | maximale GPU-Nutzung | wenn Sarah priorisiert wird |
| Schnell | ~80% (z.B. 25/30) | hohe GPU-Nutzung | Standard auf starken Systemen |
| Normal | ~70% (z.B. 21/30) | gemischt GPU/CPU | guter Standard |
| Sparsam | ~50% (z.B. 16/30) | weniger GPU, mehr CPU | beim Gaming / schwachen GPUs |

*Layer-Anzahl variiert pro Modell. Konkrete Werte werden zur Laufzeit aus Modell-Info ermittelt.*

> Hoehere Stufen belegen mehr VRAM und antworten schneller. Niedrigere Stufen sparen VRAM, erhoehen aber die Antwortlatenz.

**Technisch:**
- `num_gpu` in Ollama-Options setzen
- Model-Reload bei Profilwechsel noetig (kein Live-Switch)
- Settings-UI: Dropdown mit Erklaerungstext
- Push-to-Talk reduziert Dauerlast zusaetzlich (Modell nur bei Bedarf aktiv)

**TODO:**
- [ ] `num_gpu` zu `OllamaOptions` Interface hinzufuegen
- [ ] Settings-UI: Performance-Profil Dropdown
- [ ] Ollama Model-Reload Mechanismus implementieren
- [ ] Hinweistext in Settings

---

## 3. 9B Q3_K + dynamischer Kontext [PRIO 3]

**Warum:** Deutlich besseres Instruction-Following als 4B Q4. Routing und Regeln werden zuverlaessiger befolgt.

### 3a. Context-Laenge dynamisch (Hardware-abhaengig)
- Low-End (8GB VRAM): num_ctx 4096-8192
- Mid (12-16GB VRAM): num_ctx 8192-16384
- High-End (24GB+ VRAM): num_ctx 32768
- Aktuell: 8192 ist der Sweetspot (System-Prompt + ~10 Nachrichten)
- **Achtung:** Bei 4096 wird es mit System-Prompt eng

### 3b. Modell-Wechsel auf 9B Q3_K
- Q2_K nur als Notloesung (zu viel Qualitaetsverlust)
- Braucht Prio 1 (kleinerer Prompt) + Prio 2 (Layer-Kontrolle)

**TODO:**
- [ ] `num_ctx` in `llm-types.ts` auf 8192 setzen
- [ ] Testen ob System-Prompt + Konversation passt
- [ ] `ollama pull` eines 9B Q3_K_M Modells
- [ ] VRAM-Test: passt es auf GPU? (`ollama ps` → GPU statt CPU)
- [ ] Vergleichstest: Instruction-Following 9B Q3 vs 4B Q4
- [ ] Default-Modell wechseln wenn erfolgreich

---

## 4. Dual-LLM Routing (2B + 9B) [PRIO 4]

**Voraussetzung:** 9B laeuft stabil auf GPU (Prio 3 abgeschlossen).

- Qwen 3.5:2B als Router/Schnellarbeiter — always-on, leichtgewichtig
  - Routing-Entscheidungen, Begruessung, Termine, E-Mails, Programme oeffnen
  - Entscheidet: selbst erledigen, 9B wecken, oder ans Backend delegieren
- Qwen 3.5:9B als "grosse Schwester" — on-demand geladen
  - Smalltalk, laengere Gespraeche, komplexe Aufgaben (z.B. PDFs sortieren)
- Backend (Cloud/Server) fuer Planung, Coding, etc.
- VRAM-Frage: 2B + 9B gleichzeitig auf 8GB RTX 3050 wird eng → 9B nur on-demand, 2B entladen wenn 9B aktiv

---

## 5. faster-whisper [PRIO 5]

**Impact:** STT von ~14s auf ~3-5s — groesster einzelner Latenz-Gewinn
**Aber:** Hoeherer Aufwand und Deployment-Komplexitaet

**Optionen:**
- faster-whisper CLI Binary (wenn verfuegbar)
- Python-Wrapper mit faster-whisper Paket
- Alternative: whisper.cpp mit GPU-Support (CUDA)

**TODO:**
- [ ] faster-whisper CLI oder Alternativen evaluieren
- [ ] Benchmark gegen aktuelles whisper-cli.exe
- [ ] WhisperProvider austauschen oder FasterWhisperProvider als Alternative
- [ ] GPU-Sharing: Whisper + LLM gleichzeitig auf GPU?

---

## 6. Konversations-Zusammenfassung [PRIO 6]

**Erst relevant wenn 8k Context zum Problem wird.**

- Nach N Nachrichten: alte Messages zu 2-3 Saetzen komprimieren
- Extra LLM-Call fuer Zusammenfassung (kostet Latenz)
- Zusammenfassung als Kontext-Block im System-Prompt
- Risiko: Details gehen verloren

---

## Hardware-Kontext (RTX 3050, 8GB VRAM)

- 4B Q4_K_M: ~5.8GB → passt auf GPU
- 7-9B Q4_K_M: ~9.6GB → faellt auf CPU
- 9B Q3_K_M + 8k ctx: ~6-7GB → koennte gerade passen
- Wenn Sarah laeuft, ist GPU quasi voll belegt
- Ollama muss aktuell sein (GPU-Erkennung war problematisch)
