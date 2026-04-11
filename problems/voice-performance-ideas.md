# Voice Performance — Ideen & Optimierungen

## Priorisierung

| Prio | Idee | Impact | Aufwand | Status |
|---|---|---|---|---|
| 1 | 9B Q3_K + num_ctx reduzieren | Sehr hoch | Niedrig | Offen |
| 2 | Performance-Profile (Layer + Verhalten) | Mittel | Mittel | Offen |
| 3 | System-Prompt Komprimierung | Niedrig jetzt, Hoch langfristig | Mittel | Offen |
| 4 | faster-whisper (v2.7) | Sehr hoch | Mittel | Offen |
| 5 | Konversations-Zusammenfassung | Mittel | Hoch | Offen |

---

## 1. Qwen 3.5:9b Q3_K + dynamischer Kontext [PRIO 1]

**Warum zusammen:** num_ctx runter macht erst Platz für 9B Q3_K auf der GPU. Ohne Kontext-Reduktion passt 9B nicht in 8GB VRAM.

### 1a. Context-Länge dynamisch (Hardware-abhängig)
- Low-End (8GB VRAM): num_ctx 4096–8192
- Mid (12-16GB VRAM): num_ctx 8192–16384
- High-End (24GB+ VRAM): num_ctx 32768
- Aktuell: 8192 ist der Sweetspot (System-Prompt + ~10 Nachrichten)
- **Achtung:** Bei 4096 wird es mit System-Prompt eng

### 1b. Modell-Wechsel auf 9B Q3_K
- Deutlich besseres Instruction-Following als 4B Q4
- Routing (lokal vs. Server) wird zuverlässiger
- Regeln/Constraints werden besser befolgt
- Q2_K nur als Notlösung (zu viel Qualitätsverlust)

**TODO:**
- [ ] `num_ctx` in `llm-types.ts` auf 8192 setzen
- [ ] Testen ob System-Prompt + Konversation passt
- [ ] `ollama pull` eines 9B Q3_K_M Modells
- [ ] VRAM-Test: passt es auf GPU? (`ollama ps` → GPU statt CPU)
- [ ] Vergleichstest: Instruction-Following 9B Q3 vs 4B Q4
- [ ] Default-Modell wechseln wenn erfolgreich

---

## 2. Performance-Profile [PRIO 2]

**Idee:** UX + Technik kombiniert. User wählt in Settings wie viel GPU Sarah nutzen darf.

**Modi:**
| Modus | GPU Layers | Wirkung | Sinn |
|---|---|---|---|
| Leistung | auto (Ollama verteilt) | maximale GPU-Nutzung | wenn Sarah priorisiert wird |
| Schnell | ~80% (z.B. 25/30) | hohe GPU-Nutzung | Standard auf starken Systemen |
| Normal | ~70% (z.B. 21/30) | gemischt GPU/CPU | guter Standard |
| Sparsam | ~50% (z.B. 16/30) | weniger GPU, mehr CPU | beim Gaming / schwachen GPUs |

*Layer-Anzahl variiert pro Modell. Konkrete Werte werden zur Laufzeit aus Modell-Info ermittelt.*

> Höhere Stufen belegen mehr VRAM und antworten schneller. Niedrigere Stufen sparen VRAM, erhöhen aber die Antwortlatenz.

**Technisch:**
- `num_gpu` in Ollama-Options setzen
- Model-Reload bei Profilwechsel nötig (kein Live-Switch)
- Settings-UI: Dropdown mit Erklärungstext
- Push-to-Talk reduziert Dauerlast zusätzlich (Modell nur bei Bedarf aktiv)

**TODO:**
- [ ] `num_gpu` zu `OllamaOptions` Interface hinzufügen
- [ ] Settings-UI: Performance-Profil Dropdown
- [ ] Ollama Model-Reload Mechanismus implementieren
- [ ] Hinweistext in Settings

---

## 3. System-Prompt Komprimierung [PRIO 3]

**Jetzt:** Niedrig (Prompt passt noch locker)
**In 6-12 Monaten:** Hoch (mehr Rules, mehr Layer, mehr Features)

**Ansatz:**
- Strukturierte Formate statt Prosa: `NEVER_STORE: [passwords, bank_data, ...]`
- ~60-70% Token-Ersparnis bei Regellisten
- Layered Architecture: Basis → User-Settings → Sicherheit → Hard Rules
- Keine Dopplungen, jede Regel genau einmal
- Token-Budget des System-Prompts regelmäßig messen

**Settings-Werte überarbeiten:**
- Persönlichkeits-Traits als englische Keys: `personality: [snarky, calm, playful]` statt deutsche Wörter
- Antwortsprache als explizites Setting: `response_language: de`
- Regeln in komprimiertem Englisch: `Never store any item in MEMORY_BLOCKLIST.` statt ausformulierte deutsche Sätze
- Alle Settings-Werte prüfen: was kommt aktuell raus bei Verhalten, Ton, Quirks etc.?
- LLM versteht englische Prompts besser + kürzer, Antwortsprache separat steuern

**TODO:**
- [ ] Aktuellen System-Prompt Token-Verbrauch messen
- [ ] Alle Settings-Werte inventarisieren (was geht aktuell in den Prompt)
- [ ] Komprimiertes Format entwerfen (englische Keys, strukturiert)
- [ ] Antwortsprache als eigenes Setting
- [ ] Refactoring des Prompt-Builders in `llm-service.ts`
- [ ] Vorher/Nachher Token-Vergleich

---

## 4. faster-whisper [PRIO 4]

**Impact:** STT von ~14s auf ~3-5s — größter einzelner Latenz-Gewinn
**Aber:** Höherer Aufwand und Deployment-Komplexität

**Optionen:**
- faster-whisper CLI Binary (wenn verfügbar)
- Python-Wrapper mit faster-whisper Paket
- Alternative: whisper.cpp mit GPU-Support (CUDA)

**TODO:**
- [ ] faster-whisper CLI oder Alternativen evaluieren
- [ ] Benchmark gegen aktuelles whisper-cli.exe
- [ ] WhisperProvider austauschen oder FasterWhisperProvider als Alternative
- [ ] GPU-Sharing: Whisper + LLM gleichzeitig auf GPU?

---

## 5. Konversations-Zusammenfassung [PRIO 5]

**Erst relevant wenn 8k Context zum Problem wird.**

- Nach N Nachrichten: alte Messages zu 2-3 Sätzen komprimieren
- Extra LLM-Call für Zusammenfassung (kostet Latenz)
- Zusammenfassung als Kontext-Block im System-Prompt
- Risiko: Details gehen verloren

---

## Hardware-Kontext (RTX 3050, 8GB VRAM)

- 4B Q4_K_M: ~5.8GB → passt auf GPU
- 7-9B Q4_K_M: ~9.6GB → fällt auf CPU
- 9B Q3_K_M + 8k ctx: ~6-7GB → könnte gerade passen
- Wenn Sarah läuft, ist GPU quasi voll belegt
- Ollama muss aktuell sein (GPU-Erkennung war problematisch)
