# Ollama in Docker — Design-Spec

_Erstellt 2026-07-15 · Branch `feat/ollama-docker` · Status: entworfen, von Martin freigegeben_

---

## 1. Problem

Nach NVIDIA-Treiber-Updates startet das native Windows-Ollama wiederholt im **CPU-Modus**, weil seine mitgelieferten CUDA-Bibliotheken nicht mehr zum neuen Treiber passen. Folgen:

- qwen3:8b antwortet statt in ~2s in 60s+, Timeouts schlagen zu („Sarah hat den Faden verloren…")
- Das gesamte Voice-Timing-Konzept (Router-Warmup, VRAM-Swap 2b↔9b, Idle-Timer) ist wirkungslos
- **Der Fehler ist für Sarah unsichtbar:** `OllamaProvider.isAvailable()` prüft nur `/api/tags` (Server erreichbar + Modell vorhanden), nie ob die GPU genutzt wird
- Bisheriger „Fix": manuelle Ollama-Neuinstallation nach jedem betroffenen Treiber-Update

## 2. Ziel

1. Ollama läuft in einem Docker-Container mit **eingefrorener CUDA-Runtime** — Treiber-Updates können das Setup nicht mehr brechen (NVIDIA-Treiber sind abwärtskompatibel zu älteren CUDA-Runtimes; nur der nackte Treiber kommt via WSL2-Passthrough vom Host)
2. Sarah **überwacht und heilt** den Container selbst (Boot-Check, Auto-Start, Health-Check)
3. Sarah **erkennt CPU-Modus** aktiv und meldet ihn sichtbar, statt still langsam zu werden

## 3. Getroffene Entscheidungen

| Frage | Entscheidung |
|---|---|
| Zielgruppe | Erst Martins Rechner, Design muss Endnutzer-Weg offenhalten |
| Docker-Rolle | **Pflicht** — Sarah managed den Container selbst |
| Lifecycle | **Hybrid:** Container läuft dauerhaft (`restart: unless-stopped`), Sarah startet ihn beim Boot nach, falls er fehlt/steht; Sarah stoppt ihn beim Beenden **nicht** |
| GPU-Support | **NVIDIA-only jetzt.** AMD (Radeon) später als eigener Weg (natives Ollama mit Vulkan), siehe §10 |
| Whisper/Piper | Bleiben nativ wie bisher — nicht Teil dieses Features |

Begründung Hybrid-Lifecycle: Ein Ollama-Server ohne geladenes Modell belegt praktisch keinen VRAM (Modelle werden per `keep_alive` nach 5 min Leerlauf entladen). Dauerbetrieb kostet nur den RAM der WSL2-VM, passt zum Zielbild „dauerhafter Assistent" (analyze-fabel.md §7) und macht das System selbstheilend.

## 4. Architektur

```
Windows-Start
   └── Docker Desktop (Autostart)
         └── Container "sarah-ollama"  (restart: unless-stopped)
               ├── ollama/ollama:0.32.0 + eingefrorene CUDA-Runtime
               ├── GPU: RTX 3050 durchgereicht (WSL2)
               ├── Port: 127.0.0.1:11434  ← Sarahs baseUrl, unverändert
               └── Volume "sarah-ollama-models" (phi4-mini:3.8b, qwen3:8b)

Sarah-Boot (neu)
   └── OllamaContainerManager
         1. Läuft der Container?  nein → docker start / docker compose up -d
         2. Antwortet die API?    nein → klarer Boot-Fehler (30s Timeout)
         3. Modell im VRAM?       nein → sichtbare Warnung „Ollama läuft ohne GPU"
```

## 5. `docker-compose.yml` (neu, Repo-Root)

- Image **festgepinnt**: `ollama/ollama:0.32.0` (entspricht der aktuell nativ laufenden Version; Updates nur bewusst durch Ändern dieser Zeile)
- `container_name: sarah-ollama`
- GPU-Durchreichung: `deploy.resources.reservations.devices` mit `driver: nvidia`, `capabilities: [gpu]`
- Port nur lokal gebunden: `127.0.0.1:11434:11434` — nichts aus dem Netzwerk erreicht Ollama
- Benanntes Volume `sarah-ollama-models` → `/root/.ollama` (Modelle überleben Container-Neubau)
- `restart: unless-stopped`
- Env-Defaults von Ollama bleiben (KEEP_ALIVE 5m). `OLLAMA_FLASH_ATTENTION` bleibt **bewusst aus** — auf diesem Setup verursachte Flash-Attention früher CUDA-500-Crashes; als Kommentar in der compose-Datei dokumentieren

## 6. Neue Datei: `src/services/llm/ollama-container-manager.ts`

Service nach dem Vorbild des `FasterWhisperProvider`, steuert den Container über die Docker-CLI (`child_process`), keine neue npm-Dependency.

**Instanziierung:** in `src/main.ts`, direkt neben `RouterService`/`OllamaProvider` (konsistent mit dem bestehenden Muster), Übergabe an `registerBootHandlers` via `BootSequenceDeps` — wie `whisperProvider`/`piperProvider`. **Bewusst kein `SarahService` / keine Registry-Registrierung:** Die Registry wird erst nötig, wenn die Cockpit-Statusanzeige real gebaut wird (YAGNI); `getStatus()` existiert als normale Methode.

**`ensureRunning(): Promise<void>`** — läuft vor `RouterService.init()` (Verdrahtung siehe §7):
1. `docker inspect sarah-ollama` → existiert + läuft? (Millisekunden, lesend)
2. Gestoppt → `docker start sarah-ollama`, dann Health-Polling auf `GET /api/tags`
3. Existiert nicht → `docker compose -f <composePfad> up -d`. **Compose-Pfad:** `path.join(app.getAppPath(), 'docker-compose.yml')` — im Dev-Betrieb (`electron .`) ist das das Repo-Root. Die App wird derzeit nicht gepackt; Packaging-Anforderung siehe §10
4. **Timeout 30 s** (Lektion aus analyze-fabel.md Bug 3.2 — nicht 5 min pollen)
5. Docker fehlt / läuft nicht → Fehler mit klarer Meldung, kein Hänger. **ENOENT-Unterscheidung:** Wenn `spawn('docker', …)` mit ENOENT fehlschlägt, prüft der Manager, ob `C:\Program Files\Docker\Docker\resources\bin\docker.exe` existiert — existiert sie, lautet die Meldung „Docker installiert, aber nicht im PATH", sonst „Docker Desktop nicht installiert". (Ein `where docker`-Fallback hätte dasselbe PATH-Problem wie der spawn selbst.)

**`checkGpu(): Promise<GpuStatus>`** — nach dem Router-Warmup (phi4-mini ist dann geladen):
- `GET /api/ps` liefert pro geladenem Modell `size_vram`
- `size_vram > 0` → GPU aktiv ✅
- Modell geladen, aber `size_vram === 0` → **ein Retry nach 500 ms**, erst wenn auch der `0` liefert → **CPU-Modus erkannt** → Log-Warnung + Boot-Meldung. (Der Warmup awaitet zwar eine vollständige Antwort, das Modell ist danach also geladen — der Retry kostet nichts und schließt Berichts-Verzögerungen von `/api/ps` sicher aus)
- Nutzt dieselben Daten, die `VramManager.getLoadedModels()` bereits ausliest

**`getStatus()`** — läuft/gestoppt/kein Docker, für spätere Settings-/Cockpit-Anzeige.

## 7. Integration in `boot-sequence.ts`

**Wichtig (Ist-Zustand):** `routerService.init()` startet heute *sofort und synchron beim Registrieren* in `registerBootHandlers` (als Promise-Referenz `routerReady`, die der `boot-ready`-Handler später awaitet) — nicht erst im Handler. Ein simples „davor awaiten" ist daher nicht möglich. Verdrahtung:

```ts
// registerBootHandlers bleibt synchron; ensureRunning wird vorgeschaltet gechained:
const routerReady = containerManager
  .ensureRunning()
  .then(() => routerService.init())
  .catch((err) => { /* Router-Status error + Boot-Meldung, wie bisherige Fehlerpfade */ });
```

- Startet weiterhin sofort beim Registrieren → Orb-Reveal-Timing unverändert; im Normalfall (Container läuft) kostet `ensureRunning()` nur Millisekunden
- Fehler aus `ensureRunning()` führen zu Router-Status `error` + Boot-Meldung (gleiche Wirkung wie ein fehlgeschlagenes `init()` heute)
- Nach dem Warmup: `checkGpu()`, Ergebnis in Boot-Status durchreichen
- `baseUrl`, `OllamaProvider`, `RouterService`-Logik, VRAM-Swap: **unverändert**

## 8. Fehlerpfade

| Situation | Verhalten |
|---|---|
| Docker Desktop nicht installiert / nicht gestartet | Boot-Screen-Hinweis („Docker Desktop nicht erreichbar — bitte starten"), Router-Status `error`, Chat meldet „Sarah träumt noch…" |
| Docker installiert, aber `docker` nicht im PATH (ENOENT) | Eigene Meldung „Docker installiert, aber nicht im PATH" via Existenz-Check des Standard-Installationspfads (§6 Punkt 5) |
| Container startet nicht (z.B. Port 11434 durch natives Ollama belegt) | Fehler mit Docker-Originalausgabe im Log, kontrollierter Boot-Abbruch |
| API antwortet nicht binnen 30 s | Timeout-Fehler statt Endlos-Polling |
| CPU-Modus erkannt (`size_vram === 0`) | Deutliche Warnung (Log + Boot-Meldung); Sarah läuft weiter, Nutzer ist informiert |

## 9. Einmalige Einrichtung (Martins Rechner)

1. WSL2 aktivieren + Docker Desktop installieren, „Start with Windows" aktivieren
2. `docker compose up -d` im Projektordner
3. Modelle pullen (einmalig, insgesamt ~8,5 GB Download: phi4-mini ~3,5 GB + qwen3:8b ~5 GB): `docker exec sarah-ollama ollama pull phi4-mini:3.8b` und `… ollama pull qwen3:8b`
4. **Autostart des nativen Windows-Ollama deaktivieren** (Port-Konflikt!); Deinstallation erst nach Bewährungsphase
5. Verifizieren: `server`-Log des Containers zeigt `library=CUDA … NVIDIA GeForce RTX 3050`

## 10. Bewusst außerhalb des Scopes

- **AMD/Radeon-Weg:** CUDA ist NVIDIA-exklusiv; AMD-GPU-Durchreichung unter Windows/Docker ist derzeit nicht praxistauglich. Späterer Plan: GPU-Erkennung im Wizard → NVIDIA = Container, AMD = natives Ollama (Vulkan). Eigenes Feature.
- **Wizard-/Endnutzer-Integration** (Docker-Check, geführte Installation, automatischer Modell-Pull mit Fortschritt): eigenes Feature, Design hält den Weg offen (compose-Datei ist reproduzierbar, Manager kapselt alle Docker-Aufrufe)
- **App-Packaging:** Die App läuft derzeit nur ungepackt (`electron .`). Sobald ein Packaging-Feature kommt, muss `docker-compose.yml` als Extra-Resource gepackt und der Compose-Pfad auf `process.resourcesPath` umgestellt werden — der Manager kapselt den Pfad an einer Stelle
- **Whisper/Piper in Docker:** kein aktueller Leidensdruck
- **Migration der vorhandenen Modelle** aus `C:\Users\Martin\.ollama`: bewusst Neu-Download ins Volume statt Mount (sauber, vermeidet Pfad-/Performance-Probleme über WSL2-Dateisystemgrenze)

## 11. Tests & Verifikation

**Automatisiert (Claude):**
- Unit-Tests `ollama-container-manager.test.ts`: Docker-CLI gemockt — Container läuft / gestoppt / fehlt / Docker nicht installiert / ENOENT-Unterscheidung (installiert vs. nicht im PATH); `/api/ps`-Auswertung mit `size_vram` 0 und > 0; **Retry-Fall: erst 0, nach Retry > 0 → kein CPU-Alarm**; 30s-Timeout
- `npm run typecheck` + bestehende Test-Suite

**Manuell (Martin):**
- `docker stop sarah-ollama` → Sarah starten → Container muss automatisch hochkommen, Boot normal
- Docker Desktop beenden → Sarah starten → saubere Fehlermeldung statt Hänger
- Voice-Roundtrip nach Container-Umstellung: Antwortzeiten wie Baseline (~5.4 s warm)
