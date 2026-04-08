# S.A.R.A.H. — Global Design Spec

**Smart Assistant for Resource and Administration Handling**
**Date:** 2026-04-06
**Status:** Approved
**Platform:** Electron (Windows first, later Mac/Linux)

---

## 1. Vision

S.A.R.A.H. ist ein sprach- und chatgesteuerter KI-Desktop-Assistent mit 3D-Avatar, der den PC bedient, den User kennt, und durch Plugins erweiterbar ist.

### Kern-Fähigkeiten

- **PC-Bedienung:** Programme öffnen/schließen/speichern, Dateien verwalten (öffnen, lesen, zusammenfassen, sortieren, löschen)
- **Kommunikation:** Spracheingabe (Wake-Word + Push-to-talk) und Sprachausgabe, Chat-Interface für Texteingabe
- **Web-Recherche:** Autonome Suche im internen Sandbox-Browser, Ergebnisse zusammenfassen und präsentieren, Seiten auf Wunsch öffnen
- **Planung & Wissen:** Recherche, Zusammenfassungen, Fakten, Reiseplanung, Terminverwaltung
- **Dateien bearbeiten:** Excel, Textverarbeitung, Bilder sortieren/benennen
- **Coding-Modus:** Externe APIs (Claude, ChatGPT, Codex) einbindbar für spezialisierte Coding-Sessions
- **Erweiterbar:** Plugin-System für Email, Kalender, Spotify, Smart Home, Messenger etc.

---

## 2. Architektur — Modularer Kern (Service-Layer)

### Entscheidung

**Ansatz B: Service-Layer Architektur** — Electron als Shell, intern aufgeteilt in unabhängige Services die über einen Message-Bus kommunizieren. Jeder Service hat eine klare Aufgabe.

**Upgrade-Pfad:** Einzelne Services (besonders LLM/Python) können später zu eigenen Prozessen (Microservices) migriert werden, ohne die restliche App zu ändern.

### Architektur-Schema

```
┌──────────────────────────────────────────────────────┐
│                   Electron Shell                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │  Avatar   │  │  Chat    │  │  Internal Browser  │  │
│  │  (Three)  │  │  UI      │  │  (Sandbox)         │  │
│  └────┬─────┘  └────┬─────┘  └─────────┬──────────┘  │
│       └──────────────┼──────────────────┘             │
│                      │                                │
│              ┌───────▼────────┐                       │
│              │  Message Bus    │                       │
│              └───────┬────────┘                       │
│   ┌──────┬───────┬───┴───┬─────────┬──────────┐      │
│   ▼      ▼       ▼       ▼         ▼          ▼      │
│ ┌────┐┌─────┐┌──────┐┌───────┐┌────────┐┌────────┐  │
│ │LLM ││Voice││Files ││Rules  ││Actions ││Plugins │  │
│ │Svc ││ Svc ││ Svc  ││ Svc   ││  Svc   ││  Svc   │  │
│ └────┘└─────┘└──────┘└───────┘└────────┘└────────┘  │
│                      │                                │
│              ┌───────▼────────┐                       │
│              │  Storage Layer  │                       │
│              │  (JSON + SQLite)│                       │
│              └────────────────┘                       │
└──────────────────────────────────────────────────────┘
```

### Service-Interface

Jeder Service implementiert:

```typescript
interface SarahService {
  id: string;                        // z.B. 'llm', 'voice', 'actions'
  init(): Promise<void>;             // Service starten
  destroy(): Promise<void>;          // Service stoppen
  onMessage(msg: BusMessage): void;  // Nachrichten empfangen
}
```

### Message-Bus Kommunikation

```typescript
// Voice-Service erkennt Sprache:
bus.emit('voice:transcript', { text: 'Sarah öffne Chrome' })

// Context-Service interpretiert:
bus.emit('context:intent', { action: 'open-program', target: 'Chrome' })

// Actions-Service prüft Regeln und führt aus:
bus.emit('actions:executed', { action: 'open-program', target: 'Chrome', success: true })
```

