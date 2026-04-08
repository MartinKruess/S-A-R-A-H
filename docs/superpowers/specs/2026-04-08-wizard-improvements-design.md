# Wizard Improvements: Programmier-Vertiefung, PDF-Kategorisierung, Responsive Layout

**Datum:** 2026-04-08
**Scope:** Setup-Wizard Erweiterungen — Dynamic-Step, Files-Step, globales Layout

---

## Übersicht

Drei zusammenhängende Verbesserungen am Setup-Wizard:

1. **Programmier-Vertiefung** — Techstack und bevorzugte Anlaufstellen im Dynamic-Step
2. **PDF-Kategorisierung** — Tag-basierte dynamische Ordner-/Pattern-Konfiguration im Files-Step
3. **Responsive Desktop-Layout** — 80% Breite, 2-spaltig ab 600px, global für Steps und Dialoge

---

## 1. Datenmodell-Erweiterungen

### WizardData.skills

```ts
skills: {
  programming: string | null;       // Level (bestehend)
  programmingStack: string[];        // NEU: Sprachen/Frameworks
  programmingResources: string[];    // NEU: Bevorzugte Anlaufstellen
  programmingProjectsFolder: string; // NEU: Pfad zum Projekte-Ordner
  design: string | null;            // bestehend
  office: string | null;            // bestehend
}
```

Defaults: `programmingStack: []`, `programmingResources: ['Stack Overflow', 'GitHub', 'MDN']`, `programmingProjectsFolder: ''`

### WizardData.resources

`pdfFolder: string` wird ersetzt durch `pdfCategories: PdfCategory[]`:

```ts
interface PdfCategory {
  tag: string;                    // "Kontoauszüge", "Bewerbung", etc.
  folder: string;                 // Pfad zum Ordner
  pattern: string;                // Optional: z.B. "Bankname_MM_YY"
  inferFromExisting: boolean;     // An bestehenden Dateien orientieren
}
```

Default: `pdfCategories: []`

Entfallende Felder:
- `resources.pdfFolder` → ersetzt durch `pdfCategories`
- `resources.importantFolders` → entfällt (zu allgemein — spezifische Picker für Bilder, PDFs, Projekte, Install, Games decken das ab)

### Config-Level

`context7: true` wird automatisch in der gespeicherten Config gesetzt, wenn "Programmieren" als Usage Purpose gewählt ist. Kein UI-Element — Context7 ist immer aktiv für Programmierer.

---

## 2. Dynamic-Step: Programmier-Vertiefung

**Datei:** `src/renderer/wizard/steps/step-dynamic.ts`

**Bestehend:** Zeigt ein Level-Select wenn `usagePurposes.includes('Programmieren')`.

**Erweiterung:** Zwei zusätzliche Tag-Selects unterhalb des Level-Selects, die zusammen mit dem Level erscheinen/verschwinden.

### Tag-Select "Dein Techstack"

- **Vordefinierte Tags:** JavaScript, TypeScript, Python, C#, Java, Rust, Go, PHP, C++, Swift, Kotlin, Ruby, HTML/CSS, SQL, React, Angular, Vue, Node.js, .NET, Django, Spring
- `allowCustom: true`
- Schreibt in `skills.programmingStack`

### Tag-Select "Wo suchst du nach Lösungen?"

- **Vorausgefüllt (default selected):** Stack Overflow, GitHub, MDN
- **Weitere Optionen (nicht vorausgefüllt):** Reddit, Dev.to, W3Schools, Medium
- `allowCustom: true` — für spezielle Library-Docs
- Schreibt in `skills.programmingResources`

Offizielle Library-Dokumentation wird automatisch über Context7 bereitgestellt und braucht keinen manuellen Eintrag.

### Path-Picker "Wo liegen deine Projekte?"

- `sarahPathPicker` — z.B. `D:/projects` oder `~/dev`
- Schreibt in `skills.programmingProjectsFolder`
- Erscheint zusammen mit den Tag-Selects, nur bei "Programmieren"

---

## 3. Files-Step: PDF-Kategorisierung

**Datei:** `src/renderer/wizard/steps/step-files.ts`

Der bisherige einzelne PDF-Ordner-Picker wird ersetzt durch ein Tag-basiertes System mit dynamisch generierten Konfigurationsblöcken.

