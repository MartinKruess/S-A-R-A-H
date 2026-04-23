# Spec-Review: cockpit-themes-design — Fehler & Lücken

Geprüft: `docs/superpowers/specs/2026-04-23-cockpit-themes-design.md`  
Prüfer: Codi (Sicherheitsinspektor)  
Stand: 2026-04-23

---

## BUG 1 — `sarah-panel.ts` box-shadows sind hardcodiert (fehlender Scope)

**Schwere: MITTEL — visuelles Artefakt**

Der Spec tauscht die Panel-Gradient-Backgrounds via CSS-Variablen aus, ignoriert aber die 4 `box-shadow`-Regeln in `sarah-panel.ts`, die hardcodierte RGBA-Werte enthalten:

```
.panel-wrapper              → box-shadow: 0 0 20px rgba(0, 229, 255, 0.15);   ← hardcoded cyan
:host([accent="violet"])    → box-shadow: 0 0 20px rgba(124, 58, 237, 0.15);  ← hardcoded violet
:host([accent="pink"])      → box-shadow: 0 0 20px rgba(255, 47, 209, 0.15);  ← hardcoded pink
:host([accent="mint"])      → box-shadow: 0 0 20px rgba(34, 255, 192, 0.15);  ← hardcoded mint
```

Außerdem die `:hover`-Varianten (Zeilen 44, 53, 62, 72).

**Ergebnis:** Nach einem Theme-Wechsel auf z.B. "orange" leuchten die Panel-Borders weiterhin cyan/violet/pink. Der Gradient (Rahmenfarbe) wechselt, der Glow bleibt falsch.

**Fix-Richtung:** Ebenfalls CSS-Variablen einführen — z.B. `--sarah-panel-glow-cyan/violet/pink/mint` — analog zu den Gradient-Variablen. Oder `color-mix()` basierend auf den Cockpit-Accent-Variablen verwenden, da `--cockpit-accent-*` bereits themenabhängig sein werden.

---

## BUG 2 — Implementierung beschreibt nur `dialog.ts`-Fix, nicht `dashboard.ts`

**Schwere: MITTEL — `data-theme` fehlt beim Start im Cockpit-Fenster**

Der Spec beschreibt den Default-Cyan-Fix im **Implementierungs-Abschnitt** nur für `dialog.ts`. Im **Risks-Abschnitt** steht korrekt "Fix in `dialog.ts` und `dashboard.ts`" — aber das ist ein Kommentar, kein umsetzbarer Schritt.

**Tatsächliche Stellen im Code** mit dem Skip-Guard (`color !== '#00d4ff'`):
- `src/renderer/dashboard/dialog.ts` Zeile 19 ✓ (genannt)
- `src/renderer/dashboard/dashboard.ts` Zeile 19 ✗ (nicht in Implementierung genannt)

**Ergebnis:** Claude fixt nur `dialog.ts`. Das Cockpit-Hauptfenster (`dashboard.ts`) setzt kein `data-theme="cyan"` beim Start → Cyan-Default-Theme greift nicht via `data-theme`, sondern nur über `:root` Fallback-Werte.

**Fix-Richtung:** Im Implementation-Abschnitt explizit beide Dateien nennen.

---

## BUG 3 — `ThemeKey` verwendet deutschsprachige Identifier (CLAUDE.md-Verstoß)

**Schwere: NIEDRIG aber klar — verletzt Projekt-Coding-Standards**

Der Spec definiert:
```ts
type ThemeKey = 'cyan' | 'blau' | 'violett' | 'orange' | 'gruen' | 'pink' | 'gold' | 'rot';
```

CLAUDE.md schreibt vor: **"Language: code and commits in English"**.

Betroffen sind TypeScript-Typ-Literale UND CSS-Attribut-Selektoren:
```css
:root[data-theme="blau"] { ... }  /* → sollte "blue" sein */
:root[data-theme="gruen"] { ... } /* → sollte "green" sein */
```

Die Mischung (cyan/orange/pink/gold = englisch; blau/violett/gruen/rot = deutsch) ist inkonsistent.

**Fix-Richtung:** Alle Theme-Keys auf Englisch: `blue`, `violet`, `green`, `red`. Das `ACCENT_TO_THEME`-Mapping und alle CSS-Blöcke entsprechend anpassen. Die UI-Labels (Swatch-Titel) bleiben deutsch — das ist korrekt.

---

## LÜCKE 4 — Default-Werte der `--sarah-panel-accent-gradient-*` Variables nicht spezifiziert

**Schwere: NIEDRIG — Claude muss sie selbst ableiten**

Der Spec sagt: *"Default-Werte der neuen Gradient-Variables landen in `theme.css` (Cyan-Theme)"* — aber gibt die konkreten Werte nicht an.

Claude muss sie aus den hartkodierten Fallbacks in `sarah-panel.ts` Zeilen 37/50/59/67 ableiten:

| Variable | Abzuleitender Wert |
|---|---|
| `--sarah-panel-accent-gradient-cyan` | `linear-gradient(135deg, var(--cockpit-accent-cyan), var(--cockpit-accent-violet))` |
| `--sarah-panel-accent-gradient-violet` | `linear-gradient(135deg, var(--cockpit-accent-violet), var(--cockpit-accent-pink))` |
| `--sarah-panel-accent-gradient-pink` | `linear-gradient(135deg, var(--cockpit-accent-pink), var(--cockpit-accent-cyan))` |
| `--sarah-panel-accent-gradient-mint` | `linear-gradient(135deg, var(--cockpit-accent-mint), var(--cockpit-accent-cyan))` |

Das ist ableitbar, aber eine Fehlerquelle. **Empfehlung:** Diese 4 Default-Values explizit in den Spec aufnehmen.

---

## LÜCKE 5 — Rollout-Name "Amber" vs "orange" inkonsistent

**Schwere: KOSMETISCH — keine Funktionsfehler, aber verwirrend**

Im selben Satz:
> *"Iteration 1 (dieser Task): 2 Themes — Cyan-default + **Amber** (= orange-Theme)"*

Und in der Preset-Tabelle: `Orange | #ff8844 | orange`.

"Amber" ist nicht der Preset-Name — das ist der Orange-Preset. Kein Fehler in der Implementierung, aber könnte zu Rückfragen führen.

---

## ZUSAMMENFASSUNG

| Nr | Schwere | Problem | Fix nötig vor Impl? |
|---|---|---|---|
| 1 | MITTEL | box-shadows hardcodiert — Glow folgt Theme nicht | JA |
| 2 | MITTEL | `dashboard.ts` fehlt im Fix-Schritt | JA |
| 3 | NIEDRIG | Deutsche ThemeKeys — CLAUDE.md-Verstoß | JA |
| 4 | NIEDRIG | Default-Gradient-Values nicht spezifiziert | EMPFOHLEN |
| 5 | KOSMETISCH | "Amber" vs "orange" | NEIN |

**Fazit:** Spec ist in Grundstruktur solide und machbar. Bugs 1–3 müssen vor der Implementierung in den Spec einfließen, sonst entstehen visuell inkorrekte Theme-Glows, ein fehlendes `data-theme` beim Cockpit-Start, und CLAUDE.md-Konflikte beim Code-Review.