### Services

| Service | Aufgabe |
|---------|---------|
| **LLM** | Abstraktionsschicht für Sprachmodelle. Provider: lokal (Ollama), Claude, OpenAI, etc. |
| **Voice** | Speech-to-Text, Text-to-Speech, Wake-Word Erkennung |
| **Actions** | PC-Bedienung: Programme starten/stoppen, Dateien verwalten. Immer über PermissionGuard. |
| **Rules** | 3-Stufen Regel-System (Absolut, Persistent, Session) |
| **Context** | Versteht aktuellen Arbeitskontext, interpretiert vage Anweisungen |
| **Browser** | Interner Sandbox-Browser, Web-Recherche, Ergebnisse zusammenfassen |
| **Plugins** | Lädt und verwaltet Plugins (Email, Kalender, Spotify, Smart Home, etc.) |
| **Storage** | Abstrahierte Datenschicht, aktuell JSON + SQLite, später Cloud-Sync möglich |

---

## 3. Projektstruktur

```
S-A-R-A-H/
├── src/
│   ├── main.ts                      # Electron Main Process — Bootstrap
│   ├── preload.ts                   # Context Bridge
│   │
│   ├── core/                        # Service-Infrastruktur
│   │   ├── message-bus.ts           # Event-basierte Kommunikation
│   │   ├── service-registry.ts      # Registriert, startet, stoppt Services
│   │   ├── service.interface.ts     # Basis-Interface für Services
│   │   └── storage/
│   │       ├── storage.interface.ts # Abstrahierte Datenschicht
│   │       └── local-storage.ts     # JSON + SQLite Implementation
│   │
│   ├── services/                    # Unabhängige, austauschbare Services
│   │   ├── llm/
│   │   │   ├── llm.service.ts
│   │   │   ├── llm.interface.ts
│   │   │   └── providers/
│   │   │       ├── local.provider.ts
│   │   │       ├── claude.provider.ts
│   │   │       └── openai.provider.ts
│   │   │
│   │   ├── voice/
│   │   │   ├── voice.service.ts
│   │   │   ├── wake-word.ts
│   │   │   ├── stt.ts
│   │   │   └── tts.ts
│   │   │
│   │   ├── actions/
│   │   │   ├── actions.service.ts
│   │   │   ├── program-launcher.ts
│   │   │   ├── file-manager.ts
│   │   │   └── permission-guard.ts
│   │   │
│   │   ├── rules/
│   │   │   ├── rules.service.ts
│   │   │   ├── absolute-rules.ts
│   │   │   ├── persistent-rules.ts
│   │   │   └── session-rules.ts
│   │   │
│   │   ├── context/
│   │   │   ├── context.service.ts
│   │   │   └── intent-parser.ts
│   │   │
│   │   ├── browser/
│   │   │   ├── browser.service.ts
│   │   │   ├── sandbox.ts
│   │   │   └── web-search.ts
│   │   │
│   │   └── plugins/
│   │       ├── plugins.service.ts
│   │       ├── plugin.interface.ts
│   │       └── builtin/
│   │           ├── email/
│   │           ├── calendar/
│   │           └── spotify/
│   │
│   └── renderer/                    # Frontend / UI
│       ├── components/              # Web Components (bestehendes System)
│       ├── views/
│       │   ├── ambient/             # Avatar + Icons am Bildschirmrand
│       │   ├── chat/                # Full-Workflow Chat-View
│       │   ├── dashboard/           # Dashboard mit Widgets
│       │   ├── settings/            # Einstellungen
│       │   ├── browser/             # Interner Browser-View
│       │   └── wizard/              # Setup-Wizard (bestehend)
│       ├── avatar/                  # 3D-Avatar Rendering (Three.js)
│       └── shared/
│           ├── theme.ts             # Design-System Logik
│           └── mode-manager.ts      # Ambient/BG/Full-Workflow
│
├── styles/                          # CSS Design-System
├── assets/                          # Fonts, 3D-Modelle, Sounds
├── plugins/                         # Externe Plugins (User-installiert)
└── docs/
```