### Tag-Select "Welche Arten von PDFs hast du?"

Vordefinierte Kategorien:
- Gewerblich, Steuern, Präsentationen, Bewerbung, Zertifikate, Verträge, Kontoauszüge

`allowCustom: true` — User kann eigene Kategorien ergänzen.

### Dynamisch generierte Blöcke

Jeder ausgewählte Tag erzeugt einen Konfigurationsblock:

```
┌─ Kontoauszüge ──────────────────────────┐
│  📂 Ordner:  [D:/Dokumente/Bank]  [...]  │
│  📝 Pattern: [Bankname_MM_YY        ]    │
│  ☑ An bestehenden Dateien orientieren    │
└──────────────────────────────────────────┘
```

Bestandteile pro Block:
- **Ordner-Picker** (`sarahPathPicker`) — wohin PDFs dieser Kategorie gehören
- **Pattern-Feld** (`sarahInput`, optional) — Benennungsschema als Freitext
- **Checkbox** (`sarahToggle` oder native checkbox) — "An bestehenden Dateien orientieren", default `true`

**Dynamik:**
- Tag hinzufügen → Block erscheint (mit Slide-Animation, konsistent mit bestehendem `sarah-slide`)
- Tag entfernen → Block verschwindet, zugehöriger Eintrag wird aus `pdfCategories` entfernt

### Kontextabhängige Placeholder pro Kategorie

| Kategorie | Pattern-Placeholder |
|---|---|
| Kontoauszüge | `Bankname_MM_YY` |
| Bewerbung | `Firmenname_Stelle` |
| Steuern | `Jahr_Steuerart` |
| Verträge | `Anbieter_Vertragsart` |
| Zertifikate | `Aussteller_Thema_Jahr` |
| Gewerblich | `Firma_Dokumenttyp` |
| Präsentationen | `Thema_Datum` |
| Custom (eigene Tags) | `Beschreibung_Datum` |

### Verbleibende Ordner-Picker im Files-Step

Diese bleiben unverändert:
- Wo liegen deine Bilder?
- Wo installierst du Programme?
- Weitere Programme (Ordner scannen)
- Games-Ordner (nur bei Gaming)

Entfernt:
- "Wichtige Ordner" — zu allgemein, wird durch spezifische Picker abgedeckt

Das Programm-Tag-Select (async detectPrograms) bleibt unverändert.

---

## 4. Responsive Desktop-Layout

**Scope:** Global — alle Wizard-Steps und Dialoge.

### Content-Breite

```css
/* Mobile-first (< 600px): volle Breite */
.sarah-form {
  width: 100%;
  padding: 0 var(--sarah-space-md);
}

/* Desktop (≥ 600px): 80% zentriert */
@media (min-width: 600px) {
  .sarah-form {
    max-width: 80%;
    margin: 0 auto;
  }
}
```

Gilt für `sarah-form` (damit automatisch alle Steps und Dialoge betroffen).

### 2-Spalten-Grid für Ordner-Picker

Im Files-Step werden Ordner-Picker auf Desktop nebeneinander dargestellt:

```css
.folder-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--sarah-space-md);
}

@media (min-width: 600px) {
  .folder-grid {
    grid-template-columns: 1fr 1fr;
  }
}
```

**Was geht in den Grid:**
- Bilder-Ordner, Install-Ordner, Extra-Programme-Ordner, Games-Ordner

**Was volle Breite bleibt:**
- Tag-Selects (brauchen den Platz)
- PDF-Kategorie-Blöcke (haben 3 Sub-Elemente)
- Programm-Tag-Select

---

## Betroffene Dateien

**Modifiziert:**
- `src/renderer/wizard/wizard.ts` — WizardData-Interface, Defaults, finishWizard Config-Mapping
- `src/renderer/wizard/steps/step-dynamic.ts` — Techstack + Resources Tag-Selects
- `src/renderer/wizard/steps/step-files.ts` — PDF-Kategorisierung, Ordner-Grid
- `src/renderer/wizard/steps/step-finish.ts` — Zusammenfassung anpassen (pdfCategories statt pdfFolder)
- `src/renderer/components/sarah-form.ts` — 80% max-width responsive

**Keine neuen Dateien nötig** — alles Erweiterungen bestehender Dateien.