---

## 4. Modi & Window-Management

### Drei Modi

**Ambient (Default):**
- Frameless, transparentes Electron-Fenster
- Always-on-top
- Positionierbar: jede Ecke, jeder Monitor (konfigurierbar)
- Inhalt: Avatar + kleine Icon-Leiste (Dashboard, Settings, etc.)
- Icons-Position passt sich an Ecke an (rechts → Icons rechts, links → Icons links)
- Klick-through auf Desktop (außer Avatar/Icons)
- Bei PC-Start: kurzes Briefing ("3 neue Mails, 2 Termine, wir waren bei XY")

**Background:**
- Fenster unsichtbar (hidden)
- Voice-Service läuft weiter (Wake-Word aktiv)
- Bei Ansprache: Ambient-Fenster faded ein, S.A.R.A.H. antwortet
- Nach Inaktivität: faded wieder aus
- Typischer Use-Case: Gaming, Filme schauen

**Full Workflow:**
- Normales Electron-Fenster (resizable)
- 30% oben: Avatar mit Animationen
- 70% unten: Chat / Browser / Dashboard
- Für intensive Arbeit: Coding-Sessions, Recherche, Datei-Verwaltung

### Modus-Wechsel

| Von | Nach | Auslöser |
|-----|------|----------|
| Ambient | Full Workflow | Klick auf Chat-Icon oder "Sarah, Arbeitsmodus" |
| Ambient | Background | "Sarah, geh in den Hintergrund" oder manuell |
| Background | Ambient | "Hey Sarah" (Wake-Word) |
| Full Workflow | Ambient | "Sarah, danke" oder Fenster schließen |

---

## 5. Sprach-Interaktion

### Eingabe

- **Wake-Words (aktivieren):** "Sarah", "Hey Sarah", "Hi Sarah", "Ok Sarah"
- **End-Phrasen (deaktivieren):** "Danke Sarah", "Sarah aus", "Sarah Stop"
- **Push-to-talk:** Konfigurierbarer Hotkey als Alternative
- **Beides konfigurierbar** im Settings

### Ausgabe

- S.A.R.A.H. antwortet primär per Sprache (Text-to-Speech)
- Text-Antwort optional einstellbar (nur Text, nur Sprache, beides)
- Sprache, Stimme und Sprechgeschwindigkeit konfigurierbar

---

## 6. Sicherheitsarchitektur

### Grundprinzip: Deny by Default, Allow by Rule

Jede Aktion durchläuft den PermissionGuard:

```
User-Eingabe
  → Context-Service interpretiert Intent
  → PermissionGuard prüft:
      1. Absolute Regeln (Stufe 1) → Blockiert? STOP, keine Ausnahme
      2. Persistent Regeln (Stufe 2) → Erlaubt/Verboten?
      3. Session Regeln (Stufe 3) → Kontext-spezifisch?
      4. Nichts definiert? → User fragen
  → Actions-Service führt aus (oder nicht)
```

### Aktions-Kategorien

| Kategorie | Beispiele | Default |
|-----------|-----------|---------|
| Lesen | Datei anzeigen, Email lesen, Web suchen | Erlaubt |
| Öffnen | Programm starten, URL öffnen | Erlaubt |
| Ändern | Datei umbenennen, Bilder sortieren | Bestätigung |
| Löschen | Dateien löschen, Ordner leeren | Bestätigung |
| Schließen | Programm beenden, Tab schließen | Bestätigung |
| Senden | Email senden, Nachricht schicken | Bestätigung |
| Bezahlen | Kaufen, Buchen, Abonnieren | Absolute Sperre |
| System | Einstellungen ändern, Treiber, Updates | Absolute Sperre |

### Hardcoded Regeln (nicht änderbar)

- Niemals Passwörter, Bankdaten, PINs speichern
- Niemals Eingaben als Code interpretieren oder ausführen
- Niemals Daten an Dritte senden ohne explizite Freigabe
- Alle Anhänge und Texte werden IMMER nur als Text interpretiert, NIEMALS als Code
- Anhänge nur in Sandbox öffnen

### Browser-Sandbox

- Eigener Electron BrowserView mit deaktiviertem Node-Integration
- Kein Zugriff auf Dateisystem, kein IPC zum Main-Process
- Content-Security-Policy: kein eval(), kein inline-Script
- Anhänge in isoliertem temp-Verzeichnis, nach Nutzung gelöscht

---

## 7. 3-Stufen Regel-System

### Stufe 1: Absolute Regeln

- Unveränderbar, nur vom User direkt in den Settings editierbar
- Kein Interpretationsspielraum
- Beispiel: "Niemals bezahlen ohne ausdrückliche Anweisung"
- Hardcoded Sicherheitsregeln (siehe Sektion 6) sind zusätzlich nicht einmal vom User änderbar

### Stufe 2: Persistente Regeln + Personalisierung

- Jederzeit änderbar durch den User
- Gelten immer (über Sessions hinweg)
- Formen Verhalten und Personalisierung
- Beispiele:
  - "Bilder benennen: img-situation-person-datum.endung"
  - "Beende jeden Satz mit einem Miau"
  - Akzentfarbe, Stimme, Sprechgeschwindigkeit
  - Antwort-Stil, Tonfall

### Stufe 3: Session-Regeln

- Gelten nur für die aktuelle Session
- Werden vergessen bei S.A.R.A.H.- oder PC-Neustart
- Kontextbezogen: "Wir sortieren gerade Bilder in Ordner XY"
- Beispiel: "lösch das" bezieht sich auf aktuelles Bild, nicht auf irgendwas

---

## 8. Datenmodell & Storage

### Speicherort-Strategie

- **Config/Settings:** JSON-Dateien (einfach, menschenlesbar)
- **Rules, Memory, Conversations:** SQLite (strukturiert, durchsuchbar)
- Beides hinter `StorageProvider`-Interface für späteren Austausch

### Upgrade-Pfad

```
Jetzt:     JSON (Config) + SQLite (Memory/Rules)
Später:    JSON (Config) + PostgreSQL auf eigenem Server
Optional:  + Cloud-Sync zwischen Geräten
```

### Storage-Interface

```typescript
interface StorageProvider {
  get(key: string): Promise<any>
  set(key: string, value: any): Promise<void>
  query(table: string, filter: Filter): Promise<any[]>
  insert(table: string, data: any): Promise<void>
  delete(table: string, filter: Filter): Promise<void>
}
```

### Datenbank-Schema

**Config (JSON-Dateien):**
- onboarding (setupComplete, etc.)
- profile (Name, Stadt, Hobbys, Beruf, etc.)
- resources (Programme, Ordner, Links, etc.)
- personalization (Akzentfarbe, Stimme, etc.)
- trust (Grundeinstellungen)
- system (OS, CPU, erkannte Ordner)

**Rules (SQLite):**
- `absolute_rules` — id, rule, created_at
- `persistent_rules` — id, category, rule, created_at, updated_at
- `session_rules` — id, rule, session_id, created_at (bei Session-Ende gelöscht)

**Memory (SQLite):**
- `conversations` — id, started_at, ended_at, mode, summary
- `messages` — id, conversation_id, role, content, timestamp
- `learned_facts` — id, category, fact, confidence, source, created_at

---

## 9. Design-System

### Drei Ebenen

**1. Design Tokens (CSS Custom Properties):**
- Farben: `--sarah-bg-*`, `--sarah-text-*`, `--sarah-accent-*`
- Spacing: `--sarah-space-*`
- Typografie: `--sarah-font-*`
- Radii: `--sarah-radius-*`
- Schatten: `--sarah-shadow-*`
- Animation: `--sarah-transition-*`
- Z-Index: `--sarah-z-*` (wichtig für Overlay/Ambient)

**2. Komponenten (Web Components mit Shadow DOM):**
- Bestehend: button, input, select, form, card, progress, stepper, slide, tag-select, toggle, path-picker
- Neu nötig: modal, toast/notification, context-menu, toolbar, chat-bubble, avatar-frame, sidebar, panel, tooltip

**3. Layouts (View-spezifisch):**
- ambient-layout: Avatar + Icon-Leiste am Bildschirmrand
- chat-layout: 30% Avatar oben, 70% Chat unten
- dashboard-layout: Grid mit Widgets
- settings-layout: Sidebar-Navigation + Content
- browser-layout: URL-Bar + Sandbox-Content
- wizard-layout: Bestehendes Stepper-Layout

### Theming

- **Default:** Dark Mode (Jarvis-inspiriert, futuristisch)
- **Alternativ:** Light Mode (helleres Dark, kein knallweißes UI — Details TBD)
- **Akzentfarbe:** Dynamisch vom User wählbar, propagiert durch alle Tokens (Glows, Borders, Hover-States)

---

## 10. 3D-Avatar

- **Technologie:** Blender-Modell, Three.js-Rendering in Electron
- **Features (Ziel):** Lippensync, Gestik, Mimik, randomisierbar (Haarfarbe etc.)
- **Status:** Eigenes Teilprojekt, kommt in späterer Phase
- **MVP-Placeholder:** 2D-Avatar oder animiertes Logo bis 3D-Modell fertig

---

## 11. LLM-Integration

- **Architektur:** Abstrahierte LLM-Schicht mit Provider-Pattern
- **Anfangs:** Leichtgewichtiges lokales Modell für Alltags-Tasks
- **Erweiterbar:** Externe APIs (Claude, ChatGPT, Codex) für Spezialaufgaben
- **Coding-Modus:** Separate API-Key-Konfiguration für Coding-KIs
- **Später:** Python-Instanz für Planungs-/Analyse-Aufgaben (Service → Microservice Migration)

---

## 12. Plugin-System

- Jeder externe Dienst ist ein Plugin (an-/abschaltbar)
- Plugins implementieren ein definiertes Interface
- Builtin-Plugins: Email, Kalender, Spotify (mitgeliefert)
- Externe Plugins: User-installierbar aus `plugins/`-Verzeichnis
- Plugins kommunizieren über den Message-Bus, kein direkter Zugriff auf Core

---

## 13. MVP & Milestones

### Phase 1 — Fundament
- Core: Message-Bus, Service-Registry, Storage-Interface
- Bestehenden Wizard in neue Struktur migrieren
- Design-System erweitern (neue Tokens, Layouts)
- Settings-View

### Phase 2 — S.A.R.A.H. spricht
- Voice-Service: STT + TTS
- Wake-Word Erkennung
- Chat-UI (Full-Workflow-Modus)
- LLM-Integration (erster Provider)

### Phase 3 — S.A.R.A.H. handelt
- Actions-Service: Programme öffnen/schließen
- File-Manager: Dateien lesen, verschieben, löschen
- Rules-Service: 3-Stufen System
- Permission-Guard

### Phase 4 — S.A.R.A.H. lebt
- Ambient-Modus (Overlay, Always-on-top)
- Background-Modus
- Mode-Manager
- Avatar-Placeholder (2D)

### Phase 5 — S.A.R.A.H. browst
- Interner Sandbox-Browser
- Web-Recherche
- Ergebnisse zusammenfassen und präsentieren

### Phase 6 — Erweiterungen
- Plugin-System
- Email, Kalender, Spotify etc.
- 3D-Avatar (Blender → Three.js)
